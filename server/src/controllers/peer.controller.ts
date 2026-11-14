import { Router } from "express";

import { PeerCommunicationService } from "../services/peer-communication";

function bearer(request: import("express").Request): string {
  const match = request.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function createPeerRouter(peer: PeerCommunicationService): Router {
  const router = Router();
  const actor = (request: import("express").Request) => peer.authenticate(bearer(request));

  router.post("/credentials", (request, response, next) => {
    try {
      const body = request.body as { workerId?: string; sessionId?: string; scopes?: string[]; leaseMs?: number };
      const credential = peer.issueWorkerCredential(actor(request), {
        workerId: String(body.workerId ?? ""),
        sessionId: String(body.sessionId ?? ""),
        scopes: (body.scopes ?? []) as never,
        leaseMs: body.leaseMs,
      });
      response.status(201).json(credential);
    } catch (error) {
      next(error);
    }
  });

  router.post("/grants", (request, response, next) => {
    try {
      const body = request.body as { sourceWorkerId?: string; targetWorkerId?: string; workPackageId?: string; scope?: string };
      response.status(201).json(peer.grant(actor(request), {
        sourceWorkerId: String(body.sourceWorkerId ?? ""),
        targetWorkerId: String(body.targetWorkerId ?? ""),
        workPackageId: String(body.workPackageId ?? ""),
        scope: body.scope as never,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/grants/:grantId", (request, response, next) => {
    try {
      peer.revoke(actor(request), request.params.grantId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/messages", (request, response, next) => {
    try {
      response.status(201).json(peer.appendMessage(bearer(request), request.body));
    } catch (error) {
      next(error);
    }
  });

  router.get("/mailbox/:grantId", (request, response, next) => {
    try {
      response.json(peer.readMailbox(bearer(request), request.params.grantId, Number(request.query.limit ?? 100)));
    } catch (error) {
      next(error);
    }
  });

  router.put("/summaries/:grantId", (request, response, next) => {
    try {
      peer.publishSummary(bearer(request), request.params.grantId, request.body);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/summaries/:grantId", (request, response, next) => {
    try {
      response.json({ summary: peer.readSummary(bearer(request), request.params.grantId) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/timeline/:grantId", (request, response, next) => {
    try {
      response.json({ items: peer.readTimeline(bearer(request), request.params.grantId, Number(request.query.limit ?? 100)) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
