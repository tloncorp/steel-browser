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
  it.each([true, false])(
    "records the same form when it is observed after a fill (submitted=%s)",
    (submitted) => {
      const browser = {};
      recordBrowserForm(browser, "login");
      recordBrowserFill(browser, "login", submitted);
      const filled = browserMonitorStatus(browser);

      recordBrowserForm(browser, "login");
      const redisplayed = browserMonitorStatus(browser);
      expect(redisplayed).toMatchObject({
        epoch: filled.epoch,
        revision: 3,
        fill: filled.fill,
        form: { formId: "login", revision: 3 },
      });
      recordBrowserForm(browser, "login");
      expect(browserMonitorStatus(browser)).toEqual(redisplayed);

      recordBrowserFill(browser, "login", submitted);
      recordBrowserForm(browser, "login");
      expect(browserMonitorStatus(browser)).toMatchObject({
        revision: 5,
        fill: { formId: "login", revision: 4, submitted },
        form: { formId: "login", revision: 5 },
      });
    },
  );
});
