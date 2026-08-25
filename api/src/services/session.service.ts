import { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import { FastifyBaseLogger } from "fastify";
import { mkdir, rm } from "fs/promises";
import os from "os";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { validate as uuidValidate, v4 as uuidv4 } from "uuid";
import { env } from "../env.js";
import { CredentialsOptions, SessionDetails } from "../modules/sessions/sessions.schema.js";
import {
  BrowserLaunchExtra,
  BrowserLauncherOptions,
  OptimizeBandwidthOptions,
} from "../types/index.js";
import { deepMerge } from "../utils/context.js";
import { IProxyServer, ProxyServer } from "../utils/proxy.js";
import { getBaseUrl, getUrl } from "../utils/url.js";
import { CDPService } from "./cdp/cdp.service.js";
import { ShutdownReason } from "./cdp/plugins/core/base-plugin.js";
import { CookieData } from "./context/types.js";
import { FileService } from "./file.service.js";
import { SeleniumService } from "./selenium.service.js";
import { TimezoneFetcher } from "./timezone-fetcher.service.js";

type Session = SessionDetails & {
  completion: Promise<void>;
  complete: (value: void) => void;
  proxyServer: IProxyServer | undefined;
};

type SessionRuntime = {
  session: Session;
  cdpService: CDPService;
  userDataDir: string;
  removeUserDataDir: boolean;
  cleanupTimer?: NodeJS.Timeout;
  ending?: Promise<SessionDetails>;
};

const sessionStats = {
  duration: 0,
  eventCount: 0,
  timeout: 0,
  creditsUsed: 0,
  proxyTxBytes: 0,
  proxyRxBytes: 0,
};

const defaultSession = {
  status: "idle" as SessionDetails["status"],
  websocketUrl: getBaseUrl("ws"),
  debugUrl: getUrl("v1/sessions/debug"),
  debuggerUrl: getUrl("v1/devtools/inspector.html"),
  sessionViewerUrl: getBaseUrl(),
  dimensions: { width: 1920, height: 1080 },
  userAgent: "",
  isSelenium: false,
  proxy: "",
  solveCaptcha: false,
};

const withSessionId = (url: string, sessionId: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set("sessionId", sessionId);
  return parsed.toString();
};

export type ProxyFactory = (
  proxyUrl: string,
  options?: OptimizeBandwidthOptions,
) => Promise<IProxyServer> | IProxyServer;

export type CDPServiceFactory = (config?: {
  keepAlive?: boolean;
  cleanupFiles?: boolean;
}) => CDPService;

export class SessionService {
  private logger: FastifyBaseLogger;
  private cdpService: CDPService;
  private createCDPService: CDPServiceFactory;
  private seleniumService: SeleniumService;
  private timezoneFetcher: TimezoneFetcher;
  private sessions = new Map<string, SessionRuntime>();
  private idleSession: Session;
  public proxyFactory: ProxyFactory = (proxyUrl) => new ProxyServer(proxyUrl);

  public pastSessions: Session[] = [];

  constructor(config: {
    cdpService: CDPService;
    createCDPService?: CDPServiceFactory;
    seleniumService: SeleniumService;
    fileService: FileService;
    logger: FastifyBaseLogger;
  }) {
    this.cdpService = config.cdpService;
    this.createCDPService =
      config.createCDPService ??
      ((serviceConfig) => new CDPService(serviceConfig ?? {}, config.logger));
    this.seleniumService = config.seleniumService;
    this.logger = config.logger;
    this.timezoneFetcher = new TimezoneFetcher(config.logger);
    this.idleSession = this.createSession({
      id: uuidv4(),
      status: "idle",
      userAgent: this.cdpService.getUserAgent() ?? "",
      dimensions: this.cdpService.getDimensions(),
    });
  }

  /**
   * Compatibility view for integrations that still assume one active session.
   * New code should address a session explicitly with getSession/getCDPService.
   */
  public get activeSession(): Session {
    const active = Array.from(this.sessions.values()).at(-1);
    return active?.session ?? this.idleSession;
  }

  public getActiveSessions(): SessionDetails[] {
    return Array.from(this.sessions.values(), ({ session }) => this.withDuration(session));
  }

  public getSession(sessionId: string): SessionDetails | undefined {
    const active = this.sessions.get(sessionId)?.session;
    if (active) return this.withDuration(active);
    return this.pastSessions.find((session) => session.id === sessionId);
  }

  public getCDPService(sessionId?: string): CDPService {
    if (sessionId) {
      const runtime = this.sessions.get(sessionId);
      if (!runtime) throw new Error(`Session ${sessionId} not found`);
      return runtime.cdpService;
    }

    if (this.sessions.size > 1) {
      throw new Error("sessionId is required when multiple sessions are active");
    }
    return Array.from(this.sessions.values()).at(-1)?.cdpService ?? this.cdpService;
  }

  public async startSession(options: {
    sessionId?: string;
    proxyUrl?: string;
    userAgent?: string;
    sessionContext?: {
      cookies?: CookieData[];
      localStorage?: Record<string, Record<string, any>>;
    };
    isSelenium?: boolean;
    fingerprint?: BrowserFingerprintWithHeaders;
    logSinkUrl?: string;
    userDataDir?: string;
    persist?: boolean;
    blockAds?: boolean;
    optimizeBandwidth?: boolean | OptimizeBandwidthOptions;
    extensions?: string[];
    timezone?: string;
    dimensions?: { width: number; height: number };
    extra?: BrowserLaunchExtra;
    credentials: CredentialsOptions;
    skipFingerprintInjection?: boolean;
    userPreferences?: Record<string, any>;
    deviceConfig?: { device: "desktop" | "mobile" };
    fullscreen?: boolean;
    headless?: boolean;
    dangerouslyLogRequestDetails?: boolean;
    captureWorkerNetwork?: boolean;
    caCertificates?: string[];
  }): Promise<SessionDetails> {
    const id = options.sessionId || uuidv4();
    if (!uuidValidate(id)) {
      throw new Error(`Invalid session ID: ${id}`);
    }
    if (
      env.MAX_CONCURRENT_SESSIONS !== undefined &&
      this.sessions.size >= env.MAX_CONCURRENT_SESSIONS
    ) {
      throw new Error(`Maximum concurrent session limit (${env.MAX_CONCURRENT_SESSIONS}) reached`);
    }
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`);
    }
    if (options.isSelenium && this.getActiveSessions().some((session) => session.isSelenium)) {
      throw new Error("Only one Selenium session can run at a time");
    }

    const proxyUrl = options.proxyUrl ?? env.PROXY_URL;
    const {
      userAgent,
      sessionContext,
      extensions,
      logSinkUrl,
      dimensions,
      fingerprint,
      isSelenium,
      blockAds,
      optimizeBandwidth,
      extra,
      credentials,
      skipFingerprintInjection,
      userPreferences,
      deviceConfig,
      fullscreen,
      headless,
      dangerouslyLogRequestDetails,
      captureWorkerNetwork,
      caCertificates,
    } = options;

    const timezonePromise = options.timezone
      ? Promise.resolve(options.timezone)
      : this.timezoneFetcher.getTimezone(
          proxyUrl,
          env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
        );

    const MIN_MOBILE_WIDTH = 508;
    const MIN_MOBILE_HEIGHT = 1074;
    const isMobileDevice = deviceConfig?.device === "mobile";
    const runtimeCDPService = isSelenium
      ? this.cdpService
      : this.createCDPService({ keepAlive: false, cleanupFiles: false });
    const resolvedDimensions = dimensions || runtimeCDPService.getDimensions();
    const finalDimensions =
      isMobileDevice && resolvedDimensions
        ? {
            width: Math.max(resolvedDimensions.width, MIN_MOBILE_WIDTH),
            height: Math.max(resolvedDimensions.height, MIN_MOBILE_HEIGHT),
          }
        : resolvedDimensions;

    const session = this.createSession({
      id,
      status: "live",
      proxy: proxyUrl,
      solveCaptcha: false,
      dimensions: finalDimensions,
      isSelenium,
      deviceConfig,
    });

    const configuredProfileRoot =
      options.userDataDir ||
      env.SESSION_PROFILE_ROOT ||
      (options.persist === true
        ? path.join(dirname(fileURLToPath(import.meta.url)), "..", "..", "user-data-dir")
        : path.join(os.tmpdir(), "steel-sessions"));
    // A caller-supplied path is a root, never the profile itself. The UUID suffix
    // prevents accidental profile sharing while allowing persistence by session ID.
    const userDataDir = path.join(configuredProfileRoot, id);

    const runtime: SessionRuntime = {
      session,
      cdpService: runtimeCDPService,
      userDataDir,
      removeUserDataDir: options.persist !== true,
    };
    this.sessions.set(id, runtime);
    if (env.SESSION_TTL_MS) {
      session.timeout = env.SESSION_TTL_MS;
      runtime.cleanupTimer = setTimeout(() => {
        this.endSession(id).catch((error) => {
          this.logger.error({ err: error, sessionId: id }, "Timed-out session cleanup failed");
        });
      }, env.SESSION_TTL_MS);
      runtime.cleanupTimer.unref();
    }
    if (!isSelenium) {
      runtimeCDPService.setDisconnectHandler(() => this.endSession(id).then(() => undefined));
    }

    const defaultUserPreferences = {
      plugins: {
        always_open_pdf_externally: true,
        plugins_disabled: ["Chrome PDF Viewer"],
      },
    };
    const mergedUserPreferences = userPreferences
      ? deepMerge(defaultUserPreferences, userPreferences)
      : defaultUserPreferences;
    const normalizedOptimize = this.normalizeOptimizeBandwidth(optimizeBandwidth);

    try {
      await mkdir(userDataDir, { recursive: true });

      if (proxyUrl) {
        session.proxyServer = await this.proxyFactory(proxyUrl, normalizedOptimize);
        await session.proxyServer.listen();
      }

      const browserLauncherOptions: BrowserLauncherOptions = {
        options: {
          headless: headless ?? env.CHROME_HEADLESS,
          proxyUrl: session.proxyServer?.url,
          downloadsPath: path.join(userDataDir, "Downloads"),
        },
        sessionContext,
        userAgent,
        blockAds,
        fingerprint,
        optimizeBandwidth: normalizedOptimize,
        extensions: extensions || [],
        logSinkUrl,
        timezone: timezonePromise,
        dimensions: finalDimensions,
        userDataDir,
        userPreferences: mergedUserPreferences,
        extra,
        credentials,
        skipFingerprintInjection,
        deviceConfig,
        fullscreen,
        dangerouslyLogRequestDetails,
        captureWorkerNetwork,
        caCertificates,
      };

      if (isSelenium) {
        await this.cdpService.shutdown(ShutdownReason.MODE_SWITCH);
        await this.seleniumService.launch(browserLauncherOptions);
        Object.assign(session, {
          websocketUrl: "",
          debugUrl: "",
          debuggerUrl: "",
          sessionViewerUrl: "",
          userAgent:
            userAgent ||
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          dimensions: runtimeCDPService.getDimensions(),
          deviceConfig,
        });
      } else {
        runtimeCDPService.getInstrumentationLogger().setContext({ sessionId: id });
        await runtimeCDPService.startNewSession(browserLauncherOptions);
        Object.assign(session, {
          websocketUrl: withSessionId(getBaseUrl("ws"), id),
          debugUrl: withSessionId(getUrl("v1/sessions/debug"), id),
          debuggerUrl: withSessionId(getUrl("v1/devtools/inspector.html"), id),
          sessionViewerUrl: withSessionId(getBaseUrl(), id),
          userAgent:
            runtimeCDPService.getUserAgent() ||
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          dimensions: runtimeCDPService.getDimensions(),
          deviceConfig,
        });
      }

      return session;
    } catch (error) {
      session.status = "failed";
      session.complete();
      if (runtime.cleanupTimer) clearTimeout(runtime.cleanupTimer);
      this.sessions.delete(id);
      await session.proxyServer?.close(true).catch(() => undefined);
      if (!isSelenium) {
        await runtimeCDPService.shutdown(ShutdownReason.LAUNCH_FAILURE).catch(() => undefined);
      }
      await this.cleanupProfile(runtime);
      this.recordPastSession(session);
      throw error;
    }
  }

  public async endSession(sessionId?: string): Promise<SessionDetails> {
    if (!sessionId && this.sessions.size > 1) {
      throw new Error("sessionId is required when multiple sessions are active");
    }
    const resolvedId = sessionId || Array.from(this.sessions.keys()).at(-1);
    if (!resolvedId) throw new Error("No active session found");
    const runtime = this.sessions.get(resolvedId);
    if (!runtime) throw new Error(`Session ${resolvedId} not found`);
    if (!runtime.ending) runtime.ending = this.releaseRuntime(resolvedId, runtime);
    return runtime.ending;
  }

  public async closeAllSessions(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.sessions.keys(), (sessionId) => this.endSession(sessionId)),
    );
    results.forEach((result) => {
      if (result.status === "rejected") {
        this.logger.error({ err: result.reason }, "Session cleanup during shutdown failed");
      }
    });
  }

  private async releaseRuntime(
    sessionId: string,
    runtime: SessionRuntime,
  ): Promise<SessionDetails> {
    const { session, cdpService } = runtime;
    if (runtime.cleanupTimer) clearTimeout(runtime.cleanupTimer);
    session.complete();
    session.status = "released";
    session.duration = Date.now() - new Date(session.createdAt).getTime();

    if (session.proxyServer) {
      session.proxyTxBytes = session.proxyServer.txBytes;
      session.proxyRxBytes = session.proxyServer.rxBytes;
    }

    try {
      if (session.isSelenium) {
        this.seleniumService.close();
        if (!this.cdpService.isRunning()) await this.cdpService.launch();
      } else {
        await cdpService.endSession();
      }
    } finally {
      await session.proxyServer?.close(true).catch(() => undefined);
      session.proxyServer = undefined;
      await this.cleanupProfile(runtime);
      this.sessions.delete(sessionId);
      this.recordPastSession(session);
    }

    return session;
  }

  private async cleanupProfile(runtime: SessionRuntime): Promise<void> {
    if (!runtime.removeUserDataDir) return;
    try {
      await rm(runtime.userDataDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn({ err: error, userDataDir: runtime.userDataDir }, "Profile cleanup failed");
    }
  }

  private createSession(overrides?: Partial<SessionDetails>): Session {
    const { promise, resolve } = Promise.withResolvers<void>();
    return {
      id: uuidv4(),
      ...defaultSession,
      ...sessionStats,
      ...overrides,
      userAgent: overrides?.userAgent ?? this.cdpService.getUserAgent() ?? "",
      createdAt: new Date().toISOString(),
      completion: promise,
      complete: resolve,
      proxyServer: undefined,
    };
  }

  private withDuration(session: Session): SessionDetails {
    return {
      ...session,
      duration:
        session.status === "live"
          ? Date.now() - new Date(session.createdAt).getTime()
          : session.duration,
    };
  }

  private recordPastSession(session: Session): void {
    if (env.MAX_RETAINED_SESSIONS === 0) return;
    this.pastSessions.unshift(session);
    if (this.pastSessions.length > env.MAX_RETAINED_SESSIONS) {
      this.pastSessions.length = env.MAX_RETAINED_SESSIONS;
    }
  }

  private normalizeOptimizeBandwidth(
    value: boolean | OptimizeBandwidthOptions | undefined,
  ): OptimizeBandwidthOptions | undefined {
    if (value === true) {
      return { blockImages: true, blockMedia: true, blockStylesheets: true };
    }
    if (value && typeof value === "object") return { ...value };
    return undefined;
  }

  public setProxyFactory(factory: ProxyFactory) {
    this.proxyFactory = factory;
  }
}
