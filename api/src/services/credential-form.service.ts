import type { ElementHandle, Frame, JSHandle, Page } from "puppeteer-core";
import type { CDPService } from "./cdp/cdp.service.js";

interface CredentialFormBase {
  pageId: string;
  frameUrl: string;
  origin: string;
}

export type CredentialFormDescription = CredentialFormBase &
  (
    | {
        kind: "password";
        hasUsername: boolean;
      }
    | {
        kind: "otp";
        codeLength?: number;
      }
  );

export interface CredentialFormTarget extends CredentialFormBase {
  kind: "password" | "otp";
}

export interface CredentialFormValues {
  username?: string;
  password?: string;
  code?: string;
  submit?: boolean;
}

export class CredentialFormError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

type LocatedCredentialForm = CredentialFormDescription & {
  frame: Frame;
};

export interface CredentialContinuation extends CredentialFormTarget {
  expiresAt: number;
  submissionAttempted: boolean;
}

// The receipt lives outside the page. Page scripts cannot grant permission to
// continue a login, and navigating/replacing/clearing the filled field revokes it.
const continuations = new WeakMap<
  CDPService,
  {
    receipt: CredentialContinuation;
    anchor: ElementHandle<HTMLInputElement>;
    timer: ReturnType<typeof setTimeout>;
  }
>();

async function clearContinuation(cdpService: CDPService): Promise<void> {
  const state = continuations.get(cdpService);
  if (!state) return;
  continuations.delete(cdpService);
  clearTimeout(state.timer);
  await state.anchor.dispose().catch(() => {});
}

export async function getCredentialContinuation(
  cdpService: CDPService,
): Promise<CredentialContinuation | null> {
  const state = continuations.get(cdpService);
  if (!state) return null;
  const valid =
    Date.now() < state.receipt.expiresAt &&
    (await state.anchor
      .evaluate(
        (input, target) =>
          input.isConnected &&
          input.value.length > 0 &&
          location.href === target.frameUrl &&
          location.origin === target.origin,
        state.receipt,
      )
      .catch(() => false));
  if (!valid) {
    await clearContinuation(cdpService);
    return null;
  }
  return { ...state.receipt };
}

/** Click one unambiguous login control through the browser's input pipeline. */
async function activateCredentialControl(
  anchor: ElementHandle<HTMLInputElement>,
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  do {
    const handle = await anchor.evaluateHandle((input) => {
      if (!input.isConnected) return null;
      const visible = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility === "visible" &&
          !element.closest('[inert], [aria-hidden="true"]')
        );
      };
      const isLogin = (element: HTMLElement) =>
        /^(?:log\s*in|sign\s*in|continue|next|verify|submit)(?:\s|$)/i.test(
          element.getAttribute("aria-label") ||
            element.textContent ||
            (element as HTMLInputElement).value ||
            "",
        ) &&
        !/\b(?:with|google|apple|facebook|register|sign\s*up)\b/i.test(element.textContent || "");
      const form = input.form;
      let candidates: HTMLElement[];
      if (form) {
        candidates = Array.from(
          document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input"),
        ).filter(
          (control) => control.form === form && control.type === "submit" && visible(control),
        );
        if (!candidates.length) {
          candidates = Array.from(
            form.querySelectorAll<HTMLElement>('button, [role="button"]'),
          ).filter((control) => visible(control) && isLogin(control));
        }
      } else {
        candidates = [];
        for (
          let group = input.parentElement;
          group && group !== document.body;
          group = group.parentElement
        ) {
          candidates = Array.from(
            group.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]'),
          ).filter((control) => visible(control) && isLogin(control));
          if (candidates.length) break;
        }
      }
      if (candidates.length !== 1) return null;
      const control = candidates[0];
      const label =
        control.getAttribute("aria-label") ||
        control.textContent ||
        (control as HTMLInputElement).value ||
        "";
      if (
        /\b(?:buy|purchase|pay|delete|remove|save|change|reset|register|create|subscribe|transfer|order)\b|sign\s*up/i.test(
          label,
        )
      )
        return null;
      if (control.matches(':disabled, [aria-disabled="true"]')) return null;
      if (form) {
        const action =
          control.getAttribute("formaction") || form.getAttribute("action") || location.href;
        if (new URL(action, document.baseURI).origin !== location.origin) return null;
      }
      return control;
    });
    try {
      const control = handle.asElement() as ElementHandle<HTMLElement> | null;
      if (control) {
        await control.scrollIntoView();
        const reachable = await control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return (
            element.isConnected &&
            !element.matches(':disabled, [aria-disabled="true"]') &&
            (hit === element || (hit !== null && element.contains(hit)))
          );
        });
        if (reachable) {
          await control.click();
          return true;
        }
      }
    } finally {
      await handle.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}

