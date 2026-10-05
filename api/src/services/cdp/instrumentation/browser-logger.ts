import { BrowserEventUnion } from "./types.js";
import { LogStorage } from "./storage/index.js";
import { EventEmitter } from "events";
import { BrowserEventType, EmitEvent } from "../../../types/enums.js";

export type Context = Record<string, any>;

/**
 * Logger interface compatible with both pino.Logger and FastifyBaseLogger.
 * This avoids type conflicts between different pino versions (v9 vs v10).
 */
export interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface BrowserLogger {
  protectValues(values: string[]): void;
  record(event: BrowserEventUnion): void;
  resetContext(): void;
  setContext(
    update: Partial<Context> | ((prev: Readonly<Context>) => Partial<Context> | Context),
  ): void;
  getContext(): Readonly<Context>;
  flush?(): Promise<void>;
  getStorage?(): LogStorage | null;
  on?(event: EmitEvent.Log, listener: (event: BrowserEventUnion, context: Context) => void): this;
  off?(event: EmitEvent.Log, listener: (event: BrowserEventUnion, context: Context) => void): this;
}

export interface CreateBrowserLoggerOptions {
  baseLogger: Logger;
  initialContext?: Context;
  storage?: LogStorage;
  enableConsoleLogging?: boolean;
}

export function createBrowserLogger(options: CreateBrowserLoggerOptions): BrowserLogger {
  let context: Context = options.initialContext ?? {};
  const storage = options.storage || null;
  const enableConsoleLogging = options.enableConsoleLogging ?? true;
  const eventEmitter = new EventEmitter();
  // These values stay in this session's private memory, outside logger context and storage.
  const sensitiveValues = new Set<string>();
  const protectValues = (values: string[]) => {
    for (const value of values) {
      if (!value) continue;
      sensitiveValues.add(value);
      sensitiveValues.add(encodeURIComponent(value));
      sensitiveValues.add(new URLSearchParams({ v: value }).toString().slice(2));
      sensitiveValues.add(JSON.stringify(value).slice(1, -1));
    }
  };
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const secret of [...sensitiveValues].sort((a, b) => b.length - a.length))
        value = (value as string).split(secret).join("[redacted]");
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
    return value;
  };

  const resetContext = () => {
    context = options.initialContext ?? {};
  };

  const setContext = (
    update: Partial<Context> | ((prev: Readonly<Context>) => Partial<Context> | Context),
  ) => {
    if (typeof update === "function") {
      const result = update(context);
      context = { ...context, ...result };
    } else {
      context = { ...context, ...update };
    }
  };

  const getContext = (): Readonly<Context> => context;

  const record = (event: BrowserEventUnion) => {
    // Compressed DOM recordings and image frames cannot be reliably scrubbed after capture.
    if (
      sensitiveValues.size &&
      [
        BrowserEventType.Recording,
        BrowserEventType.ScreencastFrame,
        BrowserEventType.ResponseBody,
      ].includes(event.type)
    )
      return;
    if (sensitiveValues.size) {
      if (event.type === BrowserEventType.Request)
        event = {
          ...event,
          request: { ...event.request, postData: undefined, headers: undefined },
        };
      if (event.type === BrowserEventType.Response)
        event = { ...event, response: { ...event.response, body: undefined, headers: undefined } };
      event = {
        ...(redact(event) as BrowserEventUnion),
        type: event.type,
        timestamp: event.timestamp,
        pageId: event.pageId,
        targetType: event.targetType,
      } as BrowserEventUnion;
    }
    const mergedEvent = { ...context, ...event };

    if (enableConsoleLogging) {
      options.baseLogger.info(mergedEvent, event.type);
    }

    if (storage) {
      storage.write(event, context).catch((err) => {
        options.baseLogger.error({ err }, "Failed to write event to storage");
      });
    }

    if (event.type !== BrowserEventType.Recording) eventEmitter.emit(EmitEvent.Log, event, context);
  };

  const flush = async () => {
    if (storage) {
      await storage.flush();
    }
  };

  const getStorage = () => storage;

  const on = (
    event: EmitEvent.Log,
    listener: (event: BrowserEventUnion, context: Context) => void,
  ) => {
    eventEmitter.on(event, listener);
    return logger;
  };

  const off = (
    event: EmitEvent.Log,
    listener: (event: BrowserEventUnion, context: Context) => void,
  ) => {
    eventEmitter.off(event, listener);
    return logger;
  };

  const logger: BrowserLogger = {
    protectValues,
    record,
    resetContext,
    setContext,
    getContext,
    flush,
    getStorage,
    on,
    off,
  };

  return logger;
}
