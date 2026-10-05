import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CookieData } from "../../services/context/types.js";
import { getErrors } from "../../utils/errors.js";
import { getBaseUrl, getUrl } from "../../utils/url.js";
import {
  CredentialFormError,
  discoverCredentialForm,
  fillCredentialForm,
  getCredentialContinuation,
} from "../../services/credential-form.service.js";
import { CreateSessionRequest, SessionDetails, SessionStreamRequest } from "./sessions.schema.js";

const sessionUrl = (url: string, sessionId: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set("sessionId", sessionId);
  return parsed.toString();
};

export const handleLaunchBrowserSession = async (
  server: FastifyInstance,
  request: CreateSessionRequest,
  reply: FastifyReply,
) => {
  try {
    const {
      sessionId,
      profileId,
      proxyUrl,
      userDataDir,
      persist,
      userAgent,
      sessionContext,
      extensions,
      logSinkUrl,
      timezone,
      dimensions,
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
    } = request.body;

    return await server.sessionService.startSession({
      sessionId,
      profileId,
      proxyUrl,
      userDataDir,
      persist,
      userAgent,
      sessionContext: sessionContext as {
        cookies?: CookieData[] | undefined;
        localStorage?: Record<string, Record<string, any>> | undefined;
      },
      extensions,
      logSinkUrl,
      timezone,
      dimensions,
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
    });
  } catch (e: unknown) {
    server.log.error({ err: e }, "Failed launching browser session");
    const error = getErrors(e);
    const status =
      error.includes("already exists") || error.includes("already in use")
        ? 409
        : error.includes("Maximum concurrent")
        ? 429
        : 500;
    return reply.code(status).send({ success: false, message: error });
  }
};

export const handleExitBrowserSession = async (
  server: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const params = request.params as { sessionId?: string } | undefined;
    const sessionDetails = await server.sessionService.endSession(params?.sessionId);
    reply.send({ success: true, ...sessionDetails });
  } catch (e: unknown) {
    const error = getErrors(e);
    const status =
      error.includes("not found") || error.includes("No active")
        ? 404
        : error.includes("sessionId is required")
        ? 400
        : 500;
    return reply.code(status).send({ success: false, message: error });
  }
};

export const handleGetBrowserContext = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  try {
    const context = await server.sessionService
      .getCDPService(request.params.sessionId)
      .getBrowserState();
    return reply.send(context);
  } catch (e: unknown) {
    return reply.code(404).send({ message: getErrors(e) });
  }
};

export const handleGetSessionDetails = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  const sessionId = request.params.sessionId;
  const session = server.sessionService.getSession(sessionId);
  if (session) return reply.send(session);

  // Preserve the historical response shape for unknown/released IDs.
  return reply.send({
    id: sessionId,
    createdAt: new Date().toISOString(),
    status: "released",
    duration: 0,
    eventCount: 0,
    timeout: 0,
    creditsUsed: 0,
    websocketUrl: sessionUrl(getBaseUrl("ws"), sessionId),
    debugUrl: sessionUrl(getUrl("v1/sessions/debug"), sessionId),
    debuggerUrl: sessionUrl(getUrl("v1/devtools/inspector.html"), sessionId),
    sessionViewerUrl: sessionUrl(getBaseUrl(), sessionId),
    userAgent: "",
    isSelenium: false,
    proxy: "",
    proxyTxBytes: 0,
    proxyRxBytes: 0,
    solveCaptcha: false,
  } as SessionDetails);
};

export const handleGetSessions = async (
  server: FastifyInstance,
  _request: FastifyRequest,
  reply: FastifyReply,
) => {
  return reply.send({
    sessions: [...server.sessionService.getActiveSessions(), ...server.sessionService.pastSessions],
  });
};

export const handleGetSessionStream = async (
  server: FastifyInstance,
  request: SessionStreamRequest,
  reply: FastifyReply,
) => {
  const { sessionId, showControls, theme, interactive, pageId, pageIndex } = request.query;
  if (!sessionId && server.sessionService.getActiveSessions().length > 1) {
    return reply.code(400).send("sessionId is required when multiple sessions are active");
  }
  const session = sessionId
    ? server.sessionService.getSession(sessionId)
    : server.sessionService.activeSession;
  if (!session || session.status !== "live") {
    return reply.code(404).send("Session not found");
  }

  const singlePageMode = !!(pageId || pageIndex);
  const wsUrl = new URL(getUrl("v1/sessions/cast", "ws"));
  wsUrl.searchParams.set("sessionId", session.id);
  if (pageId) wsUrl.searchParams.set("pageId", pageId);
  else if (pageIndex) wsUrl.searchParams.set("pageIndex", pageIndex);

  return reply.view("live-session-streamer.ejs", {
    wsUrl: wsUrl.toString(),
    showControls,
    theme,
    interactive,
    dimensions: session.dimensions,
    singlePageMode,
  });
};

