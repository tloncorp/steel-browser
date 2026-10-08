import { describe, expect, it, vi } from "vitest";
import { getPageViewport, PageViewport } from "./casting-viewport.js";

const request = (overrides = {}) => ({
  type: "viewport",
  mode: "auto",
  width: 390,
  height: 760,
  ...overrides,
});
const setup = () => {
  const viewport = new PageViewport({ width: 1920, height: 1080, mobile: false });
  const notify = vi.fn();
  const client = viewport.attach(notify);
  const apply = vi.fn(async () => {});
  return { viewport, notify, client, apply };
};

describe("casting viewport", () => {
  it("shares ownership only within the same session and page", () => {
    const first = {};
    const second = {};
    const initial = { width: 1920, height: 1080, mobile: false };
    const viewport = getPageViewport(first, "page", initial);
    expect(getPageViewport(first, "page", initial)).toBe(viewport);
    expect(getPageViewport(first, "other-page", initial)).not.toBe(viewport);
    expect(getPageViewport(second, "page", initial)).not.toBe(viewport);
  });

  it("does not mutate Agent View and recovers if reading its current viewport fails", async () => {
    const { client, apply, notify } = setup();
    await client.resize(request({ mode: "agent" }), apply, async () => {
      throw new Error("closed page");
    });
    expect(notify).toHaveBeenCalledWith({
      type: "viewportError",
      message: "Could not read the agent viewport.",
    });
    const read = async () => ({ width: 1600, height: 1000, mobile: false });
    await client.resize(request({ mode: "agent" }), apply, read);
    expect(apply).not.toHaveBeenCalled();
    await client.resize(request({ mode: "mobile", reload: true }), apply, read);
    await client.resize(request({ mode: "agent", reload: true }), apply, read);
    expect(apply).toHaveBeenLastCalledWith(
      { mode: "agent", width: 1600, height: 1000, mobile: false },
      true,
    );
  });

  it("uses exact phone dimensions for a mobile session without a reload", async () => {
    const viewport = new PageViewport({ width: 508, height: 1074, mobile: true });
    const apply = vi.fn(async () => {});
    await viewport.attach(vi.fn()).resize(request({ width: 375 }), apply);
    expect(apply).toHaveBeenCalledWith(
      { mode: "auto", width: 375, height: 760, mobile: true },
      false,
    );
  });

  it("does not restart capture for repeated identical dimensions", async () => {
    const { client, apply } = setup();
    await client.resize(request(), apply);
    await client.resize(request(), apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("reasserts the viewport when a same-sized viewer takes control", async () => {
    const { viewport, client, apply } = setup();
    await client.resize(request(), apply);
    await client.close();
    await viewport.attach(vi.fn()).resize(request(), apply);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("remembers mobile mode between viewer connections", async () => {
    const { viewport, client, apply } = setup();
    await client.resize(request({ mode: "mobile", reload: true }), apply);
    await client.close();
    const notify = vi.fn();
    viewport.attach(notify).ready();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "mobile", mobile: true, available: true }),
    );
  });

  it("fits a phone in CSS pixels without reloading or enabling mobile emulation", async () => {
    const { client, apply } = setup();
    await client.resize(request(), apply);
    expect(apply).toHaveBeenCalledWith(
      { mode: "auto", width: 390, height: 760, mobile: false },
      false,
    );
    expect(client.canControl()).toBe(true);
  });

  it("requires explicit reload consent when switching mobile emulation", async () => {
    const { client, apply, notify } = setup();
    await client.resize(request({ mode: "mobile" }), apply);
    expect(apply).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({ type: "viewportReloadRequired", mode: "mobile" });
    await client.resize(request({ mode: "mobile", reload: true }), apply);
    expect(apply).toHaveBeenLastCalledWith(
      { mode: "mobile", width: 390, height: 760, mobile: true },
      true,
    );
    await client.resize(request({ mode: "mobile", width: 844, height: 350 }), apply);
    expect(apply).toHaveBeenLastCalledWith(
      { mode: "mobile", width: 844, height: 350, mobile: true },
      false,
    );
    apply.mockClear();
    await client.resize(request({ mode: "desktop" }), apply);
    expect(apply).not.toHaveBeenCalled();
    await client.resize(request({ mode: "desktop", reload: true }), apply);
    expect(apply).toHaveBeenLastCalledWith(
      { mode: "desktop", width: 1920, height: 1080, mobile: false },
      true,
    );
  });

  it("bounds capture dimensions and rejects malformed requests", async () => {
    const { client, apply } = setup();
    for (const value of [0, -1, 0.5, Infinity, NaN, "390", 10001]) {
      await client.resize(request({ width: value }), apply);
    }
    await client.resize(request({ mode: "unknown" }), apply);
    expect(apply).not.toHaveBeenCalled();
    await client.resize(request({ width: 10000, height: 1 }), apply);
    expect(apply).toHaveBeenCalledWith(
      { mode: "auto", width: 2560, height: 160, mobile: false },
      false,
    );
  });

  it("allows one controller and transfers control when it disconnects", async () => {
    const { viewport, client, apply } = setup();
    const notifyOther = vi.fn();
    const other = viewport.attach(notifyOther);
    await client.resize(request(), apply);
    await other.resize(request({ width: 1200 }), apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(other.canControl()).toBe(false);
    await client.close();
    expect(notifyOther).toHaveBeenLastCalledWith(expect.objectContaining({ available: true }));
    await other.resize(request({ width: 1200 }), apply);
    expect(other.canControl()).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("discards queued requests after disconnect and serializes a new owner", async () => {
    const { viewport, client } = setup();
    let finish!: () => void;
    const applying = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = client.resize(request(), applying);
    await Promise.resolve();
    expect(client.canControl()).toBe(false);
    const stale = client.resize(request({ width: 500 }), applying);
    const closing = client.close();
    const nextApply = vi.fn(async () => {});
    const next = viewport.attach(vi.fn()).resize(request({ width: 800 }), nextApply);
    expect(nextApply).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, stale, closing, next]);
    expect(applying).toHaveBeenCalledTimes(1);
    expect(nextApply).toHaveBeenCalledTimes(1);
  });

  it("keeps the queue usable after a failed browser update", async () => {
    const { client, notify, apply } = setup();
    await client.resize(request(), async () => {
      throw new Error("secret browser details");
    });
    expect(notify).toHaveBeenCalledWith({
      type: "viewportError",
      message: "Could not change the browser viewport.",
    });
    await client.resize(request(), apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it("revokes stale input immediately and finishes cancellation before another viewer takes control", async () => {
    const viewport = new PageViewport({ width: 1920, height: 1080, mobile: false });
    let finish!: () => void;
    const reset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = viewport.attach(vi.fn(), reset);
    const second = viewport.attach(vi.fn());
    const before = await first.acquire();
    first.assertControl(before.generation);
    const closing = first.close();
    expect(() => first.assertControl(before.generation)).toThrow("control_lost");
    const acquiring = second.acquire();
    await Promise.resolve();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(second.canControl()).toBe(false);
    finish();
    await closing;
    const after = await acquiring;
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(second.canControl()).toBe(true);
    expect(() => second.assertControl(before.generation)).toThrow("control_lost");
  });
});
