import { Router } from "express";
import type { Request } from "express";

import type { ProjectManager } from "../services/project-manager";
import type { CodexRolloutSyncService } from "../services/codex-rollout-sync";
import type { EventStore } from "../services/event-store";
import type { SessionManager } from "../services/session-manager";
import type { CodexExecutionMode } from "../services/codex-runner";
import { resolveCodexUiOptions } from "../utils/codex-ui-options";
import { resolveCodexQuotaSnapshot } from "../utils/codex-quota";
import { resolveCodexStatus } from "../utils/codex-status";
import type { CodexQuotaPayload } from "../types/models";

interface CodexOptionsRouterDeps {
  sessionManager: SessionManager;
  projectManager: ProjectManager;
  eventStore: EventStore;
  codexMode: CodexExecutionMode;
  codexRolloutSync: CodexRolloutSyncService;
}

interface CodexQuotaResponse {
  quota: {
    hour: {
      percent: number | null;
      remainTime: string | null;
    };
    week: {
      percent: number | null;
      resetDate: string | null;
    };
  };
}

interface CodexHostsResponse {
  hosts: string[];
  activeHost: string | null;
}

function resolveRequestHost(request: Request): string | null {
  const requestHostname = typeof request.hostname === "string" ? request.hostname.trim() : "";
  if (requestHostname) {
    return requestHostname;
  }

  const forwardedHost = request.headers["x-forwarded-host"];
  const hostHeader = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : (typeof forwardedHost === "string" && forwardedHost.trim()
        ? forwardedHost
        : request.headers.host);
  const normalized = typeof hostHeader === "string" ? hostHeader.trim().replace(/:\d+$/, "") : "";
  return normalized || null;
}

function resolveCodexHosts(request: Request): CodexHostsResponse {
  const fallbackHost = resolveRequestHost(request);
  const rawHosts = (process.env.REMOTE_HOSTS ?? fallbackHost ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const hosts = Array.from(new Set(rawHosts));
  const requestedActive = process.env.ACTIVE_REMOTE_HOST?.trim() || "";
  const activeHost = requestedActive && hosts.includes(requestedActive)
    ? requestedActive
    : (hosts[0] ?? null);

  return {
    hosts,
    activeHost,
  };
}

function readNumberField(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }

  if (typeof input === "string" && input.trim()) {
    const parsed = Number.parseFloat(input);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toRemainingPercent(input: unknown): number | null {
  const usedPercent = readNumberField(input);
  if (usedPercent == null) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function formatRemainTime(input: unknown): string | null {
  const resetAt = readNumberField(input);
  if (resetAt == null) {
    return null;
  }

  const diffSec = Math.max(0, Math.floor(resetAt - Date.now() / 1000));
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatResetDate(input: unknown): string | null {
  const resetAt = readNumberField(input);
  if (resetAt == null) {
    return null;
  }

  const date = new Date(resetAt * 1000);
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function normalizeQuota(payload: CodexQuotaPayload | null): CodexQuotaResponse {
  const rateLimits =
    payload?.rateLimits && typeof payload.rateLimits === "object" ? payload.rateLimits : {};
  const primary =
    rateLimits.primary && typeof rateLimits.primary === "object"
      ? (rateLimits.primary as Record<string, unknown>)
      : {};
  const secondary =
    rateLimits.secondary && typeof rateLimits.secondary === "object"
      ? (rateLimits.secondary as Record<string, unknown>)
      : {};

  return {
    quota: {
      hour: {
        percent: toRemainingPercent(primary.used_percent),
        remainTime: formatRemainTime(primary.resets_at),
      },
      week: {
        percent: toRemainingPercent(secondary.used_percent),
        resetDate: formatResetDate(secondary.resets_at),
      },
    },
  };
}

function readRuntimeFailureHint(
  runtime: {
    executionMode: "codex exec --json" | "codex app-server";
    interactiveApprovalUi: boolean;
    cwd: string | null;
    workspaceRoot: string | null;
    sandboxMode: string | null;
    approvalMode: string | null;
    writableRoots: string[];
  },
): string[] {
  const hints: string[] = [];

  if (runtime.sandboxMode === "read-only") {
    hints.push("The current runtime is using a read-only sandbox. File writes and environment-changing commands are blocked.");
  } else if (runtime.sandboxMode === "workspace-write") {
    hints.push("The current runtime is using a workspace-write sandbox. It can only write inside the current writable roots.");
  }

  if (!runtime.interactiveApprovalUi) {
    hints.push(`The current ${runtime.executionMode} runtime path does not support interactive approval prompts.`);
  }

  if (runtime.workspaceRoot) {
    hints.push(`The current workspace root is ${runtime.workspaceRoot}.`);
  }

  return hints;
}

export function createCodexOptionsRouter(deps: CodexOptionsRouterDeps): Router {
  const router = Router();

  router.get("/mode", (_request, response) => {
    response.json(resolveCodexUiOptions());
  });

  router.get("/ui-options", (_request, response) => {
    response.json(resolveCodexUiOptions());
  });

  router.get("/status", (request, response) => {
    const params = request.query as {
      sessionId?: string;
      threadId?: string;
      cwd?: string;
    };

    let threadId = params.threadId?.trim() || "";
    let cwd = params.cwd?.trim() || "";

    if (params.sessionId?.trim()) {
      const session = deps.sessionManager.getSession(params.sessionId.trim());
      if (session) {
        threadId = threadId || session.codex_thread_id || "";
        if (threadId) {
          if (!cwd) {
            const project = deps.projectManager.getProject(session.project_id);
            cwd = project?.path || "";
          }
        } else {
          response.json({
            thread: null,
            source: "none",
            fetchedAt: new Date().toISOString(),
          });
          return;
        }
      }
    }

    const status = resolveCodexStatus({
      threadId: threadId || null,
      cwd: cwd || null,
      executionMode:
        deps.codexMode === "app-server" ? "codex app-server" : "codex exec --json",
      interactiveApprovalUi: deps.codexMode === "app-server",
    });

    response.json({
      ...status,
      runtimeHints: readRuntimeFailureHint(status.runtime),
    });
  });

  router.get("/quota", (request, response) => {
    const params = request.query as {
      sessionId?: string;
    };

    if (!params.sessionId?.trim()) {
      response.status(400).json({ error: "sessionId is required." });
      return;
    }

    const session = deps.sessionManager.getSession(params.sessionId.trim());
    if (!session) {
      response.status(404).json({ error: "Session not found." });
      return;
    }

    let payload = deps.eventStore.latestQuota(session.id);
    if (!payload) {
      const project = deps.projectManager.getProject(session.project_id);
      const restored = resolveCodexQuotaSnapshot({
        threadId: session.codex_thread_id,
        cwd: project?.path || null,
      });

      if (restored) {
        deps.eventStore.append(session.id, {
          type: "token_count",
          turnId: null,
          messageId: null,
          callId: null,
          requestId: null,
          phase: null,
          stream: null,
          payload: restored,
        });
        payload = restored;
      }
    }

    response.json(normalizeQuota(payload));
  });

  router.get("/hosts", (request, response) => {
    response.json(resolveCodexHosts(request));
  });

  router.get("/importable-sessions", (_request, response) => {
    response.json({
      items: deps.codexRolloutSync.listImportableSessions(),
    });
  });

  return router;
}
