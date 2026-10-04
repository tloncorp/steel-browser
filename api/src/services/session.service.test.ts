import { mkdtemp, stat, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IProxyServer } from "../utils/proxy.js";
import { CDPService } from "./cdp/cdp.service.js";
import { SessionService } from "./session.service.js";

const roots: string[] = [];

const makeCDPService = () => {
  const launchConfigs: Array<{
    userDataDir?: string;
    options?: { downloadsPath?: string };
  }> = [];
  const service = {
    getUserAgent: vi.fn(() => "test-agent"),
    getDimensions: vi.fn(() => ({ width: 1280, height: 720 })),
    startNewSession: vi.fn(
      async (config: { userDataDir?: string; options?: { downloadsPath?: string } }) => {
        launchConfigs.push(config);
        return {};
      },
    ),
    setDisconnectHandler: vi.fn(),
    getInstrumentationLogger: vi.fn(() => ({ setContext: vi.fn() })),
    endSession: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    launch: vi.fn(async () => ({})),
  };
  return { service: service as unknown as CDPService, launchConfigs, mocks: service };
};

const makeSessionService = () => {
  const defaultCDP = makeCDPService();
  const runtimes: ReturnType<typeof makeCDPService>[] = [];
  const logger = {
    child: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const sessionService = new SessionService({
    cdpService: defaultCDP.service,
    createCDPService: () => {
      const runtime = makeCDPService();
      runtimes.push(runtime);
      return runtime.service;
    },
    seleniumService: {
      launch: vi.fn(),
      close: vi.fn(),
    } as never,
    fileService: {} as never,
    logger: logger as never,
  });
  return { sessionService, runtimes };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionService multi-session isolation", () => {
  it("uses a dedicated runtime and profile directory for each session", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "steel-session-test-"));
    roots.push(profileRoot);
    const { sessionService, runtimes } = makeSessionService();
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";

    const [first, second] = await Promise.all([
      sessionService.startSession({
        sessionId: firstId,
        userDataDir: profileRoot,
        timezone: "UTC",
        credentials: undefined,
      }),
      sessionService.startSession({
        sessionId: secondId,
        userDataDir: profileRoot,
        timezone: "UTC",
        credentials: undefined,
      }),
    ]);

    expect(first.websocketUrl).toContain(`sessionId=${firstId}`);
    expect(second.websocketUrl).toContain(`sessionId=${secondId}`);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[0].launchConfigs[0].userDataDir).toBe(path.join(profileRoot, firstId));
    expect(runtimes[1].launchConfigs[0].userDataDir).toBe(path.join(profileRoot, secondId));
    expect(runtimes[0].launchConfigs[0].options?.downloadsPath).toBe(
      path.join(profileRoot, firstId, "Downloads"),
    );
    expect(sessionService.getCDPService(firstId)).not.toBe(sessionService.getCDPService(secondId));

    await sessionService.endSession(firstId);

    expect(runtimes[0].mocks.endSession).toHaveBeenCalledOnce();
    expect(runtimes[1].mocks.endSession).not.toHaveBeenCalled();
    expect(sessionService.getSession(firstId)?.status).toBe("released");
    expect(sessionService.getSession(secondId)?.status).toBe("live");
    await expect(stat(path.join(profileRoot, firstId))).rejects.toThrow();
    await expect(stat(path.join(profileRoot, secondId))).resolves.toBeDefined();

    await sessionService.endSession(secondId);
  });

  it("rejects ambiguous legacy lookups when multiple sessions are active", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "steel-session-test-"));
    roots.push(profileRoot);
    const { sessionService } = makeSessionService();

    await sessionService.startSession({
      sessionId: "33333333-3333-4333-8333-333333333333",
      userDataDir: profileRoot,
      timezone: "UTC",
      credentials: undefined,
    });
    await sessionService.startSession({
      sessionId: "44444444-4444-4444-8444-444444444444",
      userDataDir: profileRoot,
      timezone: "UTC",
      credentials: undefined,
    });

    expect(() => sessionService.getCDPService()).toThrow(/sessionId is required/);
    await expect(sessionService.endSession()).rejects.toThrow(/sessionId is required/);
  });

  it("reuses a persistent profile across short-lived sessions and fences concurrent writers", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "steel-profile-test-"));
    roots.push(profileRoot);
    const { sessionService, runtimes } = makeSessionService();
    const profileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const firstId = "55555555-5555-4555-8555-555555555555";
    const secondId = "66666666-6666-4666-8666-666666666666";

    await sessionService.startSession({
      sessionId: firstId,
      profileId,
      persist: true,
      userDataDir: profileRoot,
      timezone: "UTC",
      credentials: undefined,
    });

    await expect(
      sessionService.startSession({
        sessionId: secondId,
        profileId,
        persist: true,
        userDataDir: profileRoot,
        timezone: "UTC",
        credentials: undefined,
      }),
    ).rejects.toThrow(/already in use/);

    expect(runtimes[0].launchConfigs[0].userDataDir).toBe(path.join(profileRoot, profileId));
    await sessionService.endSession(firstId);
    await expect(stat(path.join(profileRoot, profileId))).resolves.toBeDefined();
    await Promise.all(
      ["SingletonCookie", "SingletonLock", "SingletonSocket"].map((name) =>
        writeFile(path.join(profileRoot, profileId, name), "stale"),
      ),
    );

    await sessionService.startSession({
      sessionId: secondId,
      profileId,
      persist: true,
      userDataDir: profileRoot,
      timezone: "UTC",
      credentials: undefined,
    });
    expect(runtimes[1].launchConfigs[0].userDataDir).toBe(path.join(profileRoot, profileId));
    await Promise.all(
      ["SingletonCookie", "SingletonLock", "SingletonSocket"].map((name) =>
        expect(stat(path.join(profileRoot, profileId, name))).rejects.toThrow(),
      ),
    );
    await sessionService.endSession(secondId);
    await expect(stat(path.join(profileRoot, profileId))).resolves.toBeDefined();
  });
});

