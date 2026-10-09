import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  handleLaunchBrowserSession,
  handleGetBrowserContext,
  handleExitBrowserSession,
  handleGetSessionDetails,
  handleGetSessions,
  handleGetSessionStream,
  handleGetSessionLiveDetails,
  handleDiscoverCredentialForm,
  handleFillCredentialForm,
  handleGetCredentialContinuation,
  handleGetBrowserMonitorStatus,
} from "./sessions.controller.js";
import { handleScrape, handleScreenshot, handlePDF } from "../actions/actions.controller.js";
import { $ref } from "../../plugins/schemas.js";
import {
  CreateSessionRequest,
  RecordedEvents,
  SessionStreamRequest,
  SessionsScrapeRequest,
  SessionsScreenshotRequest,
  SessionsPDFRequest,
} from "./sessions.schema.js";
import { BrowserEventType, EmitEvent } from "../../types/enums.js";

async function routes(server: FastifyInstance) {
  const getRequestedCDPService = (request: FastifyRequest) => {
    const query = request.query as { sessionId?: string };
    const header = request.headers["x-session-id"];
    const sessionId = query.sessionId || (Array.isArray(header) ? header[0] : header);
    return server.sessionService.getCDPService(sessionId);
  };

  server.get(
    "/health",
    {
      schema: {
        operationId: "health",
        description: "Check if the server and browser are running",
        tags: ["Health"],
        summary: "Check if the server and browser are running",
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!server.cdpService.isRunning()) {
        return reply.status(503).send({ status: "service_unavailable" });
      }
      return reply.send({ status: "ok" });
    },
  );
  server.post(
    "/sessions",
    {
      schema: {
        operationId: "launch_browser_session",
        description: "Launch a browser session",
        tags: ["Sessions"],
        summary: "Launch a browser session",
        body: $ref("CreateSession"),
        response: {
          200: $ref("SessionDetails"),
        },
      },
    },
    async (request: CreateSessionRequest, reply: FastifyReply) =>
      handleLaunchBrowserSession(server, request, reply),
  );

  server.get(
    "/sessions",
    {
      schema: {
        operationId: "get_sessions",
        description: "Get all sessions",
        tags: ["Sessions"],
        summary: "Get all sessions",
        response: {
          200: $ref("MultipleSessions"),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) =>
      handleGetSessions(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId",
    {
      schema: {
        operationId: "get_session_details",
        description: "Get session details",
        tags: ["Sessions"],
        summary: "Get session details",
        response: {
          200: $ref("SessionDetails"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) =>
      handleGetSessionDetails(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/context",
    {
      schema: {
        operationId: "get_browser_context",
        description: "Get a browser context",
        tags: ["Sessions"],
        summary: "Get a browser context",
        response: {
          200: $ref("SessionContextSchema"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) =>
      handleGetBrowserContext(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/credential-form",
    {
      schema: {
        operationId: "discover_session_credential_form",
        description: "Discover payment and authentication fields, or explicitly request all fields",
        tags: ["Sessions"],
        summary: "Discover a form",
        querystring: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["sensitive", "all"], default: "sensitive" },
          },
          additionalProperties: false,
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Querystring: { scope?: "sensitive" | "all" };
      }>,
      reply: FastifyReply,
    ) => handleDiscoverCredentialForm(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/monitor-status",
    {},
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) =>
      handleGetBrowserMonitorStatus(server, request, reply),
  );

  server.get(
    "/sessions/:sessionId/credential-continuation",
    {},
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) =>
      handleGetCredentialContinuation(server, request, reply),
  );

  server.post(
    "/sessions/:sessionId/credential-form",
    {
      schema: {
        operationId: "fill_session_credential_form",
        description: "Fill a previously discovered form without returning its values",
        tags: ["Sessions"],
        summary: "Fill a form",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["target", "values"],
          properties: {
            target: {
              type: "object",
              additionalProperties: false,
              required: ["formId", "pageId", "frameUrl", "origin", "kind"],
              properties: {
                formId: { type: "string", minLength: 1, maxLength: 256 },
                pageId: { type: "string", minLength: 1, maxLength: 256 },
                frameUrl: { type: "string", minLength: 1, maxLength: 4096 },
                origin: { type: "string", minLength: 1, maxLength: 512 },
                kind: { type: "string", enum: ["login", "details"] },
              },
            },
            values: {
              type: "object",
              maxProperties: 40,
              additionalProperties: { type: "string", maxLength: 4096 },
            },
            submit: { type: "boolean" },
          },
        },
      },
    },
    async (
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
        };
      }>,
      reply: FastifyReply,
    ) => handleFillCredentialForm(server, request, reply),
  );

  server.post(
    "/sessions/:sessionId/release",
    {
      schema: {
        operationId: "release_browser_session",
        description: "Release a browser session",
        tags: ["Sessions"],
        summary: "Release a browser session",
        response: {
          200: $ref("ReleaseSession"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) =>
      handleExitBrowserSession(server, request, reply),
  );

  server.post(
    "/sessions/release",
    {
      schema: {
        operationId: "release_browser_sessions",
        description: "Release browser sessions",
        tags: ["Sessions"],
        summary: "Release browser sessions",
        response: {
          200: $ref("ReleaseSession"),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) =>
      handleExitBrowserSession(server, request, reply),
  );

  server.get(
    "/sessions/debug",
    {
      onRequest: [],
      schema: {
        operationId: "get_session_debugger_stream",
        description: "Returns an HTML page with a live debugger view of the session",
        tags: ["Sessions"],
        summary: "Get session debugger view",
        querystring: $ref("SessionStreamQuery"),
        response: {
          200: $ref("SessionStreamResponse"),
        },
      },
    },
    async (request: SessionStreamRequest, reply: FastifyReply) =>
      handleGetSessionStream(server, request, reply),
  );

  server.post(
    "/events",
    {
      schema: {
        operationId: "receive_events",
        description: "Receive recorded events from the browser",
        tags: ["Sessions"],
        summary: "Receive recorded events from the browser",
        body: $ref("RecordedEvents"),
      },
    },
    async (request: FastifyRequest<{ Body: RecordedEvents }>, reply: FastifyReply) => {
      getRequestedCDPService(request).getInstrumentationLogger().record({
        type: BrowserEventType.Recording,
        timestamp: new Date().toISOString(),
        data: request.body,
      });
      return reply.send({ status: "ok" });
    },
  );

  server.get(
    "/sessions/:id/live-details",
    {
      onRequest: [],
      schema: {
        operationId: "get_session_live_details",
        description:
          "Returns the live state of the session, including pages, tabs, and browser state",
        tags: ["Sessions"],
        summary: "Get session live details",
        response: {
          200: $ref("SessionLiveDetailsResponse"),
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) =>
      handleGetSessionLiveDetails(server, request, reply),
  );

  server.post(
    "/sessions/scrape",
    {
      schema: {
        operationId: "scrape_session",
        description: "Scrape Current Session",
        tags: ["Sessions"],
        summary: "Scrape Current Session",
        body: $ref("ScrapeRequest"),
        response: {
          200: $ref("ScrapeResponse"),
        },
      },
    },
    async (request: SessionsScrapeRequest, reply: FastifyReply) =>
      handleScrape(server.sessionService, getRequestedCDPService(request), request, reply),
  );

  server.post(
    "/sessions/screenshot",
    {
      schema: {
        operationId: "screenshot_session",
        description: "Take Screenshot of Current Session",
        tags: ["Sessions"],
        summary: "Take Screenshot of Current Session",
        body: $ref("ScreenshotRequest"),
        response: {
          200: $ref("ScreenshotResponse"),
        },
      },
    },
    async (request: SessionsScreenshotRequest, reply: FastifyReply) =>
      handleScreenshot(server.sessionService, getRequestedCDPService(request), request, reply),
  );

  server.post(
    "/sessions/pdf",
    {
      schema: {
        operationId: "pdf_session",
        description: "Generate PDF of Current Session",
        tags: ["Sessions"],
        summary: "Generate PDF of Current Session",
        body: $ref("PDFRequest"),
        response: {
          200: $ref("PDFResponse"),
        },
      },
    },
    async (request: SessionsPDFRequest, reply: FastifyReply) =>
      handlePDF(server.sessionService, getRequestedCDPService(request), request, reply),
  );
}

export default routes;
