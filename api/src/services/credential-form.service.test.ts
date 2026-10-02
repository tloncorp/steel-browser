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
      username: "test-user",
      password: "private-password",
      submit,
    });
  }

  it("activates click-only handlers with trusted browser input", async () => {
    await load(`<form onsubmit="event.preventDefault()">${fields}<button type="button"
      onclick="document.body.dataset.trusted = event.isTrusted; location.href='/done'">Sign in</button></form>`);
    const result = await fill();
    expect(result).toMatchObject({ filledUsername: true, submitted: true });
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

  it("does not report authentication when native validation blocks a clicked form", async () => {
    await load(
      `<form action="/done">${fields}<input required name="extra"><button>Log in</button></form>`,
    );
    expect((await fill()).submitted).toBe(true);
    expect(page.url()).toBe(`${origin}/login`);
    expect(await getCredentialContinuation(service)).toMatchObject({
      kind: "password",
      submissionAttempted: true,
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
    expect(await fill(false)).toEqual({ filledUsername: true, submitted: false });
    expect(await getCredentialContinuation(service)).toBeNull();
    expect(page.url()).toBe(`${origin}/login`);
  });

  it("fills an OTP and leaves the next credential step to a new handoff", async () => {
    await load(`<form onsubmit="event.preventDefault()"><input autocomplete="one-time-code" maxlength="6">
      <button type="button" onclick="document.querySelector('input').value='';document.querySelector('input').type='password'">Verify</button></form>`);
    const target = await discoverCredentialForm(service);
    expect(target.kind).toBe("otp");
    const result = await fillCredentialForm(service, target, { code: "123456", submit: true });
    expect(result.submitted).toBe(true);
    expect(await getCredentialContinuation(service)).toBeNull();
  });
});