function pageId(page: Page): string {
  return (page.target() as unknown as { _targetId: string })._targetId;
}

function httpOrigin(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

async function inspectFrame(
  page: Page,
  frame: Frame,
  requestedKind?: "password" | "otp",
): Promise<LocatedCredentialForm | undefined> {
  const frameUrl = frame.url();
  const origin = httpOrigin(frameUrl);
  if (!origin) return undefined;

  const description = await frame
    .evaluate(() => {
      const visible = (input: HTMLInputElement) => {
        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        return (
          !input.disabled &&
          !input.readOnly &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(
        visible,
      );
      const explicitOtp = inputs.find((input) =>
        input.autocomplete.toLowerCase().split(/\s+/).includes("one-time-code"),
      );
      if (explicitOtp) {
        const maxLength = explicitOtp.maxLength;
        return {
          kind: "otp" as const,
          ...(maxLength >= 1 && maxLength <= 12 ? { codeLength: maxLength } : {}),
        };
      }

      const password = inputs.find((input) => input.type.toLowerCase() === "password");

      if (password) {
        const acceptsUsername = (input: HTMLInputElement) => {
          const type = input.type.toLowerCase();
          return type === "text" || type === "email" || type === "tel" || type === "";
        };
        const candidates = inputs.filter(
          (input) =>
            input !== password &&
            acceptsUsername(input) &&
            (!password.form || input.form === password.form),
        );
        const explicit = candidates.find((input) => {
          const autocomplete = input.autocomplete.toLowerCase();
          return autocomplete === "username" || autocomplete === "email";
        });
        const named = candidates.find((input) =>
          /(?:user|email|login|account)/i.test(`${input.name} ${input.id}`),
        );
        const preceding = candidates.filter((input) => {
          const position = input.compareDocumentPosition(password);
          return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        return {
          kind: "password" as const,
          hasUsername: Boolean(explicit ?? named ?? preceding.at(-1) ?? candidates.at(-1)),
        };
      }

      const acceptsCode = (input: HTMLInputElement) => {
        const type = input.type.toLowerCase();
        return type === "text" || type === "tel" || type === "number" || type === "";
      };
      const codeInputs = inputs.filter(acceptsCode);
      const otpWords =
        /(?:one[\s_-]*time|verification|security|auth(?:entication)?[\s_-]*code|otp|2fa|two[\s_-]*factor|passcode|login[\s_-]*code|\bcode\b)/i;
      const inputText = (input: HTMLInputElement) => {
        const labels = Array.from(input.labels ?? [])
          .map((label) => label.textContent ?? "")
          .join(" ");
        return `${input.autocomplete} ${input.name} ${input.id} ${
          input.getAttribute("aria-label") ?? ""
        } ${input.placeholder} ${labels}`;
      };
      const namedCode = codeInputs.find((input) => otpWords.test(inputText(input)));
      const singleCode = namedCode;
      if (singleCode) {
        const maxLength = singleCode.maxLength;
        return {
          kind: "otp" as const,
          ...(maxLength >= 1 && maxLength <= 12 ? { codeLength: maxLength } : {}),
        };
      }

      const groups = new Map<HTMLFormElement | null, HTMLInputElement[]>();
      for (const input of codeInputs) {
        if (input.maxLength !== 1) continue;
        const group = groups.get(input.form) ?? [];
        group.push(input);
        groups.set(input.form, group);
      }
      for (const [form, group] of groups) {
        if (group.length < 4 || group.length > 8) continue;
        const context = `${form?.textContent ?? ""} ${group.map(inputText).join(" ")}`;
        if (otpWords.test(context)) {
          return { kind: "otp" as const, codeLength: group.length };
        }
      }
      return undefined;
    })
    .catch(() => undefined);
  if (!description) return undefined;

  if (requestedKind && description.kind !== requestedKind) return undefined;

  return {
    pageId: pageId(page),
    frameUrl,
    origin,
    ...description,
    frame,
  };
}

async function locateCredentialForm(
  cdpService: CDPService,
  target?: CredentialFormTarget,
): Promise<LocatedCredentialForm> {
  const pages = await cdpService.getAllPages();
  const candidates = target
    ? pages.filter((page) => pageId(page) === target.pageId)
    : [...pages].reverse();

  let otpCandidate: LocatedCredentialForm | undefined;
  for (const page of candidates) {
    const frames = target
      ? page.frames().filter((frame) => frame.url() === target.frameUrl)
      : page.frames();
    for (const frame of frames) {
      const located = await inspectFrame(page, frame, target?.kind);
      if (!located) continue;
      if (target && located.origin !== target.origin) {
        throw new CredentialFormError("The credential form changed origin.", 409);
      }
      if (target || located.kind === "password") return located;
      otpCandidate ??= located;
    }
  }

  if (otpCandidate) return otpCandidate;

  throw new CredentialFormError(
    target
      ? "The credential form is no longer available."
      : "No visible password or one-time-code form was found.",
    target ? 409 : 404,
  );
}

export async function discoverCredentialForm(
  cdpService: CDPService,
): Promise<CredentialFormDescription> {
  const { frame: _frame, ...description } = await locateCredentialForm(cdpService);
  return description;
}

export async function fillCredentialForm(
  cdpService: CDPService,
  target: CredentialFormTarget,
  values: CredentialFormValues,
): Promise<{ filledUsername?: boolean; submitted: boolean }> {
  const located = await locateCredentialForm(cdpService, target);
  if (located.kind !== target.kind) {
    throw new CredentialFormError("The credential form changed before it could be filled.", 409);
  }
  if (located.kind === "password" && located.hasUsername && values.username === undefined) {
    throw new CredentialFormError("This credential form also requires a username.", 400);
  }
  if (located.kind === "password" && !values.password) {
    throw new CredentialFormError("A password is required for this credential form.", 400);
  }
  if (located.kind === "otp" && !values.code) {
    throw new CredentialFormError("A one-time code is required for this credential form.", 400);
  }
  if (located.kind === "otp" && located.codeLength && values.code?.length !== located.codeLength) {
    throw new CredentialFormError(
      `This credential form requires a ${located.codeLength}-character code.`,
      400,
    );
  }

  await clearContinuation(cdpService);
  const resultHandle = (await located.frame.evaluateHandle(
    ({ kind, username, password, code }) => {
      const visible = (input: HTMLInputElement) => {
        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        return (
          !input.disabled &&
          !input.readOnly &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(
        visible,
      );
      const setValue = (input: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) throw new Error("Browser input setter unavailable");
        input.focus();
        setter.call(input, value);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
      };

      let anchor: HTMLInputElement | undefined;
      let filledUsername = false;
      if (kind === "password") {
        const passwordInput = inputs.find((input) => input.type.toLowerCase() === "password");
        if (!passwordInput || password === undefined) return { status: "missing" as const };
        const acceptsUsername = (input: HTMLInputElement) => {
          const type = input.type.toLowerCase();
          return type === "text" || type === "email" || type === "tel" || type === "";
        };
        const candidates = inputs.filter(
          (input) =>
            input !== passwordInput &&
            acceptsUsername(input) &&
            (!passwordInput.form || input.form === passwordInput.form),
        );
        const usernameInput =
          candidates.find((input) => {
            const autocomplete = input.autocomplete.toLowerCase();
            return autocomplete === "username" || autocomplete === "email";
          }) ??
          candidates.find((input) =>
            /(?:user|email|login|account)/i.test(`${input.name} ${input.id}`),
          ) ??
          candidates
            .filter((input) =>
              Boolean(
                input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING,
              ),
            )
            .at(-1) ??
          candidates.at(-1);
        if (username !== undefined && usernameInput) {
          setValue(usernameInput, username);
          filledUsername = true;
        }
        setValue(passwordInput, password);
        anchor = passwordInput;
      } else {
        if (code === undefined) return { status: "missing" as const };
        const acceptsCode = (input: HTMLInputElement) => {
          const type = input.type.toLowerCase();
          return (
            type === "text" ||
            type === "tel" ||
            type === "number" ||
            type === "" ||
            input.autocomplete.toLowerCase().split(/\s+/).includes("one-time-code")
          );
        };
        const codeInputs = inputs.filter(acceptsCode);
        const otpWords =
          /(?:one[\s_-]*time|verification|security|auth(?:entication)?[\s_-]*code|otp|2fa|two[\s_-]*factor|passcode|login[\s_-]*code|\bcode\b)/i;
        const inputText = (input: HTMLInputElement) =>
          `${input.autocomplete} ${input.name} ${input.id} ${
            input.getAttribute("aria-label") ?? ""
          } ${input.placeholder} ${Array.from(input.labels ?? [])
            .map((label) => label.textContent ?? "")
            .join(" ")}`;
        const singleCode =
          codeInputs.find((input) =>
            input.autocomplete.toLowerCase().split(/\s+/).includes("one-time-code"),
          ) ?? codeInputs.find((input) => otpWords.test(inputText(input)));
        if (singleCode) {
          setValue(singleCode, code);
          anchor = singleCode;
        } else {
          const groups = new Map<HTMLFormElement | null, HTMLInputElement[]>();
          for (const input of codeInputs) {
            if (input.maxLength !== 1) continue;
            const group = groups.get(input.form) ?? [];
            group.push(input);
            groups.set(input.form, group);
          }
          const group = Array.from(groups).find(([form, fields]) => {
            if (fields.length < 4 || fields.length > 8) return false;
            const context = `${form?.textContent ?? ""} ${fields.map(inputText).join(" ")}`;
            return otpWords.test(context);
          })?.[1];
          if (!group || group.length !== code.length) return { status: "missing" as const };
          group.forEach((input, index) => setValue(input, code[index]));
          anchor = group.at(-1);
        }
      }

      return {
        status: "filled" as const,
        filledUsername,
        anchor,
      };
    },
    { kind: target.kind, ...values },
  )) as JSHandle<{
    status: "missing" | "filled";
    filledUsername?: boolean;
    anchor?: HTMLInputElement;
  }>;

  const result = await resultHandle.evaluate((value) => ({
    status: value.status,
    filledUsername: value.status === "filled" && value.filledUsername,
  }));
  if (result.status !== "filled") {
    await resultHandle.dispose();
    throw new CredentialFormError("The credential form changed before it could be filled.", 409);
  }
  const anchorHandle = await resultHandle.getProperty("anchor");
  const anchor = anchorHandle.asElement() as ElementHandle<HTMLInputElement>;
  await resultHandle.dispose();
  if (values.submit !== true) {
    await anchor.dispose();
    return {
      ...(located.kind === "password" ? { filledUsername: result.filledUsername } : {}),
      submitted: false,
    };
  }
  const receipt: CredentialContinuation = {
    ...target,
    expiresAt: Date.now() + 5 * 60_000,
    submissionAttempted: false,
  };
  const timer = setTimeout(() => {
    void clearContinuation(cdpService);
  }, 5 * 60_000);
  timer.unref();
  continuations.set(cdpService, { receipt, anchor, timer });
  // Filling does not prove authentication. An actual click is only an attempt;
  // MCP inspects the resulting page and continues or requests the next input.
  const submitted =
    values.submit === true && (await activateCredentialControl(anchor).catch(() => false));
  receipt.submissionAttempted = submitted;
  return {
    ...(located.kind === "password" ? { filledUsername: result.filledUsername } : {}),
    submitted,
  };
}
