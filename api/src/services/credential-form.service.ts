import { randomUUID } from "node:crypto";
import {
  recordBrowserForm,
  recordBrowserFill,
  recordBrowserFillFailure,
} from "./browser-monitor.service.js";
import type { CDPSession, ElementHandle, Frame, JSHandle, Page } from "puppeteer-core";
import type { CDPService } from "./cdp/cdp.service.js";
import { secureFieldDefinitions, type SecureFormField } from "./secure-form-fields.js";

export interface CredentialFormTarget {
  formId: string;
  pageId: string;
  frameUrl: string;
  origin: string;
  kind: "login" | "details";
}
export interface CredentialFormDescription extends CredentialFormTarget {
  fields: SecureFormField[];
}
export interface CredentialFormValues {
  values: Record<string, string>;
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

export interface CredentialContinuation extends CredentialFormTarget {
  anchorBackendNodeId: number;
  expiresAt: number;
  submissionAttempted: boolean;
}
type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const continuations = new WeakMap<
  CDPService,
  {
    receipt: CredentialContinuation;
    anchor: ElementHandle<FormControl>;
    bound: JSHandle<BoundForm>;
    filledIds: string[];
    timer: ReturnType<typeof setTimeout>;
  }
>();
async function clearContinuation(cdpService: CDPService): Promise<void> {
  const state = continuations.get(cdpService);
  if (!state) return;
  continuations.delete(cdpService);
  clearTimeout(state.timer);
  await Promise.all([
    state.anchor.dispose().catch(() => {}),
    state.bound.dispose().catch(() => {}),
  ]);
}
export async function getCredentialContinuation(
  cdpService: CDPService,
): Promise<CredentialContinuation | null> {
  const state = continuations.get(cdpService);
  if (!state) return null;
  const valid =
    Date.now() < state.receipt.expiresAt &&
    (await state.bound
      .evaluate(
        (form, target, filledIds) =>
          location.href === target.frameUrl &&
          location.origin === target.origin &&
          form.controls.every(
            ({ input, form, attributes, action }) =>
              input.isConnected &&
              input.form === form &&
              input.form?.action === action &&
              JSON.stringify(
                [
                  "type",
                  "name",
                  "id",
                  "autocomplete",
                  "maxlength",
                  "required",
                  "pattern",
                  "form",
                  "multiple",
                  "min",
                  "max",
                  "step",
                ].map((name) => input.getAttribute(name)),
              ) === attributes,
          ) &&
          form.fields
            .filter((field) => filledIds.includes(field.descriptor.id))
            .every(
              (field) =>
                field.choice ||
                field.inputs.every((input) =>
                  input instanceof HTMLSelectElement
                    ? input.selectedIndex >= 0
                    : input.value.length > 0,
                ),
            ),
        state.receipt,
        state.filledIds,
      )
      .catch(() => false));
  if (!valid) {
    if (continuations.get(cdpService) === state) await clearContinuation(cdpService);
    return null;
  }
  return { ...state.receipt };
}
/** Click one unambiguous login control through the browser's input pipeline. */
async function activateCredentialControl(anchor: ElementHandle<FormControl>): Promise<boolean> {
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
          const root = element.getRootNode() as Document | ShadowRoot;
          const hit = root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
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

type BoundField = {
  descriptor: SecureFormField;
  inputs: FormControl[];
  choice?: "checkbox" | "radio" | "option";
  optionIndex?: number;
};
type BoundForm = {
  kind: "login" | "details";
  focused: boolean;
  primary: boolean;
  fields: BoundField[];
  controls: Array<{
    input: FormControl;
    form: HTMLFormElement | null;
    attributes: string;
    action?: string;
    options?: string;
  }>;
};
type LocatedCredentialForm = {
  description: CredentialFormDescription;
  frame: Frame;
  handle: JSHandle<BoundForm>;
  timer: ReturnType<typeof setTimeout>;
};
const forms = new WeakMap<CDPService, LocatedCredentialForm>();

/** Runs in the document; nothing here reads or returns the controls' values. */
function inspectDocument(definitions: typeof secureFieldDefinitions): BoundForm | null {
  const all = (root: Document | ShadowRoot): Element[] =>
    Array.from(root.querySelectorAll("*")).flatMap((element) => [
      element,
      ...(element.shadowRoot ? all(element.shadowRoot) : []),
    ]);
  const elements = all(document);
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const visible = (input: FormControl) => {
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    return (
      input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      !input.disabled &&
      !("readOnly" in input && input.readOnly) &&
      style.visibility === "visible" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0 &&
      !input.closest('[inert], [aria-hidden="true"]')
    );
  };
  const labelText = (element: Element | null) => {
    if (!element || element.matches("input, textarea, select, script, style")) return "";
    const copy = element.cloneNode(true) as Element;
    copy
      .querySelectorAll("input, textarea, select, script, style")
      .forEach((child) => child.remove());
    return copy.textContent || "";
  };
  const text = (input: FormControl) =>
    [
      input.name,
      input.id,
      input.getAttribute("aria-label") || "",
      input.getAttribute("placeholder") || "",
      ...Array.from(input.labels || []).map((label) => label.textContent || ""),
    ]
      .map((value) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "))
      .join(" ");
  const label = (input: FormControl) => {
    const root = input.getRootNode() as Document | ShadowRoot;
    const labelledBy = (input.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => labelText(root.getElementById(id)))
      .join(" ")
      .trim();
    return (
      labelledBy ||
      input.getAttribute("aria-label") ||
      Array.from(input.labels || [])
        .map(labelText)
        .join(" ")
        .trim() ||
      input.getAttribute("placeholder") ||
      input.name ||
      input.id ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  };
  const otpWords = new RegExp(
    definitions.find((field) => field.purpose === "one-time-code")!.pattern!,
    "i",
  );
  const loginWords = /\blog\s*in\b|\bsign\s*in\b|\bauthenticate\b|\byour account\b/i;
  const inputs = elements
    .filter(
      (element): element is FormControl =>
        (element instanceof HTMLInputElement &&
          !["hidden", "file", "button", "submit", "reset", "image"].includes(element.type)) ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement,
    )
    .filter(visible);
  const groups = new Map<Element, FormControl[]>();
  for (const input of inputs) {
    let scope: Element | null = input.form;
    if (!scope) {
      scope = input.parentElement;
      while (
        scope?.parentElement &&
        scope !== document.body &&
        !scope.querySelector('button, [role="button"], input[type="submit"]')
      )
        scope = scope.parentElement;
    }
    if (!scope) continue;
    const group = groups.get(scope) || [];
    group.push(input);
    groups.set(scope, group);
  }
  const matches: BoundForm[] = [];
  for (const [scope, group] of groups) {
    const context = [
      scope.textContent || "",
      ...Array.from(
        scope.querySelectorAll('button, [role="button"], input[type="submit"], label, h1, h2'),
      ).map((element) => element.textContent || element.getAttribute("value") || ""),
    ].join(" ");
    const pageContext = `${document.title} ${elements
      .filter((el) => el.matches('h1,h2,[role="heading"]'))
      .map((el) => el.textContent)
      .join(" ")} ${location.pathname}`;
    const submitLabels = Array.from(
      scope.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]'),
    ).map(
      (control) =>
        control.getAttribute("aria-label") ||
        control.textContent ||
        control.getAttribute("value") ||
        "",
    );
    const nonLoginAction =
      /\bsubscribe\b|newsletter|\bsign\s*up\b|\bregister\b|create (?:an? )?account|reset password/i;
    // Login forms commonly contain Sign up / Forgot password links. Their
    // presence does not change the purpose of the form's submit control.
    const isNonLogin =
      submitLabels.length > 0 && submitLabels.every((label) => nonLoginAction.test(label));
    const hasLoginContext = !isNonLogin && loginWords.test(`${context} ${pageContext}`);
    const explicitPurpose = (input: FormControl) => {
      const tokens = input.autocomplete.toLowerCase().split(/\s+/);
      return definitions.find((definition) => tokens.includes(definition.purpose));
    };
    const hasDetails =
      group.some((input) => {
        const purpose = explicitPurpose(input)?.purpose;
        return purpose && /^(?:cc-|address-|street-address|postal-code|country)/.test(purpose);
      }) || /\bshipping\b|\bbilling\b|\bcard number\b|\bstreet address\b/i.test(context);
    const passwords = group.filter(
      (input) =>
        input instanceof HTMLInputElement &&
        input.type === "password" &&
        !["one-time-code", "cc-csc"].includes(explicitPurpose(input)?.purpose || ""),
    );
    const split = group.filter(
      (input): input is HTMLInputElement =>
        input instanceof HTMLInputElement &&
        ["text", "tel", "number"].includes(input.type) &&
        input.maxLength === 1,
    );
    const splitCode =
      split.length >= 4 &&
      split.length <= 8 &&
      !hasDetails &&
      (otpWords.test(`${context} ${pageContext}`) ||
        split.some((input) => explicitPurpose(input)?.purpose === "one-time-code"));
    const fields: BoundField[] = [];
    for (const input of group) {
      if (fields.some((field) => field.inputs.includes(input))) continue;
      if (splitCode && split.includes(input as HTMLInputElement) && input !== split[0]) continue;
      const fieldLabel = label(input) || `Field ${fields.length + 1}`;
      const yesNo = [
        { value: "0", label: "No" },
        { value: "1", label: "Yes" },
      ];
      if (input instanceof HTMLInputElement && ["checkbox", "radio"].includes(input.type)) {
        const radio = input.type === "radio";
        const choices =
          radio && input.name
            ? group.filter(
                (other) =>
                  other instanceof HTMLInputElement &&
                  other.type === "radio" &&
                  other.name === input.name &&
                  other.form === input.form &&
                  other.getRootNode() === input.getRootNode(),
              )
            : [input];
        const required = choices.some((choice) => choice.required);
        const legend = labelText(input.closest("fieldset")?.querySelector("legend") || null).trim();
        fields.push({
          inputs: choices,
          choice: radio ? "radio" : "checkbox",
          descriptor: {
            id: `f${fields.length}`,
            purpose: "field",
            label: (radio ? legend || input.name || fieldLabel : fieldLabel).slice(0, 256),
            inputType: "select",
            required,
            options: radio
              ? choices.map((choice, index) => ({
                  value: String(index),
                  label: (label(choice) || `Option ${index + 1}`).slice(0, 256),
                }))
              : required
              ? [yesNo[1]]
              : yesNo,
          },
        });
        continue;
      }
      if (input instanceof HTMLSelectElement && input.multiple) {
        // Each option is an independent choice in the string-valued handoff contract.
        Array.from(input.options).forEach((option, optionIndex) => {
          if (option.disabled || option.parentElement?.matches("optgroup[disabled]")) return;
          fields.push({
            inputs: [input],
            choice: "option",
            optionIndex,
            descriptor: {
              id: `f${fields.length}`,
              purpose: "field",
              label: `${fieldLabel}: ${option.label}`.slice(0, 256),
              inputType: "select",
              required: false,
              options: yesNo,
            },
          });
        });
        continue;
      }
      let definition = explicitPurpose(input);
      if (!definition && splitCode && input === split[0])
        definition = definitions.find((field) => field.purpose === "one-time-code");
      if (!definition) {
        // Heuristics resolve a semantic purpose, never a site-specific selector.
        // Identity fields need a login context; other fields need an address/card context.
        const candidates = definitions.filter((field) => {
          if (!("pattern" in field)) return false;
          if (field.purpose === "username")
            return !hasDetails && (hasLoginContext || passwords.length === 1);
          if (field.purpose === "one-time-code") return !hasDetails;
          return hasDetails;
        });
        definition =
          candidates.find(
            (field) =>
              field.purpose === "one-time-code" &&
              "pattern" in field &&
              new RegExp(field.pattern, "i").test(text(input)),
          ) ??
          candidates.find(
            (field) => "pattern" in field && new RegExp(field.pattern, "i").test(text(input)),
          );
      }
      if (!definition && input instanceof HTMLInputElement && input.type === "password")
        definition = definitions.find((field) => field.purpose === "current-password");
      if (!definition && passwords.length === 1 && !hasDetails) {
        const textInputs = group.filter(
          (candidate) =>
            candidate instanceof HTMLInputElement &&
            ["text", "email", "tel"].includes(candidate.type),
        );
        if (textInputs.length === 1 && textInputs[0] === input)
          definition = definitions.find((field) => field.purpose === "username");
      }
      if (
        !hasDetails &&
        (hasLoginContext || passwords.length) &&
        definition &&
        ["email", "tel"].includes(definition.purpose)
      )
        definition = definitions.find((field) => field.purpose === "username")!;
      const tokens = input.autocomplete.toLowerCase().split(/\s+/);
      const section = tokens.includes("shipping")
        ? "Shipping: "
        : tokens.includes("billing")
        ? "Billing: "
        : "";
      const fieldInputs: FormControl[] = splitCode && input === split[0] ? split : [input];
      const maxLength =
        "maxLength" in input && input.maxLength > 0 ? Math.min(input.maxLength, 4096) : undefined;
      const codeLength =
        definition?.purpose === "one-time-code"
          ? splitCode
            ? split.length
            : maxLength && maxLength <= 12
            ? maxLength
            : undefined
          : undefined;
      const options =
        input instanceof HTMLSelectElement
          ? Array.from(input.options).flatMap((option, index) =>
              option.disabled ||
              (input.required && !option.value) ||
              option.parentElement?.matches("optgroup[disabled]")
                ? []
                : [{ value: String(index), label: option.label.slice(0, 256) }],
            )
          : undefined;
      if (options && (!options.length || options.length > 512)) continue;
      fields.push({
        inputs: fieldInputs,
        descriptor: {
          id: `f${fields.length}`,
          purpose: definition?.purpose || "field",
          label: (section + (label(input) || definition?.label || fieldLabel)).slice(0, 256),
          inputType: options
            ? "select"
            : input instanceof HTMLTextAreaElement
            ? "textarea"
            : definition?.inputType ||
              (input instanceof HTMLInputElement &&
              ["password", "email", "tel"].includes(input.type)
                ? (input.type as "password" | "email" | "tel")
                : "text"),
          required: input.required,
          ...(maxLength && !splitCode ? { maxLength } : {}),
          ...(codeLength ? { exactLength: codeLength } : {}),
          ...(options ? { options } : {}),
        },
      });
    }
    if (!fields.length || fields.length > 40) continue;
    // Optional checkboxes (such as Remember me) do not change a login's purpose.
    const purposes = fields
      .filter((field) => field.choice !== "checkbox" || field.descriptor.required)
      .map((field) => field.descriptor.purpose);
    const login =
      purposes.length > 0 &&
      purposes.every((purpose) =>
        ["username", "current-password", "one-time-code"].includes(purpose),
      ) &&
      !isNonLogin &&
      !hasDetails &&
      (hasLoginContext ||
        purposes.includes("current-password") ||
        purposes.includes("one-time-code"));
    // Unsupported required controls keep submission in the live browser.
    const unsupportedRequired = elements.some(
      (input) =>
        (input instanceof HTMLInputElement ||
          input instanceof HTMLSelectElement ||
          input instanceof HTMLTextAreaElement) &&
        (input.form === scope || (!input.form && scope.contains(input))) &&
        visible(input) &&
        input.required &&
        !fields.some((field) => field.inputs.includes(input)),
    );
    const controls = fields.flatMap((field) =>
      field.inputs.map((input) => ({
        input,
        form: input.form,
        attributes: JSON.stringify(
          [
            "type",
            "name",
            "id",
            "autocomplete",
            "maxlength",
            "required",
            "pattern",
            "form",
            "multiple",
            "min",
            "max",
            "step",
          ].map((name) => input.getAttribute(name)),
        ),
        action: input.form?.action,
        options:
          input instanceof HTMLSelectElement
            ? JSON.stringify(
                Array.from(input.options).map((option) => [
                  option.value,
                  option.label,
                  option.disabled,
                  option.parentElement?.matches("optgroup[disabled]"),
                ]),
              )
            : undefined,
      })),
    );
    const kind =
      login && !unsupportedRequired && new Set(purposes).size === purposes.length
        ? "login"
        : "details";
    if (kind === "login")
      fields.forEach((field) => {
        if (!field.choice) field.descriptor.required = true;
      });
    matches.push({
      kind,
      focused: !!active && (group.includes(active as FormControl) || scope.contains(active)),
      primary: !!scope
        .closest(
          'main, aside, nav, header, footer, [role="main"], [role="complementary"], [role="navigation"], [role="banner"], [role="contentinfo"]',
        )
        ?.matches('main, [role="main"]'),
      fields,
      controls,
    });
  }
  const focused = matches.filter((form) => form.focused);
  if (focused.length === 1) return focused[0];
  if (matches.length === 1) return matches[0];
  const primary = matches.filter((form) => form.primary);
  return primary.length === 1 ? primary[0] : null;
}

async function releaseForm(cdpService: CDPService) {
  const current = forms.get(cdpService);
  if (!current) return;
  forms.delete(cdpService);
  clearTimeout(current.timer);
  await current.handle.dispose().catch(() => {});
}

async function discoverBoundForm(cdpService: CDPService): Promise<CredentialFormDescription> {
  const pages = await cdpService.getAllPages();
  for (const page of [...pages].reverse()) {
    const candidates: Array<{
      frame: Frame;
      handle: JSHandle<BoundForm>;
      kind: "login" | "details";
      focused: boolean;
      fields: SecureFormField[];
    }> = [];
    for (const frame of page.frames()) {
      if (!httpOrigin(frame.url())) continue;
      if (frame.parentFrame()) {
        const owner = await frame.frameElement().catch(() => null);
        const visible = await owner
          ?.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              getComputedStyle(element).visibility === "visible"
            );
          })
          .catch(() => false);
        await owner?.dispose();
        if (!visible) continue;
      }
      const handle = (await frame
        .evaluateHandle(inspectDocument, secureFieldDefinitions)
        .catch(() => undefined)) as JSHandle<BoundForm | null> | undefined;
      if (!handle) continue;
      const metadata = await handle
        .evaluate(
          (form) =>
            form && {
              kind: form.kind,
              focused: form.focused,
              fields: form.fields.map((field) => field.descriptor),
            },
        )
        .catch(() => undefined);
      if (metadata) candidates.push({ frame, handle: handle as JSHandle<BoundForm>, ...metadata });
      else await handle.dispose();
    }
    const focused = candidates.filter((candidate) => candidate.focused);
    const selected = focused.length === 1 ? focused : candidates;
    if (selected.length !== 1) {
      await Promise.all(candidates.map((candidate) => candidate.handle.dispose()));
      if (candidates.length > 1) break;
      continue;
    }
    await Promise.all(
      candidates
        .filter((candidate) => candidate !== selected[0])
        .map((candidate) => candidate.handle.dispose()),
    );
    const { frame, handle, fields, kind } = selected[0];
    const previous = forms.get(cdpService);
    const same =
      previous?.frame === frame &&
      previous.description.frameUrl === frame.url() &&
      (await handle
        .evaluate(
          (next, prior) =>
            next.kind === prior.kind &&
            JSON.stringify(next.fields.map((field) => field.descriptor)) ===
              JSON.stringify(prior.fields.map((field) => field.descriptor)) &&
            next.controls.length === prior.controls.length &&
            next.controls.every(
              (control, i) =>
                control.input === prior.controls[i].input &&
                control.form === prior.controls[i].form &&
                control.attributes === prior.controls[i].attributes &&
                control.action === prior.controls[i].action &&
                control.options === prior.controls[i].options,
            ),
          previous.handle,
        )
        .catch(() => false));
    const description: CredentialFormDescription = {
      formId: same ? previous.description.formId : randomUUID(),
      pageId: pageId(page),
      frameUrl: frame.url(),
      origin: httpOrigin(frame.url())!,
      kind,
      fields,
    };
    await releaseForm(cdpService);
    const timer = setTimeout(() => {
      void releaseForm(cdpService);
    }, 5 * 60_000);
    timer.unref();
    forms.set(cdpService, { description, frame, handle, timer });
    return description;
  }
  await releaseForm(cdpService);
  throw new CredentialFormError(
    "No unambiguous supported form was found. Open the browser to continue.",
    404,
  );
}