export const handleGetSessionLiveDetails = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  try {
    const session = server.sessionService.getSession(request.params.id);
    if (!session || session.status !== "live") {
      return reply.code(404).send({ message: `Session ${request.params.id} not found` });
    }
    const cdpService = server.sessionService.getCDPService(request.params.id);
    const pages = await cdpService.getAllPages();

    const pagesInfo = await Promise.all(
      pages.map(async (page) => {
        try {
          const pageId = page.target()._targetId;
          const title = await page.title();
          let favicon: string | null = null;
          try {
            favicon = await page.evaluate(() => {
              const iconLink = document.querySelector(
                'link[rel="icon"], link[rel="shortcut icon"]',
              );
              if (iconLink) {
                const href = iconLink.getAttribute("href");
                if (href?.startsWith("http")) return href;
                if (href?.startsWith("//")) return window.location.protocol + href;
                if (href?.startsWith("/")) return window.location.origin + href;
                return window.location.origin + "/" + href;
              }
              return null;
            });
          } catch {}

          return { id: pageId, url: page.url(), title, favicon };
        } catch (error) {
          server.log.error({ err: error }, "Error collecting page info");
          return null;
        }
      }),
    );

    const validPagesInfo = pagesInfo.filter((page) => page !== null);
    const browserVersion = await cdpService.getBrowserState();
    const viewerUrl = new URL(session.sessionViewerUrl);

    return reply.send({
      pages: validPagesInfo,
      browserState: {
        status: session.status,
        userAgent: session.userAgent,
        browserVersion,
        initialDimensions: session.dimensions || { width: 1920, height: 1080 },
        pageCount: validPagesInfo.length,
      },
      websocketUrl: session.websocketUrl,
      sessionViewerUrl: session.sessionViewerUrl,
      sessionViewerFullscreenUrl: (() => {
        viewerUrl.searchParams.set("showControls", "false");
        return viewerUrl.toString();
      })(),
    });
  } catch (error) {
    server.log.error({ err: error }, "Error getting session state");
    return reply.code(500).send({
      message: "Failed to get session state",
      error: getErrors(error),
    });
  }
};

export const handleDiscoverCredentialForm = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)) {
    return reply.code(404).send({ error: "Not found." });
  }
  try {
    const session = server.sessionService.getSession(request.params.sessionId);
    if (!session || session.status !== "live") {
      return reply.code(404).send({ error: "Session not found." });
    }
    const description = await discoverCredentialForm(
      server.sessionService.getCDPService(request.params.sessionId),
    );
    return reply.send(description);
  } catch (error) {
    const status = error instanceof CredentialFormError ? error.statusCode : 500;
    const message =
      error instanceof CredentialFormError ? error.message : "Credential form discovery failed.";
    return reply.code(status).send({ error: message });
  }
};

export const handleGetCredentialContinuation = async (
  server: FastifyInstance,
  request: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)) {
    return reply.code(404).send({ error: "Not found." });
  }
  const session = server.sessionService.getSession(request.params.sessionId);
  if (!session || session.status !== "live") {
    return reply.code(404).send({ error: "Session not found." });
  }
  reply.header("Cache-Control", "no-store");
  const continuation = await getCredentialContinuation(
    server.sessionService.getCDPService(request.params.sessionId),
  );
  return reply.send({ continuation });
};

export const handleFillCredentialForm = async (
  server: FastifyInstance,
  request: FastifyRequest<{
    Params: { sessionId: string };
    Body: {
      target: {
        formId: string;
        pageId: string;
        frameUrl: string;
        origin: string;
        kind: "login" | "details";
      };
      values: Record<string, string>;
      submit?: boolean;
      vault?: boolean;
    };
  }>,
  reply: FastifyReply,
) => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)) {
    return reply.code(404).send({ error: "Not found." });
  }
  try {
    const session = server.sessionService.getSession(request.params.sessionId);
    if (!session || session.status !== "live") {
      return reply.code(404).send({ error: "Session not found." });
    }
    const result = await fillCredentialForm(
      server.sessionService.getCDPService(request.params.sessionId),
      request.body.target,
      {
        values: request.body.values,
        submit: request.body.submit,
        vault: request.body.vault,
      },
    );
    return reply.send({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof CredentialFormError ? error.statusCode : 500;
    const message =
      error instanceof CredentialFormError ? error.message : "Credential form fill failed.";
    return reply.code(status).send({ error: message });
  }
};