/** Proxy counters include long-lived tunnels only after the proxy closes. */
function createProxyServer() {
  const proxy: IProxyServer & { close: ReturnType<typeof vi.fn> } = {
    url: "http://127.0.0.1:0",
    upstreamProxyUrl: "",
    txBytes: 1_000,
    rxBytes: 2_000,
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      Object.assign(proxy, { txBytes: 3_000, rxBytes: 400_000 });
    }),
  };
  return proxy;
}

async function startProxySession(withProxy = true) {
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), "steel-proxy-session-test-"));
  roots.push(profileRoot);
  const { sessionService, runtimes } = makeSessionService();
  const proxy = createProxyServer();
  sessionService.proxyFactory = () => proxy;
  const session = await sessionService.startSession({
    userDataDir: profileRoot,
    timezone: "UTC",
    credentials: undefined,
    ...(withProxy ? { proxyUrl: "http://proxy.test:8080" } : {}),
  });
  return { sessionService, session, proxy, cdp: runtimes[0].mocks };
}

describe("SessionService proxy accounting", () => {
  it("records the counters the session's proxy settles on close", async () => {
    const { sessionService, session, proxy } = await startProxySession();

    const released = await sessionService.endSession(session.id);

    expect(proxy.close).toHaveBeenCalledExactlyOnceWith(true);
    expect(released.proxyRxBytes).toBe(400_000);
    expect(released.proxyTxBytes).toBe(3_000);
    expect(sessionService.getSession(session.id)).toMatchObject({
      proxyRxBytes: 400_000,
      proxyTxBytes: 3_000,
      status: "released",
    });
  });

  it("closes the session's proxy only after its browser is torn down", async () => {
    const { sessionService, session, proxy, cdp } = await startProxySession();
    const order: string[] = [];
    cdp.endSession.mockImplementation(async () => {
      order.push("cdp");
    });
    proxy.close.mockImplementation(async () => {
      order.push("proxy");
    });

    await sessionService.endSession(session.id);

    expect(order).toEqual(["cdp", "proxy"]);
  });

  it("leaves counters at zero for a session without a proxy", async () => {
    const { sessionService, session, proxy } = await startProxySession(false);

    const released = await sessionService.endSession(session.id);

    expect(released.proxyRxBytes).toBe(0);
    expect(released.proxyTxBytes).toBe(0);
    expect(proxy.close).not.toHaveBeenCalled();
  });

  it("settles proxy counters during cleanup when browser teardown fails", async () => {
    const { sessionService, session, proxy, cdp } = await startProxySession();
    cdp.endSession.mockRejectedValue(new Error("browser teardown failed"));

    await expect(sessionService.endSession(session.id)).rejects.toThrow("browser teardown failed");

    expect(proxy.close).toHaveBeenCalledExactlyOnceWith(true);
    expect(sessionService.getActiveSessions()).toEqual([]);
    expect(sessionService.getSession(session.id)).toMatchObject({
      proxyRxBytes: 400_000,
      proxyTxBytes: 3_000,
    });
  });
});
