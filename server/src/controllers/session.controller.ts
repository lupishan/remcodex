import { Router } from "express";

import { EventStore } from "../services/event-store";
import { CodexRolloutSyncService } from "../services/codex-rollout-sync";
import { ProjectManager } from "../services/project-manager";
import { SessionManager } from "../services/session-manager";
import { SessionTimelineService } from "../services/session-timeline-service";

export function createSessionRouter(
  sessionManager: SessionManager,
  eventStore: EventStore,
  projectManager: ProjectManager,
  codexRolloutSync: CodexRolloutSyncService,
  sessionTimeline: SessionTimelineService,
): Router {
  const router = Router();

  router.get("/", (_request, response) => {
    const items = sessionManager.listSessions().map((session) => ({
      sessionId: session.id,
      title: session.title,
      projectId: session.project_id,
      status: session.status,
      liveBusy: sessionManager.isLiveBusy(session.id),
      codexThreadId: session.codex_thread_id,
      sourceKind: session.source_kind,
      sourceRolloutPath: session.source_rollout_path,
      sourceThreadId: session.source_thread_id,
      sourceRolloutHasOpenTurn: session.source_rollout_has_open_turn === 1,
      pendingApproval: sessionManager.getPendingApproval(session.id),
      lastEventAt: session.last_event_at,
      lastAssistantContent: session.last_assistant_content,
      lastCommand: session.last_command,
      eventCount: session.event_count,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    }));

    response.json({ items });
  });

  router.post("/import-codex", (request, response, next) => {
    try {
      const body = request.body as { rolloutPath?: string };
      const result = codexRolloutSync.importRollout(body.rolloutPath ?? "");
      response.status(result.imported ? 201 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", (request, response, next) => {
    try {
      const body = request.body as { title?: string; projectId?: string };
      const session = sessionManager.createSession({
        title: body.title,
        projectId: body.projectId ?? "",
      });

      response.status(201).json({
        sessionId: session.id,
        status: session.status,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:sessionId", (request, response, next) => {
    try {
      const session = sessionManager.getSession(request.params.sessionId);
      if (!session) {
        response.status(404).json({ error: "Session not found." });
        return;
      }

      const project = projectManager.getProject(session.project_id);

      response.json({
        sessionId: session.id,
        title: session.title,
        projectId: session.project_id,
        projectName: project?.name ?? null,
        projectPath: project?.path ?? null,
        status: session.status,
        liveBusy: sessionManager.isLiveBusy(session.id),
        pid: session.pid,
        codexThreadId: session.codex_thread_id,
        sourceKind: session.source_kind,
        sourceRolloutPath: session.source_rollout_path,
        sourceThreadId: session.source_thread_id,
        sourceRolloutHasOpenTurn: session.source_rollout_has_open_turn === 1,
        pendingApproval: sessionManager.getPendingApproval(session.id),
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:sessionId/events", (request, response, next) => {
    try {
      const after = Number.parseInt(
        String(request.query.after ?? request.query.cursor ?? "0"),
        10,
      );
      const before = Number.parseInt(String(request.query.before ?? "0"), 10);
      const limit = Number.parseInt(String(request.query.limit ?? "200"), 10);
      const safeAfter = Number.isNaN(after) ? 0 : after;
      const safeBefore = Number.isNaN(before) ? 0 : before;
      const safeLimit = Number.isNaN(limit) ? 200 : limit;

      if (!sessionManager.hasSession(request.params.sessionId)) {
        response.status(404).json({ error: "Session not found." });
        return;
      }

      const data = eventStore.list(request.params.sessionId, {
        after: safeAfter,
        before: safeBefore,
        limit: safeLimit,
      });
      response.json(data);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:sessionId/timeline", (request, response, next) => {
    try {
      const after = Number.parseInt(
        String(request.query.after ?? request.query.cursor ?? "0"),
        10,
      );
      const before = Number.parseInt(String(request.query.before ?? "0"), 10);
      const limit = Number.parseInt(String(request.query.limit ?? "200"), 10);
      const safeAfter = Number.isNaN(after) ? 0 : after;
      const safeBefore = Number.isNaN(before) ? 0 : before;
      const safeLimit = Number.isNaN(limit) ? 200 : limit;

      if (!sessionManager.hasSession(request.params.sessionId)) {
        response.status(404).json({ error: "Session not found." });
        return;
      }

      const data = sessionTimeline.list(request.params.sessionId, {
        after: safeAfter,
        before: safeBefore,
        limit: safeLimit,
      });
      response.json(data);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:sessionId/sync", (request, response, next) => {
    try {
      const result = codexRolloutSync.syncImportedSession(request.params.sessionId);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:sessionId/stop", (request, response, next) => {
    try {
      const result = sessionManager.stopSession(request.params.sessionId);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:sessionId/approvals/:requestId", (request, response, next) => {
    try {
      const body = request.body as { decision?: string };
      const decision =
        body.decision === "accept" ||
        body.decision === "acceptForSession" ||
        body.decision === "decline"
          ? body.decision
          : null;
      if (!decision) {
        response.status(400).json({ error: "decision is required." });
        return;
      }

      const requestId = String(request.params.requestId || "").trim();
      if (!requestId) {
        response.status(400).json({ error: "requestId is invalid." });
        return;
      }

      const result = sessionManager.resolveApproval(
        request.params.sessionId,
        requestId,
        decision,
      );
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
