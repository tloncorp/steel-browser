import { createServer } from "node:http";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CDPService } from "./cdp/cdp.service.js";
import {
  discoverCredentialForm,
  fillCredentialForm,
  getCredentialContinuation,
} from "./credential-form.service.js";

const executablePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
if (!existsSync(executablePath) && process.env.CI)
  throw new Error("Credential form tests require CHROME_PATH");

describe.skipIf(!existsSync(executablePath))("secure credential entry in Chrome", () => {
  let browser: Browser;
  let page: Page;
  let service: CDPService;
  let origin: string;
  let html = "";
  const requests: string[] = [];
  const site = createServer((req, res) => {
    requests.push(req.url || "");
    res.setHeader("Content-Type", "text/html");
    res.end(req.url?.startsWith("/done") ? "<h1>Account home</h1>" : html);
  });
  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("No fixture listener");
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    requests.length = 0;
    page = await browser.newPage();
    service = { getAllPages: async () => [page] } as unknown as CDPService;
  });
  afterEach(async () => {
    await page.close();
    await getCredentialContinuation(service);
  });
  afterAll(async () => {
    await browser?.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });
  async function load(body: string) {
    html = body;
    await page.goto(`${origin}/login`);
  }
  const fields =
    '<label>Username<input name="username"></label><label>Password<input name="password" type="password"></label>';
  async function fill(submit = true) {
    const target = await discoverCredentialForm(service);
    return fillCredentialForm(service, target, {
      values: Object.fromEntries(
        target.fields.map((field) => [
          field.id,
          field.purpose === "username" ? "test-user" : "private-password",
        ]),
      ),
      submit,
    });
  }

  it("activates click-only handlers with trusted browser input", async () => {
    await load(`<form onsubmit="event.preventDefault()">${fields}<button type="button"
      onclick="document.body.dataset.trusted = event.isTrusted; location.href='/done'">Sign in</button></form>`);
    const result = await fill();
    expect(result).toMatchObject({ submitted: true });
    await page.waitForFunction(() => location.pathname === "/done");
    expect(await getCredentialContinuation(service)).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private-password");
  });

  it("uses the actual submitter and its validation override", async () => {
    await load(`<form action="/wrong"><input type="email" name="username"><input type="password" required>
      <button name="intent" value="login" formaction="/done" formnovalidate>Log in</button></form>`);
    expect((await fill()).submitted).toBe(true);
    await page.waitForFunction(() => location.pathname === "/done");
    expect(requests.some((url) => url.startsWith("/done?") && url.includes("intent=login"))).toBe(
      true,
    );
    expect(requests.some((url) => url.startsWith("/wrong"))).toBe(false);
  });

  it("waits for a button enabled by field events and clicks only once", async () => {
    await load(`<form onsubmit="event.preventDefault()">${fields}<button disabled>Continue</button></form>
      <script>let clicks=0;document.querySelector('[type=password]').addEventListener('input',()=>
      setTimeout(()=>document.querySelector('button').disabled=false,150));
      document.querySelector('button').onclick=e=>{clicks++;document.body.dataset.clicks=clicks;document.body.dataset.trusted=e.isTrusted}</script>`);
    expect((await fill()).submitted).toBe(true);
    expect(await page.evaluate(() => ({ ...document.body.dataset }))).toMatchObject({
      clicks: "1",
      trusted: "true",
    });
    expect(await getCredentialContinuation(service)).toMatchObject({
      origin,
      submissionAttempted: true,
    });
  });

  it("leaves unsupported required fields for the live browser", async () => {
    await load(
      `<form action="/done">${fields}<input required name="extra"><button>Log in</button></form>`,
    );
    expect((await fill()).submitted).toBe(false);
    expect(page.url()).toBe(`${origin}/login`);
    expect(await getCredentialContinuation(service)).toMatchObject({
      kind: "details",
      submissionAttempted: false,
    });
    expect(requests.some((url) => url.startsWith("/done"))).toBe(false);
  });

  it("leaves ambiguous controls to MCP rather than clicking an unrelated submit button", async () => {
    await load(`<form><button onclick="document.body.dataset.wrong='yes'">Subscribe</button></form>
      <form onsubmit="event.preventDefault()">${fields}<button>Next</button><button>Sign in</button></form>`);
    expect((await fill()).submitted).toBe(false);
    expect(await page.evaluate(() => document.body.dataset.wrong)).toBeUndefined();
    expect(await getCredentialContinuation(service)).toMatchObject({ submissionAttempted: false });
  });

  it("does not click a covered control or cross-origin form action", async () => {
    await load(`<form action="https://other.test/login">${fields}<button>Sign in</button></form>`);
    expect((await fill()).submitted).toBe(false);
    expect(page.url()).toBe(`${origin}/login`);
    await load(`<form action="/done">${fields}<button>Sign in</button></form>
      <div style="position:fixed;inset:0;z-index:100" onclick="document.body.dataset.wrong='yes'"></div>`);
    expect((await fill()).submitted).toBe(false);
    expect(await page.evaluate(() => document.body.dataset.wrong)).toBeUndefined();
  });

  it("revokes continuation on clearing, replacing, and navigation", async () => {
    await load(`<form onsubmit="event.preventDefault()">${fields}<button>Log in</button></form>`);
    await fill();
    await page.$eval("[type=password]", (input) => {
      (input as HTMLInputElement).value = "";
    });
    expect(await getCredentialContinuation(service)).toBeNull();
    await fill();
    await page.$eval("[type=password]", (input) => input.replaceWith(input.cloneNode()));
    expect(await getCredentialContinuation(service)).toBeNull();
    await fill();
    await page.reload();
    expect(await getCredentialContinuation(service)).toBeNull();
  });

  it("fill-only does not authorize submission or publish any credential values", async () => {
    await load(`<form action="/done">${fields}<button>Sign in</button></form>`);
    expect(await fill(false)).toEqual({ submitted: false });
    expect(await getCredentialContinuation(service)).toBeNull();
    expect(page.url()).toBe(`${origin}/login`);
  });

  it("fills an OTP and leaves the next credential step to a new handoff", async () => {
    await load(`<form onsubmit="event.preventDefault()"><input autocomplete="one-time-code" maxlength="6">
      <button type="button" onclick="document.querySelector('input').value='';document.querySelector('input').type='password'">Verify</button></form>`);
    const target = await discoverCredentialForm(service);
    expect(target.fields[0].purpose).toBe("one-time-code");
    const result = await fillCredentialForm(service, target, {
      values: { [target.fields[0].id]: "123456" },
      submit: true,
    });
    expect(result.submitted).toBe(true);
    expect(await getCredentialContinuation(service)).toBeNull();
  });

  async function fillValues(values: Record<string, string>, submit = true) {
    const target = await discoverCredentialForm(service);
    return {
      target,
      result: await fillCredentialForm(service, target, {
        values: Object.fromEntries(
          target.fields
            .filter((field) => values[field.purpose] !== undefined)
            .map((field) => [field.id, values[field.purpose]]),
        ),
        submit,
      }),
    };
  }

  it("follows identifier, password, and split-code steps without replaying any value", async () => {
    await load(`<h1>Sign in</h1><form onsubmit="event.preventDefault()">
      <label>Email or mobile phone number<input type="text" name="email"></label><button>Continue</button></form>
      <script>let step=0; document.querySelector('form').onsubmit=e=>{e.preventDefault();step++;
        e.target.innerHTML=step===1 ? '<input type="password" autocomplete="current-password"><button>Sign in</button>' :
        step===2 ? '<p>Verification code</p>'+Array.from({length:6},()=>'<input maxlength="1" inputmode="numeric">').join('')+'<button>Verify</button>' : '<h2>Account home</h2>';
      }</script>`);
    const first = await discoverCredentialForm(service);
    expect(first.fields.map((field) => field.purpose)).toEqual(["username"]);
    expect((await discoverCredentialForm(service)).formId).toBe(first.formId);
    await fillCredentialForm(service, first, {
      values: { f0: "person@example.test" },
      submit: true,
    });
    const second = await discoverCredentialForm(service);
    expect(second.formId).not.toBe(first.formId);
    expect(second.fields.map((field) => field.purpose)).toEqual(["current-password"]);
    expect(await page.$eval("input", (input) => input.value)).toBe("");
    await expect(
      fillCredentialForm(service, first, { values: { f0: "do-not-replay" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await fillCredentialForm(service, second, { values: { f0: "private-password" }, submit: true });
    const third = await discoverCredentialForm(service);
    expect(third.fields).toMatchObject([{ purpose: "one-time-code", exactLength: 6 }]);
    await fillCredentialForm(service, third, { values: { f0: "aBc123" }, submit: true });
    expect(await page.$eval("h2", (el) => el.textContent)).toBe("Account home");
    await expect(discoverCredentialForm(service)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("recognizes login forms with account-creation and recovery links", async () => {
    await load(
      `<form onsubmit="event.preventDefault()">${fields}<a href="/register">Sign up</a><a href="/reset">Reset password</a><button>Sign in</button></form>`,
    );
    expect((await fill()).submitted).toBe(true);
  });

  it("revokes a receipt if any filled field changes identity or is cleared", async () => {
    await load(`<form onsubmit="event.preventDefault()">${fields}<button>Sign in</button></form>`);
    await fill();
    await page.$eval("[name=username]", (input) => ((input as HTMLInputElement).value = ""));
    expect(await getCredentialContinuation(service)).toBeNull();
    await fill();
    await page.$eval("[type=password]", (input) => input.setAttribute("type", "text"));
    expect(await getCredentialContinuation(service)).toBeNull();
  });

  it("fills a combined password and verification form as one bound field set", async () => {
    await load(
      `<form onsubmit="event.preventDefault()">${fields}<label>Verification code<input autocomplete="one-time-code" maxlength="6"></label><button>Sign in</button></form>`,
    );
    const { target, result } = await fillValues({
      username: "user",
      "current-password": "secret",
      "one-time-code": "aBc123",
    });
    expect(target.fields.map((field) => field.purpose)).toEqual([
      "username",
      "current-password",
      "one-time-code",
    ]);
    expect(result.submitted).toBe(true);
    expect(await page.$$eval("input", (inputs) => inputs.map((input) => input.value))).toEqual([
      "user",
      "secret",
      "aBc123",
    ]);
    expect(JSON.stringify(target)).not.toContain("secret");
  });

  it.each([
    '<form><label>Email<input type="email"></label><button>Subscribe</button></form>',
    '<form><label>Coupon code<input name="code"></label><button>Apply</button></form>',
    '<form><label>Search<input name="search"></label><button>Search</button></form>',
    '<form><input name="email"><button>Next</button></form>',
    '<form><input type="password"><button>Sign in</button></form><form><input type="password"><button>Sign in</button></form>',
  ])("does not guess a sensitive destination in unrelated or ambiguous forms", async (body) => {
    await load(body);
    // A generic /login route alone must not identify an unnamed field.
    if (body.includes('name="email"'))
      await page.evaluate(() => history.replaceState(null, "", "/form"));
    await expect(discoverCredentialForm(service)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects changed nodes and field semantics on the same URL before writing", async () => {
    for (const mutation of ["replace", "type", "form"] as const) {
      await load(
        `<form id="login">${fields}<button>Sign in</button></form><form id="other"></form>`,
      );
      const target = await discoverCredentialForm(service);
      await page.$eval(
        "[type=password]",
        (element, mutation) => {
          if (mutation === "replace") element.replaceWith(element.cloneNode());
          if (mutation === "type") element.setAttribute("type", "text");
          if (mutation === "form") element.setAttribute("form", "other");
        },
        mutation,
      );
      await expect(
        fillCredentialForm(service, target, { values: { f0: "user", f1: "secret" } }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await page.$$eval("input", (inputs) => inputs.map((input) => input.value))).toEqual([
        "",
        "",
      ]);
    }
  });

  it("stops when an input event replaces the next field", async () => {
    await load(`<form>${fields}<button>Sign in</button></form><script>
      document.querySelector('input').oninput=()=>{const p=document.querySelector('[type=password]');p.replaceWith(p.cloneNode())}
    </script>`);
    const target = await discoverCredentialForm(service);
    await expect(
      fillCredentialForm(service, target, { values: { f0: "user", f1: "secret" }, submit: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await page.$eval("[type=password]", (input) => (input as HTMLInputElement).value)).toBe(
      "",
    );
  });

  it("fills card and address controls, including choices, without submitting a transaction", async () => {
    await load(`<form onsubmit="event.preventDefault();document.body.dataset.paid='yes'">
      <label>Name<input autocomplete="billing name" required></label>
      <label>Card<input autocomplete="cc-number" required></label>
      <label>Security<input autocomplete="cc-csc" required></label>
      <label>Address<textarea autocomplete="billing street-address" required></textarea></label>
      <label>Country<select autocomplete="billing country"><option value="">Choose country</option><option value="US">United States</option><option value="CA">Canada</option></select></label>
      <button>Continue</button></form>`);
    const { target, result } = await fillValues({
      name: "Test Person",
      "cc-number": "4111111111111111",
      "cc-csc": "123",
      "street-address": "1 Test St\nUnit 2",
      country: "2",
    });
    expect(target.kind).toBe("details");
    expect(target.fields.at(-1)?.options).toEqual([
      { value: "1", label: "United States" },
      { value: "2", label: "Canada" },
    ]);
    expect(result.submitted).toBe(false);
    expect(await page.evaluate(() => document.body.dataset.paid)).toBeUndefined();
    expect(await page.$eval("select", (select) => select.value)).toBe("CA");
    expect(await page.$eval("textarea", (textarea) => textarea.value)).toBe("1 Test St\nUnit 2");
    expect(await getCredentialContinuation(service)).toMatchObject({
      kind: "details",
      submissionAttempted: false,
    });
  });

  it("invalidates a choice when its live options change", async () => {
    await load(
      '<form><select autocomplete="country"><option value="US">US</option></select><input autocomplete="address-line1"><button>Continue</button></form>',
    );
    const target = await discoverCredentialForm(service);
    await page.$eval("option", (option) => (option.value = "CA"));
    await expect(
      fillCredentialForm(service, target, { values: { f0: "0", f1: "1 Test St" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await page.$eval("input", (input) => (input as HTMLInputElement).value)).toBe("");
  });

  it("recognizes standard address and payment labels without autocomplete", async () => {
    await load(
      '<form><h1>Billing address</h1><label>Card number<input name="cardNumber"></label><label>CVV<input name="cvv"></label><label>Street address<input name="address1"></label><label>City<input name="city"></label><label>Postal code<input name="zip"></label><button>Pay</button></form>',
    );
    const target = await discoverCredentialForm(service);
    expect(target.kind).toBe("details");
    expect(target.fields.map((field) => field.purpose)).toEqual([
      "cc-number",
      "cc-csc",
      "address-line1",
      "address-level2",
      "postal-code",
    ]);
  });

  it("ignores hidden and inert controls and discovers open shadow-root fields", async () => {
    await load(`<input type="password" style="display:none"><div inert><input type="password"></div><div id="host"></div>
      <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<form><input type="password" autocomplete="current-password"><button>Sign in</button></form>'</script>`);
    const target = await discoverCredentialForm(service);
    expect(target.fields.map((field) => field.purpose)).toEqual(["current-password"]);
    await fillCredentialForm(service, target, { values: { f0: "secret" } });
    expect(
      await page.evaluate(
        () => document.querySelector("#host")!.shadowRoot!.querySelector("input")!.value,
      ),
    ).toBe("secret");
  });
});
