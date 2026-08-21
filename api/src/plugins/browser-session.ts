import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { SessionService } from "../services/session.service.js";

const browserSessionPlugin: FastifyPluginAsync = async (fastify, _options) => {
  const sessionService = new SessionService({
    cdpService: fastify.cdpService,
    createCDPService: fastify.createCDPService,
    seleniumService: fastify.seleniumService,
    fileService: fastify.fileService,
    logger: fastify.log,
  });
  fastify.decorate("sessionService", sessionService);
  fastify.addHook("onClose", async () => sessionService.closeAllSessions());
};

export default fp(browserSessionPlugin, "5.x");
