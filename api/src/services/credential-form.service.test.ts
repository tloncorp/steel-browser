import { createServer } from "node:http";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CDPService } from "./cdp/cdp.service.js";
import { createBrowserLogger } from "./cdp/instrumentation/browser-logger.js";
import { browserMonitorStatus } from "./browser-monitor.service.js";
import { createGateway, mintCapability } from "../../../session-viewer/server.mjs";
import {
  discoverCredentialForm,
  fillCredentialForm,
  getCredentialContinuation,
  prepareCredentialForm,
  getBoundCredentialForm,
  CredentialFormError,
} from "./credential-form.service.js";
import type { SelectedFormControl, SelectedFormRequest } from "./selected-form.service.js";

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
  const framePages = new Map<string, string>();
  const site = createServer((req, res) => {
    requests.push(req.url || "");
    res.setHeader("Content-Type", "text/html");
    res.end(
      framePages.get(req.url || "") ??
        (req.url?.startsWith("/done") ? "<h1>Account home</h1>" : html),
    );
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
    framePages.clear();
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(5000);
    await page.setViewport({ width: 1920, height: 1080 });
    const logger = createBrowserLogger({
      baseLogger: { info() {}, error() {} },
      enableConsoleLogging: false,
    });
    service = {
      getAllPages: async () => [page],
      getInstrumentationLogger: () => logger,
    } as unknown as CDPService;
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

  async function selection(
    selectors: string[],
    frame: Frame = page.mainFrame(),
  ): Promise<SelectedFormRequest> {
    const cdp = await page.createCDPSession();
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    const fields: SelectedFormControl[] = [];
    try {
      for (const selector of selectors) {
        const input = await frame.$(selector);
        if (!input) throw new Error("Missing fixture control");
        const frameClient = (frame as unknown as { client: typeof cdp }).client;
        const { node } = await frameClient.send("DOM.describeNode", {
          objectId: input.remoteObject().objectId,
        });
        const ax = await frameClient.send("Accessibility.getPartialAXTree", {
          backendNodeId: node.backendNodeId,
          fetchRelatives: false,
        });
        const owner = await input.evaluateHandle((input) => (input as HTMLInputElement).form);
        const metadata = await input.evaluate((element) => {
          const input = element as HTMLInputElement;
          return {
            tagName: input.tagName as SelectedFormControl["tagName"],
            type: input.type,
            name: input.name,
            id: input.id,
          };
        });
        fields.push({
          ...metadata,
          backendNodeId: node.backendNodeId,
          label: String(ax.nodes.find((node) => !node.ignored)?.name?.value || "")
            .replace(/\s+/g, " ")
            .trim(),
          frameId: (frame as unknown as { _id: string })._id,
          loaderId: (frame as unknown as { _loaderId: string })._loaderId,
          ...(owner.asElement()
            ? {
                formBackendNodeId: (
                  await frameClient.send("DOM.describeNode", {
                    objectId: owner.remoteObject().objectId,
                  })
                ).node.backendNodeId,
              }
            : {}),
        });
        await owner.dispose();
        await input.dispose();
      }
      return { pageId: targetInfo.targetId, fields };
    } finally {
      await cdp.detach();
    }
  }

  async function formGateway() {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const secret = "synthetic-test-secret-at-least-thirty-two-bytes";
    const upstream = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://upstream.test");
      try {
        let result;
        if (url.pathname === `/v1/sessions/${sessionId}`) {
          result = {
            id: sessionId,
            status: "live",
            createdAt: new Date().toISOString(),
            timeout: 60_000,
          };
        } else if (url.pathname.endsWith("/credential-handoff")) {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          result = {
            ...(await prepareCredentialForm(service, JSON.parse(Buffer.concat(chunks).toString()))),
            expiresAt: Date.now() + 300_000,
          };
        } else if (url.pathname !== `/v1/sessions/${sessionId}/credential-form`) {
          return void response.writeHead(404).end();
        } else if (request.method === "GET") {
          result = url.searchParams.has("formId")
            ? await getBoundCredentialForm(service, url.searchParams.get("formId")!)
            : await discoverCredentialForm(
                service,
                url.searchParams.get("scope") === "all" ? "all" : "sensitive",
              );
        } else {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const { target, ...values } = JSON.parse(Buffer.concat(chunks).toString());
          result = { ok: true, ...(await fillCredentialForm(service, target, values)) };
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch (error) {
        response
          .writeHead(error instanceof CredentialFormError ? error.statusCode : 500, {
            "content-type": "application/json",
          })
          .end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No upstream listener");
    const { publicServer, internal } = createGateway({
      secret,
      publicOrigin: "https://viewer.example.test",
      upstreamOrigin: `http://127.0.0.1:${address.port}`,
      maximumTtlMs: 60_000,
    });
    return { sessionId, secret, publicServer, internal, upstream };
  }

  it("reports a completed fill while an optional passkey prompt awaits a browser action", async () => {
    await load(`<form onsubmit="event.preventDefault();this.remove();document.getElementById('passkey').hidden=false">
      <label>Username<input name="user" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button>Sign in</button></form>
      <section id="passkey" hidden><h1>Set up a passkey?</h1>
      <button id="not-now" onclick="document.body.innerHTML='<h1>Account home</h1>'">Not now</button></section>`);
    const { sessionId, publicServer, internal, upstream } = await formGateway();
    try {
      await new Promise<void>((resolve) => publicServer.listen(0, "127.0.0.1", resolve));
      await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${publicServer.address().port}`;
      const prepared = await fetch(
        `http://127.0.0.1:${internal.address().port}/v1/sessions/${sessionId}/credential-handoff`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ discover: true }),
        },
      );
      expect(prepared.status).toBe(200);
      const token = new URL((await prepared.json()).viewer_url).pathname.slice(3);
      const handoff = await (await fetch(`${base}/credentials/${token}`)).json();
      const filled = await fetch(`${base}/credential-fills/${handoff.handoffId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: { f0: "fixture-user", f1: "fixture-password" },
          submit: true,
        }),
      });
      expect(filled.status).toBe(200);
      expect(await (await fetch(`${base}/credential-result/${token}`)).json()).toEqual({
        status: "filled",
        submitted: true,
      });
      await expect(discoverCredentialForm(service)).rejects.toMatchObject({ statusCode: 404 });
      expect(await page.$eval("#passkey", (element) => element.hidden)).toBe(false);
      await page.click("#not-now");
      expect(await page.$eval("h1", (element) => element.textContent)).toBe("Account home");
      expect(await (await fetch(`${base}/credential-result/${token}`)).json()).toEqual({
        status: "filled",
        submitted: true,
      });
    } finally {
      publicServer.closeAllConnections();
      internal.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => publicServer.close(resolve)),
        new Promise<void>((resolve) => internal.close(resolve)),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });

  it("preserves login semantics when selecting the complete username/password form", async () => {
    await page.setRequestInterception(true);
    page.on(
      "request",
      (request) =>
        void request.respond({
          contentType: "text/html",
          body: `<b>Login</b><form action="/login"><input name="acct"><input name="pw" type="password"><input type="submit" value="login"></form>
        <b>Create Account</b><form action="/register"><input name="acct"><input name="pw" type="password"><input type="submit" value="create account"></form>`,
        }),
    );
    await page.goto("https://login.example.test/login");
    const form = await prepareCredentialForm(
      service,
      await selection([
        'form[action="/login"] input[name="acct"]',
        'form[action="/login"] input[name="pw"]',
      ]),
    );
    expect(form).toMatchObject({ kind: "login", vaultEligible: true });
    expect(form.fields.map(({ purpose, required }) => ({ purpose, required }))).toEqual([
      { purpose: "username", required: true },
      { purpose: "current-password", required: true },
    ]);
    expect(await getBoundCredentialForm(service, form.formId)).toEqual(form);
  });

  it.each([
    [
      "partial login",
      '<form><input name="user"><input type="password"><button>Login</button></form>',
      ['input[type="password"]'],
    ],
    [
      "account creation",
      '<form><input name="user"><input type="password"><button>Create account</button></form>',
      ['input[name="user"]', 'input[type="password"]'],
    ],
    [
      "new password",
      '<form><input name="user"><input type="password" autocomplete="new-password"><button>Login</button></form>',
      ['input[name="user"]', 'input[type="password"]'],
    ],
    [
      "mixed checkout",
      '<form><input name="user"><input type="password"><input autocomplete="cc-number"><button>Pay</button></form>',
      ['input[name="user"]', 'input[type="password"]'],
    ],
  ])("keeps selected %s fields as private details", async (_name, body, selectors) => {
    await load(body as string);
    const form = await prepareCredentialForm(service, await selection(selectors as string[]));
    expect(form).toMatchObject({ kind: "details", vaultEligible: false });
  });

  it("fills only selected fields, preserving unrelated required fields and dropdown values", async () => {
    await load(`<form action="/done"><label>Last name<input name="lastname" required></label>
      <label>SSN<input name="ssn_3" required></label><label>Month<select name="bm" required>
      <option disabled selected>Choose</option><option value="01">January</option><option value="02">February</option>
      </select></label><button>Submit</button></form>`);
    const form = await prepareCredentialForm(
      service,
      await selection(['[name="ssn_3"]', '[name="bm"]']),
    );
    expect(form.kind).toBe("details");
    expect(form.fields.map((field) => field.label)).toEqual(["SSN", "Month"]);
    expect(form.fields[1].options).toEqual([
      { value: "1", label: "January" },
      { value: "2", label: "February" },
    ]);
    expect(await getBoundCredentialForm(service, form.formId)).toEqual(form);
    expect(
      await fillCredentialForm(service, form, { values: { f0: "123", f1: "2" }, submit: true }),
    ).toMatchObject({ submitted: false });
    expect(
      await page.$$eval("input,select", (inputs) =>
        inputs.map((input) => ({
          name: (input as HTMLInputElement).name,
          value: (input as HTMLInputElement).value,
          private: input.getAttribute("data-steel-private"),
        })),
      ),
    ).toEqual([
      { name: "lastname", value: "", private: null },
      { name: "ssn_3", value: "123", private: "true" },
      { name: "bm", value: "02", private: "true" },
    ]);
    expect(new URL(page.url()).pathname).toBe("/login");
  });

  it("rebinds a replaced input by its exact name within the original form", async () => {
    await load('<form><label>Member<input name="member"></label></form>');
    const target = await selection(["input"]);
    await page.$eval("input", (input) => input.replaceWith(input.cloneNode()));
    const form = await prepareCredentialForm(service, target);
    await fillCredentialForm(service, form, { values: { f0: "private-member" } });
    expect(await page.$eval("input", (input) => input.value)).toBe("private-member");
  });

  it("rebinds an unnamed input by a unique label within the original form", async () => {
    await load('<form><input aria-label="Member"></form>');
    const target = await selection(["input"]);
    await page.$eval("input", (input) => input.replaceWith(input.cloneNode()));
    const form = await prepareCredentialForm(service, target);
    expect(form.fields[0].label).toBe("Member");
  });

  it("uses Chrome's accessible labels when visible labels contain hidden annotations", async () => {
    await load(
      '<form><label>Member <span aria-hidden="true">required</span><input name="member"></label></form>',
    );
    const target = await selection(["input"]);
    expect(target.fields[0].label).toBe("Member");
    await page.$eval("input", (input) => input.replaceWith(input.cloneNode()));
    expect((await prepareCredentialForm(service, target)).fields).toHaveLength(1);
  });

  it("uses visible field labels and compound-date prompts instead of raw element names", async () => {
    await load(`<form>
      <p><span for="lastname">Last Name:</span><input id="lastname" name="lastname"></p>
      <span for="ssn_3">Last Four Digits of Social Security Number:</span><input id="ssn_3" name="ssn_3" maxlength="4">
      <label for="bm">Date of Birth:</label><select id="bm" name="bm"><option value="">--Select Month--</option><option value="02">February</option></select>
      <select name="bd"><option value="">--Select Day--</option><option value="03">3</option></select>
      <select name="by"><option value="">--Select Year--</option><option value="2000">2000</option></select>
      </form>`);
    const form = await prepareCredentialForm(
      service,
      await selection(["#lastname", "#ssn_3", "#bm", '[name="bd"]', '[name="by"]']),
    );
    expect(form.fields.map((field) => field.label)).toEqual([
      "Last Name:",
      "Last Four Digits of Social Security Number:",
      "Date of Birth: Month",
      "Date of Birth: Day",
      "Date of Birth: Year",
    ]);
    expect(form.fields[1].maxLength).toBe(4);
  });

  it("keeps unrelated adjacent dropdown labels separate", async () => {
    await load(
      '<form><label for="country">Country</label><select id="country"><option value="">Choose a country</option><option>US</option></select><select><option value="">Choose a city</option><option>Boston</option></select></form>',
    );
    const form = await discoverCredentialForm(service, "all");
    expect(form.fields.map((field) => field.label)).toEqual(["Country", "city"]);
  });

  it("refuses a selected field whose displayed label changes before entry", async () => {
    await load(
      '<form><span for="member">Membership number</span><input id="member" name="member"></form>',
    );
    const form = await prepareCredentialForm(service, await selection(["input"]));
    await page.$eval("span", (label) => {
      label.textContent = "Government identifier";
    });
    await expect(getBoundCredentialForm(service, form.formId)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      fillCredentialForm(service, form, { values: { f0: "private-member" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await page.$eval("input", (input) => input.value)).toBe("");
  });

  it.each(["duplicate", "different-form", "changed-type", "changed-label", "hidden"])(
    "rejects a %s field without expanding the selection",
    async (change) => {
      await load('<form><input name="member" aria-label="Member"></form>');
      const target = await selection(["input"]);
      await page.evaluate((change) => {
        const input = document.querySelector("input")!;
        if (change === "duplicate") {
          input.after(input.cloneNode(), input.cloneNode());
          input.remove();
        }
        if (change === "different-form")
          input.closest("form")!.outerHTML =
            '<form><input name="member" aria-label="Member"></form>';
        if (change === "changed-type") input.type = "password";
        if (change === "changed-label") input.setAttribute("aria-label", "Another field");
        if (change === "hidden") input.hidden = true;
      }, change);
      await expect(prepareCredentialForm(service, target)).rejects.toMatchObject({
        statusCode: 409,
        code: "stale_ref",
      });
      expect(
        await page.$$eval("input", (inputs) => inputs.every((input) => input.value === "")),
      ).toBe(true);
    },
  );

  it("rejects navigation to a fresh document at the same URL", async () => {
    await load('<form><input name="member"></form>');
    const target = await selection(["input"]);
    await page.reload();
    await expect(prepareCredentialForm(service, target)).rejects.toMatchObject({
      statusCode: 409,
      code: "stale_ref",
    });
  });

  it("binds selected controls inside a frame and rejects a frame reload", async () => {
    framePages.set("/member", '<form><input name="member" aria-label="Member"></form>');
    await load('<iframe src="/member"></iframe>');
    const frame = page.frames().find((frame) => frame.url().endsWith("/member"))!;
    const target = await selection(["input"], frame);
    expect((await prepareCredentialForm(service, target)).fields[0].label).toBe("Member");
    await frame.goto(`${origin}/member`);
    await expect(prepareCredentialForm(service, target)).rejects.toMatchObject({
      statusCode: 409,
      code: "stale_ref",
    });
  });

  it("binds selected sibling-frame controls through their containing form", async () => {
    framePages.set(
      "/month",
      '<form><select name="month" aria-label="Month"><option value="jan">January</option></select></form>',
    );
    framePages.set("/year", '<form><input name="year" aria-label="Year"></form>');
    await load(
      '<form><input required name="unselected"><iframe src="/month"></iframe><iframe src="/year"></iframe></form>',
    );
    const monthFrame = page.frames().find((frame) => frame.url().endsWith("/month"))!;
    const yearFrame = page.frames().find((frame) => frame.url().endsWith("/year"))!;
    const month = await selection(["select"], monthFrame);
    const year = await selection(["input"], yearFrame);
    const form = await prepareCredentialForm(service, {
      ...month,
      fields: [...month.fields, ...year.fields],
    });
    expect(form.fields.map((field) => field.label)).toEqual(["Month", "Year"]);
    await fillCredentialForm(service, form, { values: { f0: "0", f1: "2000" } });
    expect(await yearFrame.$eval("input", (input) => input.value)).toBe("2000");
    expect(await page.$eval("input", (input) => input.value)).toBe("");
  });

  it("rejects a changed selection on retrieval and dropdown changes before filling", async () => {
    await load(
      '<form><select name="month"><option value="jan">January</option></select><input required name="other"></form>',
    );
    const target = await selection(["select"]);
    const form = await prepareCredentialForm(service, target);
    await page.$eval("option", (option) => {
      option.value = "other-value";
    });
    await expect(getBoundCredentialForm(service, form.formId)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(fillCredentialForm(service, form, { values: { f0: "0" } })).rejects.toMatchObject({
      statusCode: 409,
    });
    const next = await prepareCredentialForm(service, await selection(["select"]));
    expect(next.formId).not.toBe(form.formId);
    await expect(getBoundCredentialForm(service, form.formId)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("treats a selected radio group as one field and ignores unselected changes", async () => {
    await load(
      '<form><label>Yes<input type="radio" name="answer" value="yes"></label><label>No<input type="radio" name="answer" value="no"></label><input name="other" required></form>',
    );
    const form = await prepareCredentialForm(service, await selection(['[value="yes"]']));
    expect(form.fields).toHaveLength(1);
    await page.$eval('[name="other"]', (input) => input.remove());
    await fillCredentialForm(service, form, { values: { f0: "1" } });
    expect(await page.$eval('[value="no"]', (input) => (input as HTMLInputElement).checked)).toBe(
      true,
    );
  });

  it("keeps monitoring fill evidence after the page navigates and the app stops polling", async () => {
    await load(
      '<form action="/done"><input name="username" autocomplete="username"><input type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>',
    );
    const baseline = browserMonitorStatus(service);
    const form = await discoverCredentialForm(service, "all");
    const values = Object.fromEntries(
      form.fields.map((field) => [
        field.id,
        field.purpose === "current-password" ? "private-password" : "private-user",
      ]),
    );
    await fillCredentialForm(service, form, { values, submit: true });
    await page.waitForFunction(() => location.pathname === "/done");
    expect(await getCredentialContinuation(service)).toBeNull();
    const status = browserMonitorStatus(service);
    expect(status.fill).toMatchObject({ formId: form.formId, submitted: true });
    expect(status.revision).toBeGreaterThan(baseline.revision);
    expect(JSON.stringify(status)).not.toMatch(/private-password|private-user|frameUrl|origin/);
  });
  const fields =
    '<label>Username<input name="username"></label><label>Password<input name="password" type="password"></label>';
  async function fill(submit = true) {
    const target = await discoverCredentialForm(service, "all");
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

  async function loadSecure(body: string) {
    await page.setRequestInterception(true);
    page.on(
      "request",
      (request) => void request.respond({ status: 200, contentType: "text/html", body }),
    );
    await page.goto("https://login.example/signin");
  }

  it("fills saved HTTPS logins and marks both fields sensitive before any input events", async () => {
    await loadSecure(`<form onsubmit="event.preventDefault()">${fields}<button>Sign in</button></form>
      <script>window.leaked=false; document.addEventListener('input',e=>{if(e.target.dataset.steelPrivate!=='true')window.leaked=true})</script>`);
    const target = await discoverCredentialForm(service);
    expect(target.vaultEligible).toBe(true);
    const result = await fillCredentialForm(service, target, {
      vault: true,
      values: { f0: "fixture-user", f1: "fixture-secret" },
      submit: true,
    });
    expect(result.submitted).toBe(true);
    expect(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll("input")).map((input) => [
          input.value,
          input.dataset.steelPrivate,
        ]),
      ),
    ).toEqual([
      ["fixture-user", "true"],
      ["fixture-secret", "true"],
    ]);
    expect(await page.evaluate("window.leaked")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    const status = browserMonitorStatus(service);
    expect(status).toMatchObject({
      form: { formId: target.formId },
      fill: { formId: target.formId, submitted: true },
    });
    expect(JSON.stringify(status)).not.toMatch(/fixture-user|fixture-secret|origin|frameUrl/);
  });

  it("rejects saved credentials for HTTP, cross-origin actions, OTP, and cross-origin frames", async () => {
    await load(`<form>${fields}</form>`);
    let target = await discoverCredentialForm(service);
    expect(target.vaultEligible).toBe(false);
    await expect(
      fillCredentialForm(service, target, {
        vault: true,
        values: { f0: "fixture-user", f1: "fixture-secret" },
      }),
    ).rejects.toThrow("destination changed");
    expect(browserMonitorStatus(service).failure).toBeDefined();
    expect(browserMonitorStatus(service).fill).toBeUndefined();
    await loadSecure(`<form action="https://different.example/receive">${fields}</form>`);
    expect((await discoverCredentialForm(service)).vaultEligible).toBe(false);
    await page.setContent('<input autocomplete="one-time-code" required>');
    expect((await discoverCredentialForm(service)).vaultEligible).toBe(false);
    await page.setContent(
      '<iframe src="https://different.example/form" width="600" height="300"></iframe>',
    );
    await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow !== null);
    // Each intercepted document has the login form; the top page contains only the frame.
    target = await discoverCredentialForm(service);
    expect(target.origin).toBe("https://different.example");
    expect(target.vaultEligible).toBe(false);
  });

  it("refuses a stale destination before disclosing a password, including synchronous field handlers", async () => {
    await loadSecure(
      `<form onsubmit="event.preventDefault()">${fields}<button>Sign in</button></form>`,
    );
    let target = await discoverCredentialForm(service);
    await page.evaluate(() => {
      document.querySelector("form")!.action = "https://different.example/receive";
    });
    await expect(
      fillCredentialForm(service, target, {
        vault: true,
        values: { f0: "fixture-user", f1: "fixture-secret" },
      }),
    ).rejects.toThrow();
    expect(await page.$eval("[type=password]", (input) => (input as HTMLInputElement).value)).toBe(
      "",
    );
    await page.evaluate(() => {
      document.querySelector("form")!.action = "/signin";
      document.querySelector("[name=username]")!.addEventListener("input", () => {
        document.querySelector("form")!.action = "https://different.example/receive";
      });
    });
    target = await discoverCredentialForm(service);
    await expect(
      fillCredentialForm(service, target, {
        vault: true,
        values: { f0: "fixture-user", f1: "fixture-secret" },
      }),
    ).rejects.toThrow();
    expect(await page.$eval("[type=password]", (input) => (input as HTMLInputElement).value)).toBe(
      "",
    );
  });

  it("checks the destination again after focus handlers run", async () => {
    await loadSecure(`<form>${fields}<button>Sign in</button></form><script>
      document.querySelector('[type=password]').onfocus=()=>{document.querySelector('form').action='https://different.example/receive'}
    </script>`);
    const target = await discoverCredentialForm(service);
    await expect(
      fillCredentialForm(service, target, {
        vault: true,
        values: { f0: "fixture-user", f1: "fixture-secret" },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await page.$eval("[type=password]", (input) => (input as HTMLInputElement).value)).toBe(
      "",
    );
  });

  it("observes a submitted login form that remains visible", async () => {
    await load(`<form onsubmit="event.preventDefault()">${fields}<button>Sign in</button></form>`);
    expect((await fill()).submitted).toBe(true);
    const filled = browserMonitorStatus(service);
    const redisplayed = await discoverCredentialForm(service, "all");
    const observed = browserMonitorStatus(service);
    expect(redisplayed.formId).toBe(filled.fill!.formId);
    expect(observed.form!.revision).toBeGreaterThan(filled.fill!.revision);
    expect(observed.fill).toEqual(filled.fill);
    expect(JSON.stringify(observed)).not.toMatch(/private-password|test-user/);
  });

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

  it("includes additional required fields and leaves submission in the live browser", async () => {
    await load(
      `<form action="/done">${fields}<input required name="extra"><button>Log in</button></form>`,
    );
    const target = await discoverCredentialForm(service, "all");
    expect(target.fields).toHaveLength(3);
    expect(target.fields[2]).toMatchObject({ label: "extra", purpose: "field", required: true });
    await expect(
      fillCredentialForm(service, target, { values: { f0: "user", f1: "secret" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
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
    const target = await discoverCredentialForm(service, "all");
    expect(target.fields[0].purpose).toBe("one-time-code");
    const result = await fillCredentialForm(service, target, {
      values: { [target.fields[0].id]: "123456" },
      submit: true,
    });
    expect(result.submitted).toBe(true);
    expect(await getCredentialContinuation(service)).toBeNull();
  });

  async function fillValues(values: Record<string, string>, submit = true) {
    const target = await discoverCredentialForm(service, "all");
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
    const first = await discoverCredentialForm(service, "all");
    expect(first.fields.map((field) => field.purpose)).toEqual(["username"]);
    expect((await discoverCredentialForm(service, "all")).formId).toBe(first.formId);
    await fillCredentialForm(service, first, {
      values: { f0: "person@example.test" },
      submit: true,
    });
    const second = await discoverCredentialForm(service, "all");
    expect(second.formId).not.toBe(first.formId);
    expect(second.fields.map((field) => field.purpose)).toEqual(["current-password"]);
    expect(await page.$eval("input", (input) => input.value)).toBe("");
    await expect(
      fillCredentialForm(service, first, { values: { f0: "do-not-replay" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await fillCredentialForm(service, second, { values: { f0: "private-password" }, submit: true });
    const third = await discoverCredentialForm(service, "all");
    expect(third.fields).toMatchObject([{ purpose: "one-time-code", exactLength: 6 }]);
    await fillCredentialForm(service, third, { values: { f0: "aBc123" }, submit: true });
    expect(await page.$eval("h2", (el) => el.textContent)).toBe("Account home");
    await expect(discoverCredentialForm(service, "all")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("recognizes login forms with account-creation and recovery links", async () => {
    await load(
      `<form onsubmit="event.preventDefault()">${fields}<a href="/register">Sign up</a><a href="/reset">Reset password</a><button>Sign in</button></form>`,
    );
    expect((await fill()).submitted).toBe(true);
  });

  it.each([false, true])(
    "selects the login beside an account-creation form (registration first: %s)",
    async (registrationFirst) => {
      const login = `<form id="login" method="post" onsubmit="event.preventDefault(); document.body.dataset.submitted='login'">
        <input name="acct" autocomplete="username">
        <input name="pw" type="password" autocomplete="current-password">
        <input type="submit" value="login">
      </form>`;
      const registration = `<form id="registration" method="post" onsubmit="event.preventDefault(); document.body.dataset.submitted='registration'">
        <input type="hidden" name="creating" value="t">
        <input name="acct" autocomplete="username">
        <input name="pw" type="password" autocomplete="new-password">
        <input type="submit" value="create account">
      </form>`;
      await loadSecure(registrationFirst ? registration + login : login + registration);
      const target = await discoverCredentialForm(service);
      expect(target.kind).toBe("login");
      expect(target.vaultEligible).toBe(true);
      expect(target.fields.map((field) => field.purpose)).toEqual(["username", "current-password"]);
      await expect(
        fillCredentialForm(service, target, {
          vault: true,
          values: { f0: "fixture-user", f1: "fixture-secret" },
          submit: true,
        }),
      ).resolves.toEqual({ submitted: true });
      expect(await page.$eval("body", (body) => body.dataset.submitted)).toBe("login");
      expect(
        await page.$$eval("#registration input:not([type=hidden]):not([type=submit])", (inputs) =>
          inputs.map((input) => (input as HTMLInputElement).value),
        ),
      ).toEqual(["", ""]);
    },
  );
  it("keeps login submission available with optional checkboxes", async () => {
    await load(`<form onsubmit="event.preventDefault();document.body.dataset.sent='yes'">${fields}
      <label>Remember me<input type="checkbox"></label><button>Sign in</button></form>`);
    const target = await discoverCredentialForm(service, "all");
    expect(target.kind).toBe("login");
    expect(target.fields[2]).toMatchObject({ label: "Remember me", required: false });
    expect(
      await fillCredentialForm(service, target, {
        values: { f0: "user", f1: "secret", f2: "1" },
        submit: true,
      }),
    ).toEqual({ submitted: true });
    expect(
      await page.$eval('[type="checkbox"]', (input) => (input as HTMLInputElement).checked),
    ).toBe(true);
    expect(await page.evaluate(() => document.body.dataset.sent)).toBe("yes");
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
  ])("fills general forms without classifying them as logins", async (body) => {
    await load(body);
    // Identifier fields without a sign-in context are general fields.
    if (body.includes('name="email"'))
      await page.evaluate(() => history.replaceState(null, "", "/form"));
    const target = await discoverCredentialForm(service, "all");
    expect(target.kind).toBe("details");
    expect(target.fields[0].purpose).toBe("field");
    expect(
      await fillCredentialForm(service, target, {
        values: { f0: "test@example.test" },
        submit: true,
      }),
    ).toEqual({ submitted: false });
    expect(await page.$eval("input", (input) => input.value)).toBe("test@example.test");
  });

  it("requires focus to choose between multiple visible forms", async () => {
    await load(
      '<form><input name="search"><button>Search</button></form><form><input name="feedback"><button>Send</button></form>',
    );
    await expect(discoverCredentialForm(service, "all")).rejects.toMatchObject({ statusCode: 404 });
    await page.focus('[name="feedback"]');
    const target = await discoverCredentialForm(service, "all");
    expect(target.fields.map((field) => field.label)).toEqual(["feedback"]);
    await fillCredentialForm(service, target, { values: { f0: "A suggestion" } });
    expect(await page.$$eval("input", (inputs) => inputs.map((input) => input.value))).toEqual([
      "",
      "A suggestion",
    ]);
  });

  it.each(["main", 'div role="main"'])(
    "selects the primary form in %s while respecting explicit focus",
    async (landmark) => {
      const tag = landmark.split(" ")[0];
      await load(
        `<${landmark}><form><input name="email" type="email"><input name="address"></form></${tag}><aside><form><input name="discount"></form></aside>`,
      );
      const target = await discoverCredentialForm(service, "all");
      expect(target.fields.map((field) => field.label)).toEqual(["email", "address"]);
      await fillCredentialForm(service, target, {
        values: { f0: "person@example.test", f1: "123 Main St" },
        submit: true,
      });
      expect(
        await page.$eval('[name="discount"]', (input) => (input as HTMLInputElement).value),
      ).toBe("");
      await page.focus('[name="discount"]');
      const focused = await discoverCredentialForm(service, "all");
      expect(focused.fields.map((field) => field.label)).toEqual(["discount"]);
    },
  );

  it("does not count nested secondary landmarks as primary forms", async () => {
    await load(
      '<main><form><input name="address"></form><aside><form><input name="discount"></form></aside></main>',
    );
    expect(
      (await discoverCredentialForm(service, "all")).fields.map((field) => field.label),
    ).toEqual(["address"]);
  });

  it("requires focus when the primary content has multiple forms", async () => {
    await load(
      '<main><form><input name="login"></form><form><input name="signup"></form></main><aside><form><input name="discount"></form></aside>',
    );
    await expect(discoverCredentialForm(service, "all")).rejects.toMatchObject({ statusCode: 404 });
  });

  async function loadFramedCheckout() {
    const paymentOrigin = origin.replace("127.0.0.1", "localhost");
    framePages.set(
      "/number",
      '<label>Card number<input autocomplete="cc-number" required></label>',
    );
    framePages.set("/expiry", '<label>Expiry<input autocomplete="cc-exp" required></label>');
    framePages.set("/code", '<label>Security code<input autocomplete="cc-csc" required></label>');
    framePages.set("/unrelated", '<label>Search<input name="search"></label>');
    html =
      '<main><form id="checkout" action="/done"><label>Email<input name="email" type="email" autocomplete="email" required></label><button>Pay now</button></form></main><aside></aside>';
    await page.goto(`${origin}/checkout`);
    for (const path of ["/number", "/expiry", "/code", "/unrelated"]) {
      const url = paymentOrigin + path;
      await page.evaluate(
        (url, secondary) => {
          const frame = document.createElement("iframe");
          frame.src = url;
          document.querySelector(secondary ? "aside" : "form")!.append(frame);
        },
        url,
        path === "/unrelated",
      );
      const frame = await page.waitForFrame((frame) => frame.url() === url);
      await frame.waitForSelector("input", { timeout: 5000 });
    }
  }

  it("discovers and fills one checkout across cross-origin payment frames without submitting", async () => {
    await loadFramedCheckout();
    const target = await discoverCredentialForm(service, "all");
    expect(target.kind).toBe("details");
    expect(target.fields.map((field) => field.purpose)).toEqual([
      "email",
      "cc-number",
      "cc-exp",
      "cc-csc",
    ]);
    expect(new Set(target.fields.map((field) => field.id)).size).toBe(4);
    expect((await discoverCredentialForm(service, "all")).formId).toBe(target.formId);
    const number = page.frames().find((frame) => frame.url().endsWith("/number"))!;
    await number.focus("input");
    expect((await discoverCredentialForm(service, "all")).fields).toEqual(target.fields);
    const values = { f0: "person@example.test", f1: "4242424242424242", f2: "12/30", f3: "123" };
    expect(await fillCredentialForm(service, target, { values, submit: true })).toEqual({
      submitted: false,
    });
    expect(await page.$eval("input", (input) => input.value)).toBe(values.f0);
    expect(await number.$eval("input", (input) => input.value)).toBe(values.f1);
    expect(
      await page
        .frames()
        .find((frame) => frame.url().endsWith("/unrelated"))!
        .$eval("input", (input) => input.value),
    ).toBe("");
    expect(requests).not.toContain("/done");
    expect(await getCredentialContinuation(service)).toMatchObject({
      formId: target.formId,
      frameUrl: page.url(),
    });
    await number.$eval("input", (input) => {
      input.value = "";
    });
    expect(await getCredentialContinuation(service)).toBeNull();
  });

  it("hands off only payment fields across frames and preserves bot-entered details", async () => {
    await loadFramedCheckout();
    await page.$eval("input", (input) => {
      input.value = "person@example.test";
    });
    const target = await discoverCredentialForm(service);
    expect(target.fields.map((field) => field.purpose)).toEqual(["cc-number", "cc-exp", "cc-csc"]);
    expect((await discoverCredentialForm(service)).formId).toBe(target.formId);
    // Ordinary checkout rerenders and an unrelated hidden frame do not change
    // the payment destinations that the owner approves.
    await page.$eval("input", (input) => input.replaceWith(input.cloneNode()));
    await page.$eval("aside", (element) => {
      element.style.display = "none";
    });
    expect((await discoverCredentialForm(service)).formId).toBe(target.formId);
    expect(
      await fillCredentialForm(service, target, {
        values: { f0: "4242424242424242", f1: "12/30", f2: "123" },
        submit: true,
      }),
    ).toEqual({ submitted: false });
    expect(await page.$eval("input", (input) => input.value)).toBe("person@example.test");
    const receipt = await getCredentialContinuation(service);
    expect(receipt).toMatchObject({
      kind: "details",
      formId: target.formId,
      submissionAttempted: false,
    });
    const client = await page.createCDPSession();
    const { node } = await client.send("DOM.describeNode", {
      backendNodeId: receipt!.anchorBackendNodeId,
    });
    expect(node.nodeName).toBe("FORM");
    await client.detach();
    expect(requests).not.toContain("/done");
    const number = page.frames().find((frame) => frame.url().endsWith("/number"))!;
    await number.$eval("input", (input) => {
      input.value = "";
    });
    expect(await getCredentialContinuation(service)).toBeNull();
  });

  it("ignores required ordinary fields and their synchronous updates while filling cards", async () => {
    await load(`<form onsubmit="event.preventDefault();document.body.dataset.paid='yes'">
      <input autocomplete="street-address" required><select autocomplete="country" required><option>US</option></select>
      <input autocomplete="cc-number" required><input autocomplete="cc-exp" required><input autocomplete="cc-csc" required>
      <button>Pay now</button></form><script>
      document.querySelector('[autocomplete=cc-number]').oninput=()=>{
        const address=document.querySelector('[autocomplete=street-address]');address.replaceWith(address.cloneNode());
        document.querySelector('select').innerHTML='<option>Canada</option>';
      };</script>`);
    const target = await discoverCredentialForm(service);
    expect(target.fields.map((field) => field.purpose)).toEqual(["cc-number", "cc-exp", "cc-csc"]);
    await expect(
      fillCredentialForm(service, target, { values: { f0: "4242424242424242", f3: "address" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      await fillCredentialForm(service, target, {
        values: { f0: "4242424242424242", f1: "12/30", f2: "123" },
        submit: true,
      }),
    ).toEqual({ submitted: false });
    expect(
      await page.$eval(
        "[autocomplete=street-address]",
        (input) => (input as HTMLInputElement).value,
      ),
    ).toBe("");
    expect(await page.evaluate(() => document.body.dataset.paid)).toBeUndefined();
    expect(await getCredentialContinuation(service)).not.toBeNull();
  });

  it.each(["replace", "navigate", "hide"])(
    "rejects a changed scoped payment destination: %s",
    async (change) => {
      await loadFramedCheckout();
      const target = await discoverCredentialForm(service);
      const number = page.frames().find((frame) => frame.url().endsWith("/number"))!;
      const code = page.frames().find((frame) => frame.url().endsWith("/code"))!;
      if (change === "replace")
        await code.$eval("input", (input) => input.replaceWith(input.cloneNode()));
      if (change === "hide")
        await page.$eval('iframe[src$="/code"]', (frame) => {
          (frame as HTMLElement).hidden = true;
        });
      if (change === "navigate") {
        await page.$eval(
          'iframe[src$="/code"]',
          (frame, url) => {
            (frame as HTMLIFrameElement).src = url;
          },
          origin + "/unrelated",
        );
        await page.waitForFrame((frame) => frame.url() === origin + "/unrelated");
      }
      await expect(
        fillCredentialForm(service, target, {
          values: { f0: "4242424242424242", f1: "12/30", f2: "123" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await number.$eval("input", (input) => input.value)).toBe("");
    },
  );

  it("keeps ordinary checkout input outside the authentication handoff", async () => {
    await load(`<form>${fields}<input name="extra" required><button>Log in</button></form>`);
    const target = await discoverCredentialForm(service);
    expect(target.fields.map((field) => field.purpose)).toEqual(["username", "current-password"]);
    expect(
      await fillCredentialForm(service, target, {
        values: { f0: "user", f1: "secret" },
        submit: true,
      }),
    ).toEqual({ submitted: false });
    expect(await page.$eval("[name=extra]", (input) => (input as HTMLInputElement).value)).toBe("");
  });

  it.each([
    '<form><input autocomplete="street-address" required><input autocomplete="email" required><button>Pay now</button></form>',
    '<form><input name="search"><button>Search</button></form>',
  ])("leaves ordinary-only forms to the bot", async (body) => {
    await load(body);
    await expect(discoverCredentialForm(service)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(["replace", "navigate", "hide"])(
    "rejects a payment-frame %s before filling any part of a checkout",
    async (change) => {
      await loadFramedCheckout();
      const target = await discoverCredentialForm(service, "all");
      const code = page.frames().find((frame) => frame.url().endsWith("/code"))!;
      if (change === "replace")
        await code.$eval("input", (input) => input.replaceWith(input.cloneNode()));
      if (change === "navigate") {
        await page.$eval(
          'iframe[src$="/code"]',
          (frame, url) => {
            (frame as HTMLIFrameElement).src = url;
          },
          origin + "/unrelated",
        );
        const navigated = await page.waitForFrame((frame) => frame.url() === origin + "/unrelated");
        await navigated.waitForSelector("input");
      }
      if (change === "hide")
        await page.$eval('iframe[src$="/code"]', (frame) => {
          (frame as HTMLElement).style.display = "none";
        });
      await expect(
        fillCredentialForm(service, target, {
          values: { f0: "person@example.test", f1: "4242424242424242", f2: "12/30", f3: "123" },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await page.$eval("input", (input) => input.value)).toBe("");
      expect(
        await page
          .frames()
          .find((frame) => frame.url().endsWith("/number"))!
          .$eval("input", (input) => input.value),
      ).toBe("");
    },
  );

  it("combines generic fields through a nested frame without requiring payment semantics", async () => {
    const embeddedOrigin = origin.replace("127.0.0.1", "localhost");
    framePages.set("/wrapper", "<div id=content></div>");
    framePages.set(
      "/message",
      '<label>Message<textarea name="message" required></textarea></label>',
    );
    await load(
      `<form><label>Topic<input name="topic"></label><iframe src="${embeddedOrigin}/wrapper"></iframe></form>`,
    );
    const wrapper = page.frames().find((frame) => frame.url().endsWith("/wrapper"))!;
    await wrapper.evaluate((url) => {
      const frame = document.createElement("iframe");
      frame.src = url;
      document.body.append(frame);
    }, origin + "/message");
    const message = await page.waitForFrame((frame) => frame.url().endsWith("/message"));
    await message.waitForSelector("textarea");
    const target = await discoverCredentialForm(service, "all");
    expect(target.fields.map((field) => field.label)).toEqual(["Topic", "Message"]);
    await fillCredentialForm(service, target, { values: { f1: "A message" } });
    expect(await message.$eval("textarea", (input) => input.value)).toBe("A message");
    expect(await page.$eval("input", (input) => input.value)).toBe("");
    const receipt = await getCredentialContinuation(service);
    expect(receipt?.frameUrl).toBe(page.url());
    const client = await page.createCDPSession();
    const { node } = await client.send("DOM.describeNode", {
      backendNodeId: receipt!.anchorBackendNodeId,
    });
    expect(node.nodeName).toBe("FORM");
    await client.detach();
  });

  it("requires focus for unrelated sibling frame forms", async () => {
    framePages.set("/one", '<input name="one">');
    framePages.set("/two", '<input name="two">');
    await load(`<iframe src="${origin}/one"></iframe><iframe src="${origin}/two"></iframe>`);
    await expect(discoverCredentialForm(service, "all")).rejects.toMatchObject({ statusCode: 404 });
    await page
      .frames()
      .find((frame) => frame.url().endsWith("/two"))!
      .focus("input");
    expect(
      (await discoverCredentialForm(service, "all")).fields.map((field) => field.label),
    ).toEqual(["two"]);
  });

  it("rejects changed nodes and field semantics on the same URL before writing", async () => {
    for (const mutation of ["replace", "type", "form"] as const) {
      await load(
        `<form id="login">${fields}<button>Sign in</button></form><form id="other"></form>`,
      );
      const target = await discoverCredentialForm(service, "all");
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
    const target = await discoverCredentialForm(service, "all");
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
      { value: "0", label: "Choose country" },
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
    const target = await discoverCredentialForm(service, "all");
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
    const target = await discoverCredentialForm(service, "all");
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
    const target = await discoverCredentialForm(service, "all");
    expect(target.fields.map((field) => field.purpose)).toEqual(["current-password"]);
    await fillCredentialForm(service, target, { values: { f0: "secret" } });
    expect(
      await page.evaluate(
        () => document.querySelector("#host")!.shadowRoot!.querySelector("input")!.value,
      ),
    ).toBe("secret");
  });

  it("fills native text controls using page labels without exposing existing values", async () => {
    await load(`<form onsubmit="event.preventDefault();document.body.dataset.sent='yes'">
      <label>Subject<input name="subject" required value="private-subject"></label>
      <label>Message<textarea required>private-message</textarea></label>
      <span id="when">Appointment date</span><input type="date" aria-labelledby="when">
      <input type="number" aria-label="Party size" min="1" max="12">
      <input type="url" placeholder="Website">
      <input type="search" name="query">
      <input type="time" id="time">
      <input>
      <input disabled name="disabled"><input readonly name="readonly"><input type="hidden" name="hidden">
      <button>Send</button></form>`);
    const target = await discoverCredentialForm(service, "all");
    expect(target.kind).toBe("details");
    expect(target.fields.map((field) => field.label)).toEqual([
      "Subject",
      "Message",
      "Appointment date",
      "Party size",
      "Website",
      "query",
      "time",
      "Field 8",
    ]);
    expect(target.fields[1].inputType).toBe("textarea");
    expect(JSON.stringify(target)).not.toMatch(/private-subject|private-message/);
    const values = [
      "A question",
      "First line\nSecond line",
      "2026-10-09",
      "3",
      "https://example.test",
      "find me",
      "12:30",
      "unnamed",
    ];
    expect(
      await fillCredentialForm(service, target, {
        values: Object.fromEntries(values.map((value, i) => [`f${i}`, value])),
        submit: true,
      }),
    ).toEqual({ submitted: false });
    expect(
      await page.$$eval(
        "input:not(:disabled):not([readonly]):not([type=hidden]), textarea",
        (inputs) => inputs.map((input) => (input as HTMLInputElement).value),
      ),
    ).toEqual(values);
    expect(await page.evaluate(() => document.body.dataset.sent)).toBeUndefined();
  });

  it.each(["viewer", "automatic", "selected"])(
    "passes generic date dropdowns through the viewer and dispatches their field events (%s)",
    async (mode) => {
      const selected = mode === "selected";
      await load(`<form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'">
      <label>Reference<input name="reference" required></label>
      <label>Month<select name="month" required>
        <option value="">Choose month</option><option disabled>Unavailable</option>
        <option value="month-02">February</option></select></label>
      <label>Day<select name="day" required>
        <option value="">Choose day</option><option value="day-03">3</option></select></label>
      <label>Year<select name="year" required>
        <option value="">Choose year</option><option value="year-2000">2000</option></select></label>
      <button>Continue</button></form>
      <script>for (const type of ['input', 'change']) {
        document.querySelector('form').addEventListener(type, event => {
          document.body.dataset.events = (document.body.dataset.events || '') + event.target.name + ':' + type + ',';
        });
      }</script>`);
      await expect(discoverCredentialForm(service)).rejects.toMatchObject({ statusCode: 404 });
      const { sessionId, secret, publicServer, internal, upstream } = await formGateway();
      try {
        await new Promise<void>((resolve) => publicServer.listen(0, "127.0.0.1", resolve));
        await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${publicServer.address().port}`;
        let token = mintCapability({ sessionId, expiresAt: Date.now() + 60_000 }, secret);
        if (mode !== "viewer") {
          const prepared = await fetch(
            `http://127.0.0.1:${
              internal.address().port
            }/v1/sessions/${sessionId}/credential-handoff`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                selected
                  ? await selection(['[name="month"]', '[name="day"]', '[name="year"]'])
                  : { discover: true },
              ),
            },
          );
          expect(prepared.status).toBe(200);
          const body = await prepared.json();
          token = new URL(body.viewer_url).pathname.slice(3);
        }
        const discovered = await fetch(`${base}/credentials/${token}`);
        expect(discovered.status).toBe(200);
        const handoff = await discovered.json();
        expect(
          handoff.fields.map(({ label, inputType }: { label: string; inputType: string }) => [
            label,
            inputType,
          ]),
        ).toEqual([
          ...(selected ? [] : [["Reference", "text"]]),
          ["Month", "select"],
          ["Day", "select"],
          ["Year", "select"],
        ]);
        expect(
          handoff.fields
            .slice(selected ? 0 : 1)
            .map(({ options }: { options: unknown }) => options),
        ).toEqual([
          [{ value: "2", label: "February" }],
          [{ value: "1", label: "3" }],
          [{ value: "1", label: "2000" }],
        ]);
        if (selected) {
          const rejected = await fetch(`${base}/credential-fills/${handoff.handoffId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              values: { f0: "2", f1: "1", f2: "1", f3: "outside-selection" },
            }),
          });
          expect(rejected.status).toBe(400);
        }
        const filled = await fetch(`${base}/credential-fills/${handoff.handoffId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            values: selected
              ? { f0: "2", f1: "1", f2: "1" }
              : { f0: "synthetic-reference", f1: "2", f2: "1", f3: "1" },
            submit: true,
          }),
        });
        expect(filled.status).toBe(200);
        expect(await filled.json()).toEqual({ ok: true, submitted: false });
        expect(
          await page.$$eval("select", (selects) => selects.map((select) => select.value)),
        ).toEqual(["month-02", "day-03", "year-2000"]);
        expect(await page.evaluate(() => document.body.dataset.events)).toBe(
          (selected ? "" : "reference:input,reference:change,") +
            "month:input,month:change,day:input,day:change,year:input,year:change,",
        );
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
        if (selected) {
          expect(await page.$eval("input", (input) => input.value)).toBe("");
          expect((await fetch(`${base}/credentials/${token}`)).status).toBe(404);
        }
      } finally {
        publicServer.closeAllConnections();
        internal.closeAllConnections();
        upstream.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => publicServer.close(resolve)),
          new Promise<void>((resolve) => internal.close(resolve)),
          new Promise<void>((resolve) => upstream.close(() => resolve())),
        ]);
      }
    },
  );

  it.each(["automatic", "selected"])(
    "opens a %s login handoff and submits its bound fields through the viewer",
    async (mode) => {
      await load(`<form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'">
        <label>User<input name="user" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button>Login</button></form>`);
      const { sessionId, secret, publicServer, internal, upstream } = await formGateway();
      try {
        await new Promise<void>((resolve) => publicServer.listen(0, "127.0.0.1", resolve));
        await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${publicServer.address().port}`;
        const prepared = await fetch(
          `http://127.0.0.1:${internal.address().port}/v1/sessions/${sessionId}/credential-handoff`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              mode === "selected"
                ? await selection(['input[name="user"]', 'input[name="password"]'])
                : { discover: true },
            ),
          },
        );
        expect(prepared.status).toBe(200);
        const token = new URL((await prepared.json()).viewer_url).pathname.slice(3);
        const opened = await fetch(`${base}/credentials/${token}`);
        expect(opened.status).toBe(200);
        const handoff = await opened.json();
        expect(handoff.kind).toBe("login");
        expect(handoff.fields.map((field) => field.purpose)).toEqual([
          "username",
          "current-password",
        ]);
        const values = { f0: "synthetic-user", f1: "synthetic-password" };
        const filled = await fetch(`${base}/credential-fills/${handoff.handoffId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ values, submit: true }),
        });
        expect(filled.status).toBe(200);
        expect(await filled.json()).toEqual({ ok: true, submitted: true });
        expect(await page.$$eval("input", (inputs) => inputs.map((input) => input.value))).toEqual(
          Object.values(values),
        );
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBe("yes");
        // A form-bound link cannot select a replacement form after navigation.
        await load('<form><input type="password" name="password"><button>Login</button></form>');
        expect((await fetch(`${base}/credentials/${token}`)).ok).toBe(false);
      } finally {
        publicServer.closeAllConnections();
        internal.closeAllConnections();
        upstream.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => publicServer.close(resolve)),
          new Promise<void>((resolve) => internal.close(resolve)),
          new Promise<void>((resolve) => upstream.close(() => resolve())),
        ]);
      }
    },
  );

  it("fills checkbox, radio, and multiple-select choices through field events", async () => {
    await load(`<form>
      <label>Accept terms<input type="checkbox" required></label>
      <label>Updates<input type="checkbox" checked></label>
      <fieldset><legend>Contact method</legend>
        <label>Email<input type="radio" name="contact" value="private-email" required checked></label>
        <label>Phone<input type="radio" name="contact" value="private-phone"></label>
      </fieldset>
      <label>Topics<select multiple required>
        <option value="private-news" selected>News</option><option value="private-events">Events</option>
        <optgroup disabled><option>Disabled</option></optgroup>
      </select></label>
      <button>Save</button></form>
      <script>document.querySelector('form').addEventListener('change',()=>{
        document.body.dataset.changes=String(Number(document.body.dataset.changes||0)+1);
      }); document.querySelector('form').addEventListener('click',event=>{
        if(event.target.matches('input')) document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1);
      })</script>`);
    const target = await discoverCredentialForm(service, "all");
    expect(target.fields.map((field) => field.label)).toEqual([
      "Accept terms",
      "Updates",
      "Contact method",
      "Topics: News",
      "Topics: Events",
    ]);
    expect(JSON.stringify(target)).not.toContain("private-");
    expect(target.fields[0].options).toEqual([{ value: "1", label: "Yes" }]);
    expect(target.fields[2].options).toEqual([
      { value: "0", label: "Email" },
      { value: "1", label: "Phone" },
    ]);
    for (const values of [
      { f0: "0", f1: "0", f2: "1", f3: "0", f4: "1" },
      { f0: "1", f1: "0", f2: "2", f3: "0", f4: "1" },
      { f0: "1", f1: "0", f2: "1", f3: "0", f4: "0" },
    ]) {
      await expect(fillCredentialForm(service, target, { values })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(await page.evaluate(() => document.body.dataset.changes)).toBeUndefined();
    }
    expect(
      await fillCredentialForm(service, target, {
        values: { f0: "1", f1: "0", f2: "1", f3: "0", f4: "1" },
      }),
    ).toEqual({ submitted: false });
    expect(await page.$$eval("input", (inputs) => inputs.map((input) => input.checked))).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(
      await page.$eval("select", (select) =>
        Array.from(select.selectedOptions).map((option) => option.value),
      ),
    ).toEqual(["private-events"]);
    expect(await page.evaluate(() => document.body.dataset.changes)).toBe("5");
    expect(await page.evaluate(() => document.body.dataset.clicks)).toBe("3");
    expect(await getCredentialContinuation(service)).toMatchObject({ kind: "details" });
  });

  it("clears optional fields and preserves omitted fields", async () => {
    await load(
      '<form><input name="clear" value="draft"><input name="keep" value="keep"><button>Save</button></form>',
    );
    const target = await discoverCredentialForm(service, "all");
    await fillCredentialForm(service, target, { values: { f0: "" } });
    expect(await page.$$eval("input", (inputs) => inputs.map((input) => input.value))).toEqual([
      "",
      "keep",
    ]);
  });

  it("binds externally associated controls and form-less fields", async () => {
    for (const body of [
      '<form id="feedback"><button>Send</button></form><label>Message<textarea form="feedback" required></textarea></label>',
      "<div><label>Message<textarea required></textarea></label><button>Send</button></div>",
    ]) {
      await load(body);
      const target = await discoverCredentialForm(service, "all");
      expect(target.fields).toMatchObject([{ label: "Message", inputType: "textarea" }]);
      await fillCredentialForm(service, target, { values: { f0: "Feedback" } });
      expect(await page.$eval("textarea", (input) => input.value)).toBe("Feedback");
    }
  });

  it("rejects changed choice semantics before filling another field", async () => {
    for (const mutation of ["multiple", "option", "required"] as const) {
      await load(
        '<form><input name="message"><select multiple><option>One</option><option>Two</option></select><button>Save</button></form>',
      );
      const target = await discoverCredentialForm(service, "all");
      await page.$eval(
        "select",
        (select, mutation) => {
          if (mutation === "multiple") select.multiple = false;
          if (mutation === "option") select.options[0].label = "Changed";
          if (mutation === "required") select.required = true;
        },
        mutation,
      );
      await expect(
        fillCredentialForm(service, target, { values: { f0: "Private", f1: "1" } }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await page.$eval("input", (input) => input.value)).toBe("");
    }
  });
  it("limits the selected handoff fields rather than ordinary checkout fields", async () => {
    await load(`<form>${Array.from(
      { length: 41 },
      (_, i) => `<label>Shipping detail ${i}<input name="detail${i}"></label>`,
    ).join("")}
      <label>Card number<input autocomplete="cc-number"></label><button>Pay</button></form>`);
    const target = await discoverCredentialForm(service);
    expect(target.fields.map((field) => field.purpose)).toEqual(["cc-number"]);
    await expect(discoverCredentialForm(service, "all")).rejects.toMatchObject({ statusCode: 404 });
  });
});
