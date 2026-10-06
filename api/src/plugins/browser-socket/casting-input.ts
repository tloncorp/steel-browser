import { z } from "zod";
export class ViewerInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const INPUT_VERSION = 1;
const coordinate = z.number().finite().min(0).max(16_384);
const point = { x: coordinate, y: coordinate };
const modifiers = z.number().int().min(0).max(15).default(0);
const button = z.enum(["none", "left", "right", "middle", "back", "forward"]);
const inputEnvelope = {
  version: z.literal(INPUT_VERSION),
  pageId: z.string().min(1).max(256),
  generation: z.number().int().nonnegative(),
  viewportGeneration: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
};

export const castingInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...inputEnvelope,
      type: z.literal("mouseEvent"),
      event: z
        .object({
          type: z.enum(["mousePressed", "mouseMoved", "mouseReleased", "mouseWheel"]),
          ...point,
          button,
          modifiers,
          clickCount: z.number().int().min(0).max(3).default(1),
          deltaX: z.number().finite().min(-10_000).max(10_000).optional(),
          deltaY: z.number().finite().min(-10_000).max(10_000).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...inputEnvelope,
      type: z.literal("touchEvent"),
      event: z
        .object({
          type: z.enum(["touchStart", "touchMove", "touchEnd", "touchCancel"]),
          id: z.number().int().min(0).max(2_147_483_647),
          ...point,
          modifiers,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...inputEnvelope,
      type: z.literal("keyEvent"),
      event: z
        .object({
          type: z.enum(["keyDown", "keyUp"]),
          key: z.string().max(64),
          code: z.string().max(64),
          keyCode: z.number().int().min(0).max(255),
          modifiers,
        })
        .strict(),
    })
    .strict(),
  z
    .object({ ...inputEnvelope, type: z.literal("insertText"), text: z.string().max(65_536) })
    .strict(),
  z
    .object({
      ...inputEnvelope,
      type: z.literal("composition"),
      text: z.string().max(4096),
      selectionStart: z.number().int().nonnegative().max(4096),
      selectionEnd: z.number().int().nonnegative().max(4096),
    })
    .strict(),
]);

export type CastingInputMessage = z.infer<typeof castingInputSchema>;
export type SendInput = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const buttonBits = { none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 };

/** Ordered remote input, including server-owned cancellation of held contacts and keys. */
export class CastingInput {
  private buttons = 0;
  private touch?: number;
  private point = { x: 0, y: 0 };
  private keys = new Map<string, Record<string, unknown>>();
  private composition = false;
  private queue = Promise.resolve();
  private queued = 0;
  private sequence = 0;

  constructor(
    private readonly send: SendInput,
    private readonly authorize: (message: CastingInputMessage) => { width: number; height: number },
  ) {}

  dispatch(raw: unknown) {
    const parsed = castingInputSchema.safeParse(raw);
    if (!parsed.success) return Promise.reject(new ViewerInputError("invalid_input"));
    const message = parsed.data;
    if (message.sequence <= this.sequence || this.queued >= 256)
      return Promise.reject(new ViewerInputError("invalid_sequence"));
    this.sequence = message.sequence;
    this.queued++;
    const operation = this.queue.then(async () => {
      const bounds = this.authorize(message);
      if (message.type === "mouseEvent" || message.type === "touchEvent") {
        if (message.event.x > bounds.width || message.event.y > bounds.height)
          throw new ViewerInputError("coordinates_outside_viewport");
        this.point = { x: message.event.x, y: message.event.y };
      }
      switch (message.type) {
        case "mouseEvent": {
          if (this.touch !== undefined) throw new ViewerInputError("contact_active");
          const event = message.event;
          const bit = buttonBits[event.button];
          if (event.type === "mousePressed") {
            if (!bit || this.buttons & bit) throw new ViewerInputError("invalid_button_state");
            this.buttons |= bit;
          } else if (event.type === "mouseReleased") {
            if (!bit || !(this.buttons & bit)) throw new ViewerInputError("invalid_button_state");
            this.buttons &= ~bit;
          }
          if (
            event.type === "mouseWheel" &&
            (event.deltaX === undefined || event.deltaY === undefined)
          )
            throw new ViewerInputError("invalid_wheel");
          const heldButton =
            Object.entries(buttonBits).find(([, flag]) => this.buttons & flag)?.[0] ?? "none";
          await this.send("Input.dispatchMouseEvent", {
            ...event,
            button: event.type === "mouseMoved" ? heldButton : event.button,
            buttons: this.buttons,
          });
          break;
        }
        case "touchEvent": {
          const event = message.event;
          if (this.buttons) throw new ViewerInputError("contact_active");
          if (event.type === "touchStart") {
            if (this.touch !== undefined) throw new ViewerInputError("contact_active");
            this.touch = event.id;
          } else if (this.touch !== event.id) throw new ViewerInputError("invalid_contact");
          const ending = event.type === "touchEnd" || event.type === "touchCancel";
          await this.send("Input.dispatchTouchEvent", {
            type: event.type,
            modifiers: event.modifiers,
            touchPoints: ending ? [] : [{ id: event.id, x: event.x, y: event.y }],
          });
          if (ending) this.touch = undefined;
          break;
        }
        case "keyEvent": {
          const event = message.event;
          const params = {
            type: event.type,
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.keyCode,
            modifiers: event.modifiers,
          };
          if (event.type === "keyDown") this.keys.set(event.code || event.key, params);
          else this.keys.delete(event.code || event.key);
          const text =
            event.key === "Enter"
              ? "\r"
              : event.key.length === 1 && !(event.modifiers & 7)
              ? event.key
              : undefined;
          await this.send("Input.dispatchKeyEvent", {
            ...params,
            ...(event.type === "keyDown" && text ? { text } : {}),
          });
          break;
        }
        case "insertText":
          await this.send("Input.insertText", { text: message.text });
          this.composition = false;
          break;
        case "composition":
          if (
            message.selectionStart > message.selectionEnd ||
            message.selectionEnd > message.text.length
          )
            throw new ViewerInputError("invalid_composition");
          await this.send("Input.imeSetComposition", {
            text: message.text,
            selectionStart: message.selectionStart,
            selectionEnd: message.selectionEnd,
          });
          this.composition = message.text.length > 0;
          break;
      }
    });
    this.queue = operation.then(
      () => {
        this.queued--;
      },
      () => {
        this.queued--;
      },
    );
    return operation;
  }

  reset() {
    const operation = this.queue.then(async () => {
      if (this.touch !== undefined) {
        await this.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        this.touch = undefined;
      }
      for (const [button, bit] of Object.entries(buttonBits)) {
        if (!(this.buttons & bit)) continue;
        this.buttons &= ~bit;
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...this.point,
          button,
          buttons: this.buttons,
          clickCount: 0,
        });
      }
      for (const params of this.keys.values())
        await this.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
      this.keys.clear();
      if (this.composition)
        await this.send("Input.imeSetComposition", {
          text: "",
          selectionStart: 0,
          selectionEnd: 0,
        });
      this.composition = false;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
