import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CDPService } from "../../services/cdp/cdp.service.js";
import {
  handlePrepareCredentialForm,
  handleDiscoverCredentialForm,
  handleFillCredentialForm,
  handleGetCredentialContinuation,
  handleGetBrowserMonitorStatus,
} from "./sessions.controller.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const app = Fastify({ trustProxy: true });
  apps.push(app);
  const getSession = vi.fn(() => ({ status: "live" }));
  const service = { getAllPages: async () => [] } as unknown as CDPService;
  app.decorate("sessionService", {
    getSession,
    getCDPService: () => service,
  } as unknown as typeof app.sessionService);
  app.post<{ Params: { sessionId: string }; Body: { pageId: string; fields: [] } }>(
    "/prepare/:sessionId",
    (request, reply) => handlePrepareCredentialForm(app, request, reply),
  );
  app.get<{ Params: { sessionId: string }; Querystring: {} }>(
    "/discover/:sessionId",
    (request, reply) => handleDiscoverCredentialForm(app, request, reply),
  );
  app.get<{ Params: { sessionId: string } }>("/monitor/:sessionId", (request, reply) =>
    handleGetBrowserMonitorStatus(app, request, reply),
  );
  app.get<{ Params: { sessionId: string } }>("/continuation/:sessionId", (request, reply) =>
    handleGetCredentialContinuation(app, request, reply),
  );
  app.post<{
    Params: { sessionId: string };
    Body: Parameters<typeof handleFillCredentialForm>[1]["body"];
  }>("/fill/:sessionId", (request, reply) => handleFillCredentialForm(app, request, reply));
  return { app, getSession, service };
}

describe("local form preparation", () => {
  it.each(["discover", "monitor", "continuation", "fill"])(
    "rejects forwarded localhost on the companion %s endpoint",
    async (route) => {
      const { app, getSession } = fixture();
      const response = await app.inject({
        method: route === "fill" ? "POST" : "GET",
        url: `/${route}/session`,
        remoteAddress: "203.0.113.9",
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      expect(response.statusCode).toBe(404);
      expect(getSession).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "rejects a remote socket with forwarded address %s",
    async (forwarded) => {
      const { app, getSession } = fixture();
      const response = await app.inject({
        method: "POST",
        url: "/prepare/session",
        remoteAddress: "203.0.113.9",
        headers: forwarded ? { "x-forwarded-for": forwarded } : {},
        payload: { pageId: "missing", fields: [] },
      });
      expect(response.statusCode).toBe(404);
      expect(getSession).not.toHaveBeenCalled();
    },
  );
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "accepts loopback socket %s regardless of forwarded address",
    async (remoteAddress) => {
      const { app, getSession } = fixture();
      const response = await app.inject({
        method: "POST",
        url: "/prepare/session",
        remoteAddress,
        headers: { "x-forwarded-for": "203.0.113.9" },
        payload: { pageId: "missing", fields: [] },
      });
      expect(getSession).toHaveBeenCalledWith("session");
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("stale_ref");
    },
  );
  it("distinguishes a busy preparation from a stale selection", async () => {
    const { app, service } = fixture();
    let release!: (pages: []) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    service.getAllPages = () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      });
    const options = {
      method: "POST" as const,
      url: "/prepare/session",
      remoteAddress: "127.0.0.1",
      payload: { pageId: "missing", fields: [] },
    };
    const first = app.inject(options).then((response) => response);
    await ready;
    try {
      const busy = await app.inject(options);
      expect(busy.statusCode).toBe(409);
      expect(busy.json().code).toBe("session_busy");
    } finally {
      release([]);
    }
    expect((await first).json().code).toBe("stale_ref");
  });
});
