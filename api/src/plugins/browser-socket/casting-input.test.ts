import { describe, expect, it } from "vitest";
import { CastingInput } from "./casting-input.js";

function fixture() {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let generation = 2;
  let sequence = 0;
  const input = new CastingInput(
    async (method, params) => {
      events.push({ method, params });
    },
    (message) => {
      if (
        message.generation !== generation ||
        message.viewportGeneration !== 3 ||
        message.pageId !== "page"
      )
        throw new Error("stale_input");
      return { width: 390, height: 844 };
    },
  );
  const envelope = () => ({
    version: 1,
    pageId: "page",
    generation: 2,
    viewportGeneration: 3,
    sequence: ++sequence,
  });
  const mouse = (type: string, extra = {}) =>
    input.dispatch({
      ...envelope(),
      type: "mouseEvent",
      event: { type, x: 50, y: 70, button: "left", ...extra },
    });
  const touch = (type: string, extra = {}) =>
    input.dispatch({
      ...envelope(),
      type: "touchEvent",
      event: { type, x: 50, y: 70, id: 4, ...extra },
    });
  return {
    events,
    input,
    envelope,
    mouse,
    touch,
    revoke: () => {
      generation++;
    },
  };
}

describe("casting input protocol", () => {
  it("preserves a mouse drag's order and held-button state", async () => {
    const f = fixture();
    await Promise.all([
      f.mouse("mousePressed"),
      f.mouse("mouseMoved", { x: 100, button: "none" }),
      f.mouse("mouseReleased", { x: 100 }),
    ]);
    expect(
      f.events.map(({ params }) => [params.type, params.x, params.buttons, params.button]),
    ).toEqual([
      ["mousePressed", 50, 1, "left"],
      ["mouseMoved", 100, 1, "left"],
      ["mouseReleased", 100, 0, "left"],
    ]);
  });
  it("preserves one touch contact, rejects a second, and cancels on reset", async () => {
    const f = fixture();
    await f.touch("touchStart");
    await expect(f.touch("touchStart", { id: 5 })).rejects.toThrow("contact_active");
    await f.touch("touchMove", { x: 150 });
    await f.input.reset();
    expect(f.events.map(({ params }) => params.type)).toEqual([
      "touchStart",
      "touchMove",
      "touchCancel",
    ]);
    expect(f.events[1].params.touchPoints).toEqual([{ id: 4, x: 150, y: 70 }]);
  });
  it("releases buttons and keys after authority changes without authorizing stale input", async () => {
    const f = fixture();
    await f.mouse("mousePressed", { button: "right" });
    await f.input.dispatch({
      ...f.envelope(),
      type: "keyEvent",
      event: { type: "keyDown", key: "Shift", code: "ShiftLeft", keyCode: 16 },
    });
    f.revoke();
    await expect(f.mouse("mouseMoved")).rejects.toThrow("stale_input");
    await f.input.reset();
    expect(f.events.slice(-2).map(({ params }) => [params.type, params.buttons])).toEqual([
      ["mouseReleased", 0],
      ["keyUp", undefined],
    ]);
  });
  it("rejects unsupported versions, nonfinite or out-of-frame coordinates, and replayed sequences", async () => {
    const f = fixture();
    await expect(f.mouse("mousePressed", { x: NaN })).rejects.toThrow("invalid_input");
    await expect(f.mouse("mousePressed", { x: 400 })).rejects.toThrow(
      "coordinates_outside_viewport",
    );
    const message = { ...f.envelope(), type: "insertText", text: "example" };
    await expect(f.input.dispatch({ ...message, version: 2 })).rejects.toThrow("invalid_input");
    await f.input.dispatch(message);
    await expect(f.input.dispatch(message)).rejects.toThrow("invalid_sequence");
    expect(f.events).toHaveLength(1);
  });
  it("uses committed text independently of key events and cancels unfinished composition", async () => {
    const f = fixture();
    await f.input.dispatch({
      ...f.envelope(),
      type: "composition",
      text: "に",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await f.input.dispatch({ ...f.envelope(), type: "insertText", text: "日本" });
    await f.input.reset();
    expect(f.events.map(({ method }) => method)).toEqual([
      "Input.imeSetComposition",
      "Input.insertText",
    ]);
    await f.input.dispatch({
      ...f.envelope(),
      type: "composition",
      text: "文",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await f.input.reset();
    expect(f.events.at(-1)).toEqual({
      method: "Input.imeSetComposition",
      params: { text: "", selectionStart: 0, selectionEnd: 0 },
    });
  });
  it("serializes overlapping cancellation without sending duplicate touch cancellation", async () => {
    const f = fixture();
    await f.touch("touchStart");
    await Promise.all([f.input.reset(), f.input.reset(), f.input.reset()]);
    expect(f.events.map(({ params }) => params.type)).toEqual(["touchStart", "touchCancel"]);
    await f.touch("touchStart");
    await f.touch("touchEnd");
    expect(f.events.at(-1)?.params.type).toBe("touchEnd");
  });
});
