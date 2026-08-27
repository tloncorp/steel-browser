import type { Frame, Page } from "puppeteer-core";
import type { CDPService } from "./cdp/cdp.service.js";

export interface CredentialFormDescription {
  pageId: string;
  frameUrl: string;
  origin: string;
  hasUsername: boolean;
}

export interface CredentialFormTarget {
  pageId: string;
  frameUrl: string;
  origin: string;
}

export interface CredentialFormValues {
  username?: string;
  password: string;
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

async function inspectFrame(page: Page, frame: Frame): Promise<LocatedCredentialForm | undefined> {
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
      const password = inputs.find((input) => input.type.toLowerCase() === "password");
      if (!password) return undefined;

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
      return { hasUsername: Boolean(explicit ?? named ?? preceding.at(-1) ?? candidates.at(-1)) };
    })
    .catch(() => undefined);
  if (!description) return undefined;

  return {
    pageId: pageId(page),
    frameUrl,
    origin,
    hasUsername: description.hasUsername,
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

  for (const page of candidates) {
    const frames = target
      ? page.frames().filter((frame) => frame.url() === target.frameUrl)
      : page.frames();
    for (const frame of frames) {
      const located = await inspectFrame(page, frame);
      if (!located) continue;
      if (target && located.origin !== target.origin) {
        throw new CredentialFormError("The credential form changed origin.", 409);
      }
      return located;
    }
  }

  throw new CredentialFormError(
    target ? "The credential form is no longer available." : "No visible password form was found.",
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
): Promise<{ filledUsername: boolean; submitted: boolean }> {
  const located = await locateCredentialForm(cdpService, target);
  if (located.hasUsername && values.username === undefined) {
    throw new CredentialFormError("This credential form also requires a username.", 400);
  }

  const result = await located.frame.evaluate(({ username, password, submit }) => {
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
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(visible);
    const passwordInput = inputs.find((input) => input.type.toLowerCase() === "password");
    if (!passwordInput) return { status: "missing" as const };

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
          Boolean(input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING),
        )
        .at(-1) ??
      candidates.at(-1);

    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("Browser input setter unavailable");
      input.focus();
      setter.call(input, value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    };

    if (username !== undefined && usernameInput) setValue(usernameInput, username);
    setValue(passwordInput, password);

    let submitted = false;
    if (submit) {
      const form = passwordInput.form;
      if (form) {
        form.requestSubmit();
        submitted = true;
      } else {
        const submitControl = document.querySelector<HTMLElement>(
          'button[type="submit"], input[type="submit"]',
        );
        if (submitControl) {
          submitControl.click();
          submitted = true;
        }
      }
    }

    return {
      status: "filled" as const,
      filledUsername: Boolean(username !== undefined && usernameInput),
      submitted,
    };
  }, values);

  if (result.status !== "filled") {
    throw new CredentialFormError("The credential form changed before it could be filled.", 409);
  }
  return { filledUsername: result.filledUsername, submitted: result.submitted };
}
