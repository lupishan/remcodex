import { Router } from "express";

import { SessionManager } from "../services/session-manager";
import { normalizeCodexExecLaunchInput } from "../utils/codex-launch";

export function createMessageRouter(sessionManager: SessionManager): Router {
  const router = Router({ mergeParams: true });

  router.post("/", (request, response, next) => {
    try {
      const body = request.body as { content?: string; codex?: unknown };
      const params = request.params as { sessionId: string };
      const launch = normalizeCodexExecLaunchInput(body.codex);
      const result = sessionManager.sendMessage(params.sessionId, body.content ?? "", launch);

      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
