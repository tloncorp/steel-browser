import { describe, it, expect, vi } from "vitest";
import { createBrowserLogger } from "./browser-logger.js";
import { BrowserEventType } from "../../../types/enums.js";

describe("BrowserLogger", () => {
  it("should merge context into events", () => {
    const mockLog = vi.fn();
    const baseLogger = {
      info: mockLog,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(),
      level: "info",
    };

    const logger = createBrowserLogger({
      baseLogger: baseLogger as any,
      initialContext: { sessionId: "test-session", orgId: "test-org" },
    });

    logger.record({
      type: BrowserEventType.Console,
      timestamp: "2025-01-01T00:00:00Z",
      console: { level: "log", text: "test message" },
    });

    expect(mockLog).toHaveBeenCalledWith(
      {
        sessionId: "test-session",
        orgId: "test-org",
        type: BrowserEventType.Console,
        timestamp: "2025-01-01T00:00:00Z",
        console: { level: "log", text: "test message" },
      },
      BrowserEventType.Console,
    );
  });

  it("should allow dynamic context updates", () => {
    const mockLog = vi.fn();
    const baseLogger = {
      info: mockLog,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(),
      level: "info",
    };

    const logger = createBrowserLogger({
      baseLogger: baseLogger as any,
      initialContext: { sessionId: "session-1" },
    });

    logger.setContext({ orgId: "org-1" });

    expect(logger.getContext()).toEqual({
      sessionId: "session-1",
      orgId: "org-1",
    });

    logger.record({
      type: BrowserEventType.Navigation,
      timestamp: "2025-01-01T00:00:00Z",
      navigation: { url: "https://example.com" },
    });

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        orgId: "org-1",
        type: BrowserEventType.Navigation,
      }),
      BrowserEventType.Navigation,
    );
  });

  it("should support functional context updates", () => {
    const mockLog = vi.fn();
    const baseLogger = {
      info: mockLog,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(),
      level: "info",
    };

    const logger = createBrowserLogger({
      baseLogger: baseLogger as any,
      initialContext: { count: 0 },
    });

    logger.setContext((prev) => ({ count: (prev.count as number) + 1 }));
    expect(logger.getContext()).toEqual({ count: 1 });

    logger.setContext((prev) => ({ count: (prev.count as number) + 1 }));
    expect(logger.getContext()).toEqual({ count: 2 });
  });

  it("should prioritize event fields over context fields", () => {
    const mockLog = vi.fn();
    const baseLogger = {
      info: mockLog,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(),
      level: "info",
    };

    const logger = createBrowserLogger({
      baseLogger: baseLogger as any,
      initialContext: { type: "wrong-type", pageId: "context-page" },
    });

    logger.record({
      type: BrowserEventType.Request,
      timestamp: "2025-01-01T00:00:00Z",
      pageId: "event-page",
      request: { method: "GET", url: "https://example.com" },
    });

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BrowserEventType.Request,
        pageId: "event-page",
      }),
      BrowserEventType.Request,
    );
  });
});

describe("secure credential logging", () => {
  it("redacts page echoes before console, event streams, and storage, and drops unredactable recordings", () => {
    const info = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    const logger = createBrowserLogger({
      baseLogger: { info, error: vi.fn() },
      storage: { write } as any,
    });
    const listener = vi.fn();
    logger.on?.("log" as any, listener);
    logger.protectValues(["fixture p@ssword"]);
    logger.record({
      type: BrowserEventType.Console,
      timestamp: "now",
      console: { level: "log", text: "echo fixture p@ssword" },
    });
    logger.record({
      type: BrowserEventType.Request,
      timestamp: "now",
      request: {
        method: "POST",
        url: "https://login.example/?p=fixture%20p%40ssword",
        postData: "p=fixture+p%40ssword",
      },
    });
    logger.record({
      type: BrowserEventType.Recording,
      timestamp: "now",
      data: "packed-private-dom",
    });
    logger.record({
      type: BrowserEventType.ScreencastFrame,
      timestamp: "now",
      data: "private-image",
    });
    expect(info).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
    const outputs = JSON.stringify([
      info.mock.calls,
      write.mock.calls,
      listener.mock.calls,
      logger.getContext(),
    ]);
    for (const value of [
      "fixture p@ssword",
      "fixture%20p%40ssword",
      "fixture+p%40ssword",
      "packed-private-dom",
      "private-image",
    ])
      expect(outputs).not.toContain(value);
    expect(outputs).toContain("[redacted]");
  });
});
