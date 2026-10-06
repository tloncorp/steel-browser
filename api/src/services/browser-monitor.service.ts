import { randomUUID } from "node:crypto";

/** Metadata only, retained for the browser's lifetime, independently of DOM handles and
 * the five-minute credential continuation. Losing a browser loses this epoch; readers
 * must treat an epoch change as missing evidence, never as successful completion. */
export interface BrowserMonitorStatus {
  version: 1;
  epoch: string;
  revision: number;
  form?: { revision: number; at: number; formId: string };
  fill?: { revision: number; at: number; formId: string; submitted: boolean };
  failure?: { revision: number; at: number };
}
const states = new WeakMap<object, BrowserMonitorStatus>();
function state(browser: object): BrowserMonitorStatus {
  let value = states.get(browser);
  if (!value) {
    value = { version: 1, epoch: randomUUID(), revision: 0 };
    states.set(browser, value);
  }
  return value;
}
export function browserMonitorStatus(browser: object): BrowserMonitorStatus {
  return structuredClone(state(browser));
}
export function recordBrowserForm(browser: object, formId: string) {
  const value = state(browser);
  if (value.form?.formId === formId) return;
  value.form = { revision: ++value.revision, at: Date.now(), formId };
}
export function recordBrowserFill(browser: object, formId: string, submitted: boolean) {
  const value = state(browser);
  value.fill = { revision: ++value.revision, at: Date.now(), formId, submitted };
}
export function recordBrowserFillFailure(browser: object) {
  const value = state(browser);
  value.failure = { revision: ++value.revision, at: Date.now() };
}
