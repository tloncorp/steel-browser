import { describe, expect, it, vi } from "vitest";
import {
  browserMonitorStatus,
  recordBrowserForm,
  recordBrowserFill,
  recordBrowserFillFailure,
} from "./browser-monitor.service.js";
describe("browser monitoring receipts", () => {
  it("retains fill evidence after navigation and beyond credential receipt expiry", () => {
    const browser = {};
    const baseline = browserMonitorStatus(browser);
    recordBrowserForm(browser, "login");
    recordBrowserFill(browser, "login", true);
    const filled = browserMonitorStatus(browser);
    recordBrowserForm(browser, "otp");
    recordBrowserForm(browser, "otp");
    expect(browserMonitorStatus(browser)).toMatchObject({
      epoch: baseline.epoch,
      revision: 3,
      fill: filled.fill,
      form: { formId: "otp", revision: 3 },
    });
    vi.useFakeTimers();
    vi.advanceTimersByTime(600_000);
    expect(browserMonitorStatus(browser).fill).toEqual(filled.fill);
    vi.useRealTimers();
  });
  it("isolates browsers, copies reads and stores no input or failure text", () => {
    const a = {},
      b = {};
    recordBrowserFill(a, "address", false);
    recordBrowserFillFailure(a);
    const copy = browserMonitorStatus(a);
    copy.revision = 100;
    expect(browserMonitorStatus(a).revision).toBe(2);
    expect(browserMonitorStatus(b).epoch).not.toBe(copy.epoch);
    expect(browserMonitorStatus(b).fill).toBeUndefined();
    expect(Object.keys(browserMonitorStatus(a).failure!)).toEqual(["revision", "at"]);
  });
});