async function fillBoundForm(
  cdpService: CDPService,
  target: CredentialFormTarget,
  request: CredentialFormValues,
): Promise<{ submitted: boolean }> {
  const located = forms.get(cdpService);
  if (
    !located ||
    ["formId", "pageId", "frameUrl", "origin", "kind"].some(
      (key) =>
        located.description[key as keyof CredentialFormTarget] !==
        target[key as keyof CredentialFormTarget],
    )
  ) {
    throw new CredentialFormError("The form is no longer available. Reconnect to continue.", 409);
  }
  const { values } = request;
  const fields = located.description.fields;
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).some((id) => !fields.some((field) => field.id === id)) ||
    !Object.keys(values).length
  ) {
    throw new CredentialFormError("The submitted fields do not match this form.", 400);
  }
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined || value === "") {
      if (field.required) throw new CredentialFormError("Enter all required fields.", 400);
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length > (field.maxLength ?? 4096) ||
      (field.exactLength !== undefined && value.length !== field.exactLength) ||
      (field.options && !field.options.some((option) => option.value === value))
    )
      throw new CredentialFormError("A field does not match the form's requirements.", 400);
  }
  const choicesValid = await located.handle
    .evaluate(
      (form, values) =>
        form.fields.every(
          (field) =>
            field.choice !== "option" ||
            !field.inputs[0].required ||
            form.fields.some(
              (other) =>
                other.choice === "option" &&
                other.inputs[0] === field.inputs[0] &&
                values[other.descriptor.id] === "1",
            ),
        ),
      values,
    )
    .catch(() => false);
  if (!choicesValid)
    throw new CredentialFormError("Select at least one option in each required field.", 400);
  await clearContinuation(cdpService);
  const anchorHandle = await located.handle
    .evaluateHandle(
      (form, target, values) => {
        const valid = () =>
          location.href === target.frameUrl &&
          location.origin === target.origin &&
          form.controls.every(({ input, form, attributes, action, options }) => {
            const rect = input.getBoundingClientRect();
            return (
              input.isConnected &&
              input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
              !input.disabled &&
              !("readOnly" in input && input.readOnly) &&
              rect.width > 0 &&
              rect.height > 0 &&
              getComputedStyle(input).visibility === "visible" &&
              !input.closest('[inert], [aria-hidden="true"]') &&
              input.form === form &&
              input.form?.action === action &&
              JSON.stringify(
                [
                  "type",
                  "name",
                  "id",
                  "autocomplete",
                  "maxlength",
                  "required",
                  "pattern",
                  "form",
                  "multiple",
                  "min",
                  "max",
                  "step",
                ].map((name) => input.getAttribute(name)),
              ) === attributes &&
              (!(input instanceof HTMLSelectElement) ||
                JSON.stringify(
                  Array.from(input.options).map((option) => [
                    option.value,
                    option.label,
                    option.disabled,
                    option.parentElement?.matches("optgroup[disabled]"),
                  ]),
                ) === options)
            );
          });
        if (!valid()) return null;
        let anchor: FormControl | null = null;
        for (const field of form.fields) {
          const value = values[field.descriptor.id];
          if (value === undefined) continue;
          if (value === "" && field.descriptor.options) continue;
          for (const [index, input] of field.inputs.entries()) {
            // Event handlers can replace another field synchronously. Stop before
            // delivering any value to a replacement or a different destination.
            if (!valid()) return null;
            if (field.choice === "radio" && index !== Number(value)) continue;
            input.focus();
            if (!valid()) return null;
            if (field.choice === "checkbox" || field.choice === "radio") {
              // Checkbox/radio change handlers in controlled forms listen for clicks.
              const control = input as HTMLInputElement;
              const checked = field.choice === "radio" || value === "1";
              if (control.checked !== checked) control.click();
              if (control.checked !== checked) return null;
              input.blur();
              anchor = input;
              continue;
            } else if (field.choice === "option" && input instanceof HTMLSelectElement) {
              const setter = Object.getOwnPropertyDescriptor(
                HTMLOptionElement.prototype,
                "selected",
              )?.set;
              if (!setter) return null;
              setter.call(input.options[field.optionIndex!], value === "1");
            } else if (input instanceof HTMLSelectElement) {
              const setter = Object.getOwnPropertyDescriptor(
                HTMLSelectElement.prototype,
                "selectedIndex",
              )?.set;
              if (!setter) return null;
              setter.call(input, Number(value));
            } else {
              const prototype =
                input instanceof HTMLTextAreaElement
                  ? HTMLTextAreaElement.prototype
                  : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
              if (!setter) return null;
              setter.call(input, field.inputs.length > 1 ? value[index] : value);
            }
            input.dispatchEvent(
              new InputEvent("input", { bubbles: true, inputType: "insertText" }),
            );
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.blur();
            anchor = input;
          }
        }
        return anchor;
      },
      target,
      values,
    )
    .catch(() => undefined);
  const anchor = anchorHandle?.asElement() as ElementHandle<FormControl> | null;
  if (!anchor) {
    await anchorHandle?.dispose();
    throw new CredentialFormError(
      "The form changed before it could be filled. Reconnect to continue.",
      409,
    );
  }
  if (request.submit !== true && located.description.kind === "login") {
    await anchor.dispose();
    return { submitted: false };
  }
  // A receipt identifies an exact node, so MCP never guesses which filled form
  // a continuation button belongs to. It carries no field values.
  const client = (anchor as ElementHandle<FormControl> & { client: CDPSession }).client;
  const { node } = await client.send("DOM.describeNode", {
    objectId: anchor.remoteObject().objectId,
  });
  const receipt: CredentialContinuation = {
    formId: target.formId,
    pageId: target.pageId,
    frameUrl: target.frameUrl,
    origin: target.origin,
    kind: target.kind,
    anchorBackendNodeId: node.backendNodeId,
    expiresAt: Date.now() + 5 * 60_000,
    submissionAttempted: false,
  };
  const timer = setTimeout(() => {
    void clearContinuation(cdpService);
  }, 5 * 60_000);
  timer.unref();
  const bound = await located.handle.evaluateHandle((form) => form);
  continuations.set(cdpService, {
    receipt,
    anchor,
    bound,
    filledIds: Object.keys(values).filter((id) => values[id] !== ""),
    timer,
  });
  // Filling card/address fields does not authorize any transaction or save.
  const submitted =
    request.submit === true &&
    located.description.kind === "login" &&
    (await activateCredentialControl(anchor).catch(() => false));
  receipt.submissionAttempted = submitted;
  return { submitted };
}

// A fill is one browser operation. Concurrent discovery must not dispose its
// bound nodes, and concurrent POSTs must not replay the input or submit click.
const filling = new WeakSet<CDPService>();
export async function fillCredentialForm(
  cdpService: CDPService,
  target: CredentialFormTarget,
  request: CredentialFormValues,
): Promise<{ submitted: boolean }> {
  if (filling.has(cdpService))
    throw new CredentialFormError("A secure form is already being filled.", 409);
  filling.add(cdpService);
  try {
    const result = await fillBoundForm(cdpService, target, request);
    recordBrowserFill(cdpService, target.formId, result.submitted);
    return result;
  } catch (error) {
    recordBrowserFillFailure(cdpService);
    throw error;
  } finally {
    filling.delete(cdpService);
  }
}

export async function discoverCredentialForm(
  cdpService: CDPService,
): Promise<CredentialFormDescription> {
  if (filling.has(cdpService))
    throw new CredentialFormError("A secure form operation is already in progress.", 409);
  filling.add(cdpService);
  try {
    const result = await discoverBoundForm(cdpService);
    recordBrowserForm(cdpService, result.formId);
    return result;
  } finally {
    filling.delete(cdpService);
  }
}
