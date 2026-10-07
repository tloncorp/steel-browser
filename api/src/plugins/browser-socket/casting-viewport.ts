import { z } from "zod";
import { ViewerInputError } from "./casting-input.js";

const viewportRequest = z.object({
  type: z.literal("viewport"),
  mode: z.enum(["agent", "auto", "mobile", "desktop"]),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  reload: z.boolean().optional().default(false),
});

export type CastingViewport = {
  mode: "agent" | "auto" | "mobile" | "desktop";
  width: number;
  height: number;
  mobile: boolean;
};

type Notify = (message: Record<string, unknown>) => void;
const bound = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** A page has one resizing/input owner; other viewers share its rendered viewport. */
export class PageViewport {
  private owner?: symbol;
  private generation = 0;
  private clients = new Map<symbol, Notify>();
  private pending = Promise.resolve();
  private hasApplied = false;
  private applying = false;
  private current: CastingViewport;
  private agent: { width: number; height: number; mobile: boolean };

  get mode() {
    return this.current.mode;
  }

  constructor(private readonly initial: { width: number; height: number; mobile: boolean }) {
    this.current = { mode: "agent", ...initial };
    this.agent = { ...initial };
  }

  attach(notify: Notify, reset: () => Promise<void> = async () => {}) {
    const token = Symbol();
    this.clients.set(token, notify);
    let releasing = false;
    const publish = () => this.publish();
    const canControl = () =>
      this.clients.has(token) && this.owner === token && !this.applying && !releasing;
    const snapshot = () => ({
      generation: this.generation,
      controlling: canControl(),
      available: !this.owner,
    });
    const serial = <T>(operation: () => Promise<T>) => {
      const result = this.pending.then(operation);
      this.pending = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    const release = () => {
      releasing = true;
      if (this.owner === token) this.generation++;
      return serial(async () => {
        if (this.owner === token) {
          await reset();
          this.owner = undefined;
        }
        releasing = false;
        this.publish();
      });
    };
    return {
      snapshot,
      mode: () => this.current.mode,
      acquire: () =>
        serial(async () => {
          if (!this.clients.has(token)) throw new ViewerInputError("control_lost");
          if (this.owner && this.owner !== token)
            throw new ViewerInputError("another_viewer_controlling");
          if (!this.owner) {
            this.owner = token;
            this.generation++;
            this.hasApplied = false;
          }
          this.publish();
          return snapshot();
        }),
      assertControl: (generation: number) => {
        if (!canControl() || generation !== this.generation)
          throw new ViewerInputError("control_lost");
      },
      ready: publish,
      canControl,
      resize: (
        message: unknown,
        apply: (viewport: CastingViewport, reload: boolean) => Promise<void>,
        readAgent?: () => Promise<{ width: number; height: number; mobile: boolean }>,
      ) => {
        const parsed = viewportRequest.safeParse(message);
        if (!parsed.success) {
          notify({ type: "viewportError", message: "Invalid viewer dimensions." });
          return Promise.resolve();
        }
        // Serialize changes across connections, including a disconnect during an update.
        this.pending = this.pending.then(async () => {
          if (!this.clients.has(token)) return;
          if (this.owner && this.owner !== token) {
            this.publish();
            return;
          }
          const takingControl = this.owner !== token;
          if (takingControl) this.generation++;
          this.owner = token;
          const request = parsed.data;
          if (this.current.mode === "agent" && readAgent) {
            try {
              this.agent = await readAgent();
            } catch {
              notify({ type: "viewportError", message: "Could not read the agent viewport." });
              return;
            }
          }
          let width = bound(request.width, 240, 2560);
          let height = bound(request.height, 160, 1600);
          if (request.mode === "agent") {
            width = this.agent.width;
            height = this.agent.height;
          } else if (request.mode === "desktop") {
            width = bound(this.initial.width, 1024, 2560);
            height = bound(this.initial.height, 600, 1600);
          } else if (request.mode === "mobile") {
            const landscape = width > height;
            width = Math.min(width, landscape ? 932 : 430);
            height = Math.min(height, landscape ? 430 : 932);
          }
          const next: CastingViewport = {
            mode: request.mode,
            width,
            height,
            mobile:
              request.mode === "agent"
                ? this.agent.mobile
                : request.mode === "auto"
                ? this.initial.mobile
                : request.mode === "mobile",
          };
          const preservingAgent = request.mode === "agent" && this.current.mode === "agent";
          const reload = !preservingAgent && next.mobile !== this.current.mobile;
          if (reload && !request.reload) {
            notify({ type: "viewportReloadRequired", mode: request.mode });
            this.publish();
            return;
          }
          try {
            if (
              !preservingAgent &&
              (takingControl ||
                !this.hasApplied ||
                next.width !== this.current.width ||
                next.height !== this.current.height ||
                next.mobile !== this.current.mobile)
            ) {
              this.applying = true;
              try {
                await apply(next, reload);
              } finally {
                this.applying = false;
              }
              this.hasApplied = true;
            }
            this.current = next;
          } catch {
            this.publish();
            notify({ type: "viewportError", message: "Could not change the browser viewport." });
            return;
          }
          this.publish();
        });
        return this.pending;
      },
      release,
      close: () => {
        this.clients.delete(token);
        return release();
      },
    };
  }

  private publish() {
    for (const [token, notify] of this.clients) {
      notify({
        type: "viewportState",
        ...this.current,
        controlling: this.owner === token,
        available: !this.owner,
      });
    }
  }
}

// Key by the stable browser runtime, not the copies returned by session detail lookups.
const runtimes = new WeakMap<object, Map<string, PageViewport>>();
export function getPageViewport(
  runtime: object,
  pageId: string,
  initial: { width: number; height: number; mobile: boolean },
) {
  let pages = runtimes.get(runtime);
  if (!pages) {
    pages = new Map();
    runtimes.set(runtime, pages);
  }
  let viewport = pages.get(pageId);
  if (!viewport) {
    viewport = new PageViewport(initial);
    pages.set(pageId, viewport);
  }
  return viewport;
}
