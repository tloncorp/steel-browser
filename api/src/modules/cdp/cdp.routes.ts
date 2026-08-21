import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { $ref } from "../../plugins/schemas.js";
import cdpSchemas from "./cdp.schemas.js";

async function routes(server: FastifyInstance) {
  server.get(
    "/devtools/inspector.html",
    {
      schema: {
        operationId: "getDevtoolsUrl",
        description: "Get the URL for the DevTools inspector",
        tags: ["CDP"],
        summary: "Get the URL for the DevTools inspector",
        querystring: $ref("GetDevtoolsUrlSchema"),
      },
    },
    async (
      request: FastifyRequest<{ Querystring: z.infer<typeof cdpSchemas.GetDevtoolsUrlSchema> }>,
      reply: FastifyReply,
    ) => {
      const cdpService = server.sessionService.getCDPService(request.query.sessionId);
      const debuggerWsUrl = new URL(cdpService.getDebuggerWsUrl(request.query.pageId));
      if (request.query.sessionId) {
        debuggerWsUrl.searchParams.set("sessionId", request.query.sessionId);
      }
      return reply.redirect(
        `${cdpService.getDebuggerUrl()}?ws=${debuggerWsUrl.toString().replace("ws:", "")}`,
      );
    },
  );
}

export default routes;
