import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DatabaseClient } from "../db/client";
import type { CodexExecLaunchInput } from "../types/codex-launch";
import type {
  AssistantPhase,
  CodexQuotaPayload,
  CommandEndPayload,
  CommandStartPayload,
  EventInsertInput,
  PatchEndPayload,
  PatchStartPayload,
  SessionApprovalPayload,
  SessionApprovalResolvedPayload,
  SessionListRecord,
  SessionRecord,
  SessionStatus,
} from "../types/models";
import { AppError } from "../utils/errors";
import { createId } from "../utils/ids";
import { appendCappedText } from "../utils/output-limits";
import type { CodexJsonEvent } from "./codex-exec-runner";
import { createCodexRunner, type CodexExecutionMode, type CodexRunner } from "./codex-runner";
import {
  isCodexAppServerMessage,
  isCodexEnvelopeEvent,
  isCodexLegacyEvent,
  translateCodexAppServerMessage,
  type CodexSemanticSignal,
  type SemanticEventDraft,
} from "./codex-stream-events";
import { EventStore } from "./event-store";
import { ProjectManager } from "./project-manager";

interface MessageRuntimeState {
  messageId: string;
  phase: AssistantPhase;
  text: string;
  started: boolean;
  completed: boolean;
}

interface ReasoningRuntimeState {
  messageId: string;
  text: string;
  started: boolean;
  completed: boolean;
}

interface CommandRuntimeState {
  callId: string;
  command: string | null;
  cwd: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  started: boolean;
  completed: boolean;
}

interface PatchRuntimeState {
  callId: string;
  text: string;
  started: boolean;
  completed: boolean;
}

interface RunnerState {
  runner: CodexRunner;
  stopRequested: boolean;
  transientSeqCursor: number;
  turnId: string;
  appTurnId: string | null;
  turnStarted: boolean;
  turnFinalized: boolean;
  assistantByPhase: Map<AssistantPhase, string>;
  messagesById: Map<string, MessageRuntimeState>;
  reasoning: ReasoningRuntimeState | null;
  commandsByCallId: Map<string, CommandRuntimeState>;
  patchesByCallId: Map<string, PatchRuntimeState>;
  activeCommandCallId: string | null;
  activePatchCallId: string | null;
}

interface PendingApproval {
  requestId: string;
  runnerRequestId: number | null;
  sessionId: string;
  turnId: string | null;
  callId: string | null;
  method: string;
  params: Record<string, unknown>;
  createdAt: string;
}

interface SessionManagerOptions {
  db: DatabaseClient;
  eventStore: EventStore;
  projectManager: ProjectManager;
  codexCommand: string;
  codexMode: CodexExecutionMode;
}

function nowIso(): string {
  return new Date().toISOString();
}

const TRANSIENT_SEQ_STEP = 0.00001;

function shouldAutotitleSession(title: string | null | undefined): boolean {
  const normalized = String(title || "").trim();
  return (
    !normalized ||
    normalized === "未命名会话" ||
    normalized === "新会话" ||
    normalized === "Untitled session" ||
    normalized === "New session"
  );
}

function deriveSessionTitleFromMessage(message: string): string {
  const normalized = String(message || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Untitled session";
  }
  if (normalized.length <= 28) {
    return normalized;
  }
  return `${normalized.slice(0, 27)}…`;
}

function resolveDemoWorkspacePath(): string {
  return path.join(os.homedir(), "remcodex-demo", "demo-workspace");
}

function resolveDemoOutsideTargetPath(): string {
  return path.join(
    os.homedir(),
    "remcodex-demo",
    "outside-target",
    "demo-from-remcodex.txt",
  );
}

function containsExplicitFilesystemTarget(message: string): boolean {
  const text = String(message || "");
  return /(?:\/Users\/|\/tmp\b|~\/)/.test(text);
}

function shouldForceDemoApprovalPath(projectPath: string, message: string): boolean {
  const normalizedProjectPath = path.resolve(String(projectPath || "").trim());
  if (normalizedProjectPath !== resolveDemoWorkspacePath()) {
    return false;
  }

  const normalizedMessage = String(message || "").toLowerCase();
  const mentionsOutsideWorkspace =
    normalizedMessage.includes("outside the current workspace") ||
    normalizedMessage.includes("outside the workspace") ||
    normalizedMessage.includes("outside current workspace") ||
    normalizedMessage.includes("工作区外") ||
    normalizedMessage.includes("当前工作区外");

  if (!mentionsOutsideWorkspace) {
    return false;
  }

  return !containsExplicitFilesystemTarget(message);
}

function normalizeDemoPrompt(projectPath: string, message: string): string {
  if (!shouldForceDemoApprovalPath(projectPath, message)) {
    return message;
  }

  const targetPath = resolveDemoOutsideTargetPath();
  return `${message.trim()}\n\nUse this exact target path: ${targetPath}`;
}

export class SessionManager {
  private readonly runners = new Map<string, RunnerState>();
  private readonly pendingApprovals = new Map<string, Map<string, PendingApproval>>();
  private readonly sessionWritableRoots = new Map<string, Set<string>>();

  constructor(private readonly options: SessionManagerOptions) {}

  listSessions(): SessionListRecord[] {
    return this.options.db
      .prepare(
        `
          SELECT
            s.id,
            s.title,
            s.project_id,
            s.status,
            s.pid,
            s.codex_thread_id,
            s.source_kind,
            s.source_rollout_path,
            s.source_thread_id,
            s.source_sync_cursor,
            s.source_last_synced_at,
            s.source_rollout_has_open_turn,
            s.created_at,
            s.updated_at,
            (
              SELECT e.created_at
              FROM session_events e
              WHERE e.session_id = s.id
              ORDER BY e.seq DESC
              LIMIT 1
            ) AS last_event_at,
            (
              SELECT json_extract(e.payload_json, '$.text')
              FROM session_events e
              WHERE e.session_id = s.id
                AND e.event_type = 'message.assistant.end'
              ORDER BY e.seq DESC
              LIMIT 1
            ) AS last_assistant_content,
            (
              SELECT json_extract(e.payload_json, '$.command')
              FROM session_events e
              WHERE e.session_id = s.id
                AND e.event_type = 'command.start'
              ORDER BY e.seq DESC
              LIMIT 1
            ) AS last_command,
            (
              SELECT COUNT(*)
              FROM session_events e
              WHERE e.session_id = s.id
            ) AS event_count
          FROM sessions s
          ORDER BY COALESCE(last_event_at, s.updated_at) DESC
        `,
      )
      .all() as SessionListRecord[];
  }

  isLiveBusy(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const runtime = this.runners.get(sessionId);
    if (!runtime || !runtime.runner.isAlive()) {
      return false;
    }

    return ["starting", "running", "stopping"].includes(session.status);
  }

  getSession(sessionId: string): SessionRecord | null {
    return (
      (this.options.db
        .prepare(
          `
            SELECT
              id,
              title,
              project_id,
              status,
              pid,
              codex_thread_id,
              source_kind,
              source_rollout_path,
              source_thread_id,
              source_sync_cursor,
              source_last_synced_at,
              source_rollout_has_open_turn,
              created_at,
              updated_at
            FROM sessions
            WHERE id = ?
          `,
        )
        .get(sessionId) as SessionRecord | undefined) ?? null
    );
  }

  getPendingApproval(sessionId: string): SessionApprovalPayload | null {
    const pending = this.pendingApprovals.get(sessionId);
    const live = pending
      ? [...pending.values()].sort((a, b) => {
          const aParsed = Number.parseInt(a.requestId, 10);
          const bParsed = Number.parseInt(b.requestId, 10);
          const aId = a.runnerRequestId ?? (Number.isFinite(aParsed) ? aParsed : 0);
          const bId = b.runnerRequestId ?? (Number.isFinite(bParsed) ? bParsed : 0);
          return aId - bId;
        })[0]
      : null;
    if (live) {
      return {
        ...this.serializePendingApproval(live),
        resumable: true,
        source: "live",
      };
    }

    const restored = this.options.eventStore.latestPendingApproval(sessionId);
    if (!restored) {
      return null;
    }

    return {
      ...restored,
      resumable: false,
      source: "event-log",
    };
  }

  createSession(input: { projectId: string; title?: string }): SessionRecord {
    const project = this.options.projectManager.getProject(input.projectId);
    if (!project) {
      throw new AppError(404, "Project not found.");
    }

    const timestamp = nowIso();
    const session: SessionRecord = {
      id: createId("sess"),
      title: input.title?.trim() || "Untitled session",
      project_id: project.id,
      status: "idle",
      pid: null,
      codex_thread_id: null,
      source_kind: "native",
      source_rollout_path: null,
      source_thread_id: null,
      source_sync_cursor: null,
      source_last_synced_at: null,
      source_rollout_has_open_turn: 0,
      created_at: timestamp,
      updated_at: timestamp,
    };

    this.options.db
      .prepare(
        `
          INSERT INTO sessions (
            id,
            title,
            project_id,
            status,
            pid,
            codex_thread_id,
            source_kind,
            source_rollout_path,
            source_thread_id,
            source_sync_cursor,
            source_last_synced_at,
            source_rollout_has_open_turn,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        session.id,
        session.title,
        session.project_id,
        session.status,
        session.pid,
        session.codex_thread_id,
        session.source_kind,
        session.source_rollout_path,
        session.source_thread_id,
        session.source_sync_cursor,
        session.source_last_synced_at,
        session.source_rollout_has_open_turn,
        session.created_at,
        session.updated_at,
      );

    return session;
  }

  sendMessage(
    sessionId: string,
    content: string,
    codexLaunch?: CodexExecLaunchInput,
  ): { accepted: true; eventId: string; turnId: string; seq: number } {
    const message = content.trim();
    if (!message) {
      throw new AppError(400, "Message content is required.");
    }

    const session = this.getSessionOrThrow(sessionId);
    const project = this.options.projectManager.getProject(session.project_id);
    if (!project) {
      throw new AppError(404, "Project not found for session.");
    }
    const runtimePrompt = normalizeDemoPrompt(project.path, message);

    const currentRunner = this.runners.get(sessionId);
    const busyStatuses: SessionStatus[] = ["starting", "running", "stopping"];
    if (currentRunner?.runner.isAlive() && busyStatuses.includes(session.status)) {
      throw new AppError(409, "Session already has an active task.");
    }

    if (shouldAutotitleSession(session.title)) {
      this.options.db
        .prepare(
          `
            UPDATE sessions
            SET title = ?, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(deriveSessionTitleFromMessage(message), nowIso(), sessionId);
    }

    const turnId = createId("turn");
    const event = this.appendEvent(sessionId, {
      type: "message.user",
      turnId,
      messageId: null,
      callId: null,
      requestId: null,
      phase: null,
      stream: null,
      payload: {
        text: message,
      },
    });

    this.startRunner(
      sessionId,
      project.path,
      runtimePrompt,
      turnId,
      this.resolveResumeThreadId(session),
      codexLaunch,
    );

    return {
      accepted: true,
      eventId: event.id,
      turnId,
      seq: event.seq,
    };
  }

  stopSession(sessionId: string): { accepted: true } {
    const runtime = this.runners.get(sessionId);
    if (!runtime || !runtime.runner.isAlive()) {
      this.setStatus(sessionId, "idle");
      return { accepted: true };
    }

    runtime.stopRequested = true;
    this.setStatus(sessionId, "stopping");
    runtime.runner.stop();
    return { accepted: true };
  }

  retryApprovalRequest(
    sessionId: string,
    requestId: string,
    codexLaunch?: CodexExecLaunchInput,
  ): { accepted: true; turnId: string } {
    const session = this.getSessionOrThrow(sessionId);
    const project = this.options.projectManager.getProject(session.project_id);
    if (!project) {
      throw new AppError(404, "Project not found for session.");
    }

    const currentRunner = this.runners.get(sessionId);
    const busyStatuses: SessionStatus[] = ["starting", "running", "stopping"];
    if (currentRunner?.runner.isAlive() && busyStatuses.includes(session.status)) {
      throw new AppError(409, "Session already has an active task.");
    }

    const pending =
      this.pendingApprovals.get(sessionId)?.get(requestId) ??
      this.restorePendingApprovalFromEvents(sessionId, requestId);
    if (!pending) {
      throw new AppError(404, "Approval request not found.");
    }

    const turnId = createId("turn");
    const runtimePrompt = normalizeDemoPrompt(
      project.path,
      this.buildApprovalRetryRuntimePrompt(pending),
    );

    this.startRunner(
      sessionId,
      project.path,
      runtimePrompt,
      turnId,
      this.resolveResumeThreadId(session),
      codexLaunch,
    );

    return {
      accepted: true,
      turnId,
    };
  }

  resolveApproval(
    sessionId: string,
    requestId: string,
    decision: "accept" | "acceptForSession" | "decline",
  ): { accepted: true } {
    const runtime = this.runners.get(sessionId);
    if (!runtime?.runner.isAlive()) {
      throw new AppError(409, "Session has no active runtime.");
    }

    const pending =
      this.pendingApprovals.get(sessionId)?.get(requestId) ??
      this.restorePendingApprovalFromEvents(sessionId, requestId);
    if (!pending) {
      throw new AppError(404, "Approval request not found.");
    }

    const payload = this.buildApprovalResponsePayload(pending, decision);
    const runnerRequestId = pending.runnerRequestId;
    if (!Number.isFinite(runnerRequestId) || runnerRequestId === null) {
      throw new AppError(409, "Approval request can no longer be resumed.");
    }

    if (!runtime.runner.respond(runnerRequestId, payload)) {
      throw new AppError(409, "Current runner cannot resolve approval requests.");
    }

    this.consumePendingApproval(sessionId, requestId, decision);
    return { accepted: true };
  }

  hasSession(sessionId: string): boolean {
    return this.getSession(sessionId) !== null;
  }

  private startRunner(
    sessionId: string,
    cwd: string,
    prompt: string,
    turnId: string,
    threadId?: string | null,
    codexLaunch?: CodexExecLaunchInput,
  ): RunnerState {
    const existing = this.runners.get(sessionId);
    if (existing?.runner.isAlive()) {
      return existing;
    }

    const runner = createCodexRunner(this.options.codexMode, this.options.codexCommand, cwd);
    const effectiveLaunch = this.withSessionWritableRoots(sessionId, codexLaunch);
    const runtime: RunnerState = {
      runner,
      stopRequested: false,
      transientSeqCursor: this.options.eventStore.latestSeq(sessionId),
      turnId,
      appTurnId: null,
      turnStarted: false,
      turnFinalized: false,
      assistantByPhase: new Map(),
      messagesById: new Map(),
      reasoning: null,
      commandsByCallId: new Map(),
      patchesByCallId: new Map(),
      activeCommandCallId: null,
      activePatchCallId: null,
    };

    this.runners.set(sessionId, runtime);
    this.setStatus(sessionId, "starting");

    runner.onJsonEvent((raw) => {
      if (isCodexAppServerMessage(raw)) {
        this.handleAppServerMessage(sessionId, runtime, raw);
        return;
      }

      if (isCodexLegacyEvent(raw)) {
        this.handleLegacyEvent(sessionId, runtime, raw);
        return;
      }

      if (isCodexEnvelopeEvent(raw)) {
        this.handleEnvelopeEvent(sessionId, runtime, raw);
      }
    });

    runner.onText((_stream, _text) => {
      // raw stdout/stderr no longer belongs to the primary event protocol
    });

    runner.onExit((exitCode) => {
      this.handleRunnerExit(sessionId, runtime, exitCode);
    });

    try {
      const pid = runner.start(prompt, threadId, effectiveLaunch);
      this.setPid(sessionId, pid);
    } catch (error) {
      this.runners.delete(sessionId);
      this.setStatus(sessionId, "failed");
      this.appendError(sessionId, runtime.turnId, `Failed to start Codex CLI: ${this.messageOf(error)}`);
      throw new AppError(500, `Failed to start Codex CLI: ${this.messageOf(error)}`);
    }

    return runtime;
  }

  private resolveResumeThreadId(session: SessionRecord): string | null {
    if (session.source_kind === "imported_rollout") {
      const importedThreadId = String(session.source_thread_id || "").trim();
      if (importedThreadId) {
        return importedThreadId;
      }
    }

    const nativeThreadId = String(session.codex_thread_id || "").trim();
    return nativeThreadId || null;
  }

  private handleAppServerMessage(
    sessionId: string,
    runtime: RunnerState,
    raw: { method: string; params?: unknown; id?: number },
  ): void {
    const signals = translateCodexAppServerMessage(raw);
    for (const signal of signals) {
      this.applySemanticSignal(sessionId, runtime, signal);
    }
  }

  private handleLegacyEvent(sessionId: string, runtime: RunnerState, event: CodexJsonEvent): void {
    if (event.type === "thread.started" && event.thread_id) {
      this.setCodexThreadId(sessionId, event.thread_id);
      return;
    }

    if (event.type === "item.started" && event.item?.type === "command_execution") {
      this.ensureTurnStarted(sessionId, runtime);
      const callId = this.resolveCommandCallId(runtime, event.item.id || null);
      this.ensureCommandStart(sessionId, runtime, callId, {
        command: event.item.command || "",
        cwd: null,
      });
      return;
    }

    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      this.ensureTurnStarted(sessionId, runtime);
      this.finishAssistantMessage(sessionId, runtime, "final_answer", event.item.id || null, event.item.text || "");
      return;
    }

    if (event.type === "item.completed" && event.item?.type === "command_execution") {
      this.ensureTurnStarted(sessionId, runtime);
      const callId = this.resolveCommandCallId(runtime, event.item.id || null);
      this.ensureCommandStart(sessionId, runtime, callId, {
        command: event.item.command || "",
        cwd: null,
      });
      if (event.item.aggregated_output) {
        this.appendCommandOutputDelta(sessionId, runtime, callId, "stdout", event.item.aggregated_output);
      }
      this.finishCommand(sessionId, runtime, callId, {
        command: event.item.command || null,
        cwd: null,
        status: event.item.status || (event.item.exit_code === 0 ? "completed" : "failed"),
        exitCode: event.item.exit_code ?? null,
      });
      return;
    }

    if (event.type === "turn.completed") {
      if (event.usage) {
        this.appendTokenCount(sessionId, runtime.turnId, {
          rateLimits: {},
          totalTokenUsage: {
            input_tokens: event.usage.input_tokens ?? 0,
            cached_input_tokens: event.usage.cached_input_tokens ?? 0,
            output_tokens: event.usage.output_tokens ?? 0,
          },
          receivedAt: nowIso(),
          source: "live",
        });
      }
      this.completeTurn(sessionId, runtime, "turn.completed", {
        completedAt: nowIso(),
      });
    }
  }

  private handleEnvelopeEvent(sessionId: string, runtime: RunnerState, raw: unknown): void {
    if (!raw || typeof raw !== "object") {
      return;
    }

    const envelope = raw as { type?: unknown; payload?: unknown };
    const payload =
      envelope.payload && typeof envelope.payload === "object"
        ? (envelope.payload as Record<string, unknown>)
        : null;

    if (envelope.type === "event_msg" && payload?.type === "token_count") {
      const normalized = this.normalizeTokenCountPayload(payload);
      if (normalized) {
        this.appendTokenCount(sessionId, runtime.turnId, normalized);
      }
      return;
    }

    if (envelope.type !== "response_item" || !payload) {
      return;
    }

    const itemType = typeof payload.type === "string" ? payload.type : "";
    if (itemType === "message" && payload.role === "assistant") {
      const phase = this.normalizeAssistantPhase(payload.phase);
      const text = this.extractResponseItemMessageText(payload);
      if (text) {
        this.ensureTurnStarted(sessionId, runtime);
        this.finishAssistantMessage(sessionId, runtime, phase, this.readString(payload.id), text);
      }
      return;
    }

    if (itemType === "reasoning") {
      const summary = this.readString(payload.summary) || "";
      this.ensureTurnStarted(sessionId, runtime);
      const messageId = this.resolveReasoningMessageId(runtime, this.readString(payload.id));
      this.ensureReasoningStart(sessionId, runtime, messageId, summary || null);
      if (summary) {
        this.appendReasoningDelta(sessionId, runtime, messageId, summary, summary);
      }
      this.finishReasoning(sessionId, runtime, messageId, summary || null);
      return;
    }

    if (itemType === "function_call" && payload.name === "exec_command") {
      this.ensureTurnStarted(sessionId, runtime);
      const callId = this.resolveCommandCallId(runtime, this.readString(payload.call_id));
      const args = this.parseJsonObject(this.readString(payload.arguments));
      this.ensureCommandStart(sessionId, runtime, callId, {
        command: this.readString(args.cmd) || "",
        cwd: this.readString(args.cwd),
        justification: this.readString(args.justification),
        sandboxMode: this.readString(args.sandbox) || this.readString(args.sandbox_permissions),
        approvalRequired: this.readString(args.sandbox_permissions) === "require_escalated",
        grantRoot: this.readString(args.grantRoot),
      });
      return;
    }

    if (itemType === "function_call_output") {
      this.ensureTurnStarted(sessionId, runtime);
      const callId = this.resolveCommandCallId(runtime, this.readString(payload.call_id));
      const output = this.readString(payload.output) || "";
      if (output) {
        this.appendCommandOutputDelta(sessionId, runtime, callId, "stdout", output);
      }
      return;
    }

    if (itemType === "custom_tool_call") {
      this.ensureTurnStarted(sessionId, runtime);
      const callId = this.resolvePatchCallId(runtime, this.readString(payload.call_id));
      this.ensurePatchStart(sessionId, runtime, callId, {
        summary: this.readString(payload.name),
        target: null,
      });
      const input = this.readString(payload.input);
      if (input) {
        this.appendPatchOutputDelta(sessionId, runtime, callId, input);
      }
      return;
    }

    if (itemType === "custom_tool_call_output") {
      this.ensureTurnStarted(sessionId, runtime);
      const callId = this.resolvePatchCallId(runtime, this.readString(payload.call_id));
      const output = this.readString(payload.output) || "";
      if (output) {
        this.appendPatchOutputDelta(sessionId, runtime, callId, output);
      }
      this.finishPatch(sessionId, runtime, callId, {
        status: "completed",
      });
    }
  }

  private applySemanticSignal(
    sessionId: string,
    runtime: RunnerState,
    signal: CodexSemanticSignal,
  ): void {
    switch (signal.kind) {
      case "thread_started":
        this.setCodexThreadId(sessionId, signal.threadId);
        return;
      case "approval_request":
        this.registerPendingApproval(sessionId, {
          requestId: String(signal.requestId),
          runnerRequestId: signal.requestId,
          sessionId,
          turnId: signal.turnId ?? runtime.turnId,
          callId: signal.callId,
          method: signal.method,
          params: signal.params,
          createdAt: nowIso(),
        });
        return;
      case "event":
        this.applySemanticEvent(sessionId, runtime, signal.event);
        return;
    }
  }

  private applySemanticEvent(
    sessionId: string,
    runtime: RunnerState,
    event: SemanticEventDraft,
  ): void {
    switch (event.type) {
      case "turn.started":
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId, event.payload);
        return;
      case "turn.completed":
        this.completeTurn(sessionId, runtime, "turn.completed", event.payload);
        return;
      case "turn.aborted":
        this.completeTurn(sessionId, runtime, "turn.aborted", event.payload);
        return;
      case "message.assistant.start": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const phase = event.phase || "final_answer";
        const messageId = this.resolveAssistantMessageId(runtime, phase, event.messageId);
        this.ensureAssistantMessageStart(sessionId, runtime, phase, messageId, this.readString(event.payload.text));
        return;
      }
      case "message.assistant.delta": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const phase = event.phase || "final_answer";
        const messageId = this.resolveAssistantMessageId(runtime, phase, event.messageId);
        this.appendAssistantDelta(
          sessionId,
          runtime,
          phase,
          messageId,
          this.readRawText(event.payload.textDelta) || "",
        );
        return;
      }
      case "message.assistant.end": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const phase = event.phase || "final_answer";
        this.finishAssistantMessage(
          sessionId,
          runtime,
          phase,
          event.messageId,
          this.readString(event.payload.text) || "",
        );
        return;
      }
      case "reasoning.start": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const messageId = this.resolveReasoningMessageId(runtime, event.messageId);
        this.ensureReasoningStart(
          sessionId,
          runtime,
          messageId,
          this.readString(event.payload.summary) || null,
        );
        return;
      }
      case "reasoning.delta": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const messageId = this.resolveReasoningMessageId(runtime, event.messageId);
        this.appendReasoningDelta(
          sessionId,
          runtime,
          messageId,
          this.readRawText(event.payload.textDelta) || "",
          this.readString(event.payload.summary) || null,
        );
        return;
      }
      case "reasoning.end": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const messageId = this.resolveReasoningMessageId(runtime, event.messageId);
        this.finishReasoning(
          sessionId,
          runtime,
          messageId,
          this.readString(event.payload.summary) || null,
        );
        return;
      }
      case "command.start": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const callId = this.resolveCommandCallId(runtime, event.callId);
        this.ensureCommandStart(sessionId, runtime, callId, event.payload as unknown as CommandStartPayload);
        return;
      }
      case "command.output.delta": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const callId = this.resolveCommandCallId(runtime, event.callId);
        this.appendCommandOutputDelta(
          sessionId,
          runtime,
          callId,
          event.stream || "stdout",
          this.readRawText(event.payload.textDelta) || "",
        );
        return;
      }
      case "command.end": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const callId = this.resolveCommandCallId(runtime, event.callId);
        this.finishCommand(sessionId, runtime, callId, event.payload as unknown as CommandEndPayload);
        return;
      }
      case "patch.start": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const callId = this.resolvePatchCallId(runtime, event.callId);
        this.ensurePatchStart(sessionId, runtime, callId, event.payload as unknown as PatchStartPayload);
        return;
      }
      case "patch.output.delta": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const callId = this.resolvePatchCallId(runtime, event.callId);
        this.appendPatchOutputDelta(
          sessionId,
          runtime,
          callId,
          this.readRawText(event.payload.textDelta) || "",
        );
        return;
      }
      case "patch.end": {
        this.ensureTurnStarted(sessionId, runtime, event.turnId || runtime.turnId);
        const callId = this.resolvePatchCallId(runtime, event.callId);
        this.finishPatch(sessionId, runtime, callId, event.payload as unknown as PatchEndPayload);
        return;
      }
      case "approval.requested":
      case "approval.resolved":
        this.appendEvent(sessionId, {
          type: event.type,
          turnId: event.turnId ?? runtime.turnId,
          messageId: null,
          callId: event.callId ?? null,
          requestId: event.requestId ?? null,
          phase: null,
          stream: null,
          payload: event.payload,
        });
        return;
      case "error":
        this.appendError(sessionId, event.turnId ?? runtime.turnId, this.readString(event.payload.message) || "Unknown error", event.payload);
        return;
      case "token_count": {
        const normalized = this.normalizeTokenCountPayload(event.payload);
        if (normalized) {
          this.appendTokenCount(sessionId, event.turnId ?? runtime.turnId, normalized);
        }
        return;
      }
    }
  }

  private handleRunnerExit(sessionId: string, runtime: RunnerState, exitCode: number | null): void {
    this.runners.delete(sessionId);
    this.clearPid(sessionId);

    if (!runtime.turnFinalized) {
      if (runtime.stopRequested) {
        this.completeTurn(sessionId, runtime, "turn.aborted", {
          abortedAt: nowIso(),
          reason: "stopped",
        });
      } else if (exitCode !== 0) {
        this.appendError(
          sessionId,
          runtime.turnId,
          `Process exited with code ${exitCode ?? -1}.`,
          {
            exitCode,
          },
        );
        this.completeTurn(sessionId, runtime, "turn.aborted", {
          abortedAt: nowIso(),
          reason: `exit:${exitCode ?? -1}`,
        });
      }
    }

    if (runtime.stopRequested) {
      this.advanceImportedRolloutCursorToCurrentEnd(sessionId, runtime.turnFinalized);
      this.setStatus(sessionId, "idle");
      return;
    }

    if (exitCode === 0) {
      this.advanceImportedRolloutCursorToCurrentEnd(sessionId, runtime.turnFinalized);
      if (this.getSession(sessionId)?.status !== "failed") {
        this.setStatus(sessionId, "waiting_input");
      }
      return;
    }

    this.advanceImportedRolloutCursorToCurrentEnd(sessionId, runtime.turnFinalized);
    this.setStatus(sessionId, "failed");
  }

  private advanceImportedRolloutCursorToCurrentEnd(
    sessionId: string,
    turnFinalized: boolean,
  ): void {
    const session = this.getSession(sessionId);
    if (!session || session.source_kind !== "imported_rollout" || !session.source_rollout_path) {
      return;
    }

    const rolloutPath = path.resolve(session.source_rollout_path);
    if (!existsSync(rolloutPath)) {
      return;
    }

    const cursor = readFileSync(rolloutPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean).length;
    const syncedAt = nowIso();

    this.options.db
      .prepare(
        `
          UPDATE sessions
          SET
            source_sync_cursor = ?,
            source_last_synced_at = ?,
            source_rollout_has_open_turn = CASE WHEN ? THEN 0 ELSE source_rollout_has_open_turn END,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(cursor, syncedAt, turnFinalized ? 1 : 0, syncedAt, sessionId);
  }

  private ensureTurnStarted(
    sessionId: string,
    runtime: RunnerState,
    turnId = runtime.turnId,
    payload: Record<string, unknown> = {},
  ): void {
    if (runtime.turnStarted) {
      if (turnId && turnId !== runtime.turnId) {
        runtime.appTurnId = turnId;
      }
      return;
    }

    runtime.turnStarted = true;
    if (turnId) {
      runtime.appTurnId = turnId;
    }
    this.appendEvent(sessionId, {
      type: "turn.started",
      turnId: runtime.turnId,
      messageId: null,
      callId: null,
      requestId: null,
      phase: null,
      stream: null,
      payload: {
        createdAt: nowIso(),
        ...payload,
      },
    });
    this.setStatus(sessionId, "running");
  }

  private completeTurn(
    sessionId: string,
    runtime: RunnerState,
    type: "turn.completed" | "turn.aborted",
    payload: Record<string, unknown>,
  ): void {
    if (runtime.turnFinalized) {
      return;
    }

    this.ensureTurnStarted(sessionId, runtime);
    runtime.turnFinalized = true;
    this.appendEvent(sessionId, {
      type,
      turnId: runtime.turnId,
      messageId: null,
      callId: null,
      requestId: null,
      phase: null,
      stream: null,
      payload,
    });

    if (type === "turn.completed") {
      this.setStatus(sessionId, "waiting_input");
      return;
    }

    if (runtime.stopRequested) {
      this.setStatus(sessionId, "idle");
      return;
    }

    this.setStatus(sessionId, "failed");
  }

  private ensureAssistantMessageStart(
    sessionId: string,
    runtime: RunnerState,
    phase: AssistantPhase,
    messageId: string,
    initialText?: string | null,
  ): void {
    const current = runtime.messagesById.get(messageId);
    if (current?.started) {
      return;
    }

    runtime.assistantByPhase.set(phase, messageId);
    runtime.messagesById.set(messageId, {
      messageId,
      phase,
      text: initialText || "",
      started: true,
      completed: false,
    });

    this.appendEvent(sessionId, {
      type: "message.assistant.start",
      turnId: runtime.turnId,
      messageId,
      callId: null,
      requestId: null,
      phase,
      stream: null,
      payload: initialText ? { text: initialText } : {},
    });
  }

  private appendAssistantDelta(
    sessionId: string,
    runtime: RunnerState,
    phase: AssistantPhase,
    messageId: string,
    textDelta: string,
  ): void {
    this.ensureAssistantMessageStart(sessionId, runtime, phase, messageId);
    const state = runtime.messagesById.get(messageId);
    if (!state || !textDelta) {
      return;
    }

    state.text += textDelta;
    this.appendEvent(sessionId, {
      type: "message.assistant.delta",
      turnId: runtime.turnId,
      messageId,
      callId: null,
      requestId: null,
      phase,
      stream: null,
      payload: {
        textDelta,
      },
    });
  }

  private finishAssistantMessage(
    sessionId: string,
    runtime: RunnerState,
    phase: AssistantPhase,
    providedMessageId: string | null | undefined,
    finalText: string,
  ): void {
    const messageId = this.resolveAssistantMessageId(runtime, phase, providedMessageId ?? null);
    this.ensureAssistantMessageStart(sessionId, runtime, phase, messageId);
    const state = runtime.messagesById.get(messageId);
    if (!state) {
      return;
    }

    if (finalText && !state.text) {
      this.appendAssistantDelta(sessionId, runtime, phase, messageId, finalText);
    } else if (finalText && finalText !== state.text && finalText.startsWith(state.text)) {
      this.appendAssistantDelta(
        sessionId,
        runtime,
        phase,
        messageId,
        finalText.slice(state.text.length),
      );
    }

    if (state.completed) {
      return;
    }

    state.completed = true;
    const settledText = finalText || state.text;
    state.text = settledText;

    this.appendEvent(sessionId, {
      type: "message.assistant.end",
      turnId: runtime.turnId,
      messageId,
      callId: null,
      requestId: null,
      phase,
      stream: null,
      payload: {
        text: settledText,
      },
    });

    if (runtime.assistantByPhase.get(phase) === messageId) {
      runtime.assistantByPhase.delete(phase);
    }
  }

  private ensureReasoningStart(
    sessionId: string,
    runtime: RunnerState,
    messageId: string,
    summary?: string | null,
  ): void {
    if (runtime.reasoning?.messageId === messageId && runtime.reasoning.started) {
      return;
    }

    runtime.reasoning = {
      messageId,
      text: summary || "",
      started: true,
      completed: false,
    };

    this.appendEvent(sessionId, {
      type: "reasoning.start",
      turnId: runtime.turnId,
      messageId,
      callId: null,
      requestId: null,
      phase: null,
      stream: null,
      payload: summary ? { summary } : {},
    });
  }

  private appendReasoningDelta(
    sessionId: string,
    runtime: RunnerState,
    messageId: string,
    textDelta: string,
    summary?: string | null,
  ): void {
    this.ensureReasoningStart(sessionId, runtime, messageId, summary);
    if (!runtime.reasoning || !textDelta) {
      return;
    }

    runtime.reasoning.text += textDelta;
    this.appendEvent(sessionId, {
      type: "reasoning.delta",
      turnId: runtime.turnId,
      messageId,
      callId: null,
      requestId: null,
      phase: null,
      stream: null,
      payload: {
        textDelta,
        ...(summary ? { summary } : {}),
      },
    });
  }

  private finishReasoning(
    sessionId: string,
    runtime: RunnerState,
    messageId: string,
    summary?: string | null,
  ): void {
    this.ensureReasoningStart(sessionId, runtime, messageId, summary);
    if (!runtime.reasoning || runtime.reasoning.completed) {
      return;
    }

    runtime.reasoning.completed = true;
    this.appendEvent(sessionId, {
      type: "reasoning.end",
      turnId: runtime.turnId,
      messageId,
      callId: null,
      requestId: null,
      phase: null,
      stream: null,
      payload: summary ? { summary } : {},
    });
  }

  private ensureCommandStart(
    sessionId: string,
    runtime: RunnerState,
    callId: string,
    payload: CommandStartPayload,
  ): void {
    const current = runtime.commandsByCallId.get(callId);
    if (current?.started) {
      current.command = current.command || payload.command || null;
      current.cwd = current.cwd || payload.cwd || null;
      return;
    }

    runtime.activeCommandCallId = callId;
    runtime.commandsByCallId.set(callId, {
      callId,
      command: payload.command || null,
      cwd: payload.cwd || null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      started: true,
      completed: false,
    });

    this.appendEvent(sessionId, {
      type: "command.start",
      turnId: runtime.turnId,
      messageId: null,
      callId,
      requestId: null,
      phase: null,
      stream: null,
      payload,
    });
  }

  private appendCommandOutputDelta(
    sessionId: string,
    runtime: RunnerState,
    callId: string,
    stream: "stdout" | "stderr",
    textDelta: string,
  ): void {
    this.ensureCommandStart(sessionId, runtime, callId, {
      command: runtime.commandsByCallId.get(callId)?.command || "",
      cwd: runtime.commandsByCallId.get(callId)?.cwd || null,
    });
    if (!textDelta) {
      return;
    }

    const current = runtime.commandsByCallId.get(callId);
    if (!current) {
      return;
    }

    const targetKey = stream === "stderr" ? "stderr" : "stdout";
    const truncatedKey = stream === "stderr" ? "stderrTruncated" : "stdoutTruncated";
    const capped = appendCappedText(current[targetKey], textDelta);
    current[targetKey] = capped.nextText;
    if (capped.truncated) {
      current[truncatedKey] = true;
    }
    runtime.activeCommandCallId = callId;

    this.publishTransientEvent(sessionId, runtime, {
      type: "command.output.delta",
      turnId: runtime.turnId,
      messageId: null,
      callId,
      requestId: null,
      phase: null,
      stream,
      payload: {
        stream,
        textDelta,
      },
    });
  }

  private finishCommand(
    sessionId: string,
    runtime: RunnerState,
    callId: string,
    payload: CommandEndPayload,
  ): void {
    this.ensureCommandStart(sessionId, runtime, callId, {
      command: payload.command || "",
      cwd: payload.cwd || null,
    });

    const current = runtime.commandsByCallId.get(callId);
    if (!current || current.completed) {
      return;
    }

    current.completed = true;
    this.appendEvent(sessionId, {
      type: "command.end",
      turnId: runtime.turnId,
      messageId: null,
      callId,
      requestId: null,
      phase: null,
      stream: null,
      payload: {
        command: payload.command || current.command,
        cwd: payload.cwd || current.cwd,
        stdout: current.stdout || null,
        stderr: current.stderr || null,
        aggregatedOutput: current.stdout || current.stderr || null,
        stdoutTruncated: current.stdoutTruncated || undefined,
        stderrTruncated: current.stderrTruncated || undefined,
        status: payload.status || (payload.exitCode === 0 ? "completed" : "failed"),
        exitCode: payload.exitCode ?? null,
        durationMs: payload.durationMs ?? null,
        rejected: payload.rejected ?? false,
      },
    });

    if (runtime.activeCommandCallId === callId) {
      runtime.activeCommandCallId = null;
    }
  }

  private ensurePatchStart(
    sessionId: string,
    runtime: RunnerState,
    callId: string,
    payload: PatchStartPayload,
  ): void {
    const current = runtime.patchesByCallId.get(callId);
    if (current?.started) {
      return;
    }

    runtime.activePatchCallId = callId;
    runtime.patchesByCallId.set(callId, {
      callId,
      text: "",
      started: true,
      completed: false,
    });

    this.appendEvent(sessionId, {
      type: "patch.start",
      turnId: runtime.turnId,
      messageId: null,
      callId,
      requestId: null,
      phase: null,
      stream: null,
      payload,
    });
  }

  private appendPatchOutputDelta(
    sessionId: string,
    runtime: RunnerState,
    callId: string,
    textDelta: string,
  ): void {
    this.ensurePatchStart(sessionId, runtime, callId, {});
    if (!textDelta) {
      return;
    }

    const current = runtime.patchesByCallId.get(callId);
    if (!current) {
      return;
    }

    current.text += textDelta;
    runtime.activePatchCallId = callId;
    this.appendEvent(sessionId, {
      type: "patch.output.delta",
      turnId: runtime.turnId,
      messageId: null,
      callId,
      requestId: null,
      phase: null,
      stream: null,
      payload: {
        textDelta,
      },
    });
  }

  private derivePatchChanges(
    patchText: string,
  ): Record<string, { added: number; removed: number }> | null {
    const source = String(patchText || "");
    if (!source.trim()) {
      return null;
    }

    const fileMap = new Map<string, { added: number; removed: number }>();
    let currentPath: string | null = null;

    const ensureFile = (path: string | null): { added: number; removed: number } | null => {
      const normalizedPath = String(path || "").trim();
      if (!normalizedPath || normalizedPath === "/dev/null") {
        return null;
      }
      const existing = fileMap.get(normalizedPath) || { added: 0, removed: 0 };
      fileMap.set(normalizedPath, existing);
      return existing;
    };

    source.split("\n").forEach((line) => {
      const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (diffMatch) {
        currentPath = diffMatch[2];
        ensureFile(currentPath);
        return;
      }

      const nextFileMatch = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (nextFileMatch && nextFileMatch[1] !== "/dev/null") {
        currentPath = nextFileMatch[1];
        ensureFile(currentPath);
        return;
      }

      if (line.startsWith("@@")) {
        ensureFile(currentPath);
        return;
      }

      if (line.startsWith("+") && !line.startsWith("+++")) {
        const current = ensureFile(currentPath);
        if (current) {
          current.added += 1;
        }
        return;
      }

      if (line.startsWith("-") && !line.startsWith("---")) {
        const current = ensureFile(currentPath);
        if (current) {
          current.removed += 1;
        }
      }
    });

    if (fileMap.size === 0) {
      currentPath = null;
      source.split("\n").forEach((line) => {
        const patchFileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
        if (patchFileMatch) {
          currentPath = patchFileMatch[1].trim();
          ensureFile(currentPath);
          return;
        }

        const outputFileMatch = line.match(/^[AMD]\s+(.+)$/);
        if (outputFileMatch) {
          currentPath = outputFileMatch[1].trim();
          ensureFile(currentPath);
          return;
        }

        if (!currentPath) {
          return;
        }

        if (line.startsWith("*** ")) {
          currentPath = null;
          return;
        }

        if (line.startsWith("+")) {
          const current = ensureFile(currentPath);
          if (current) {
            current.added += 1;
          }
          return;
        }

        if (line.startsWith("-")) {
          const current = ensureFile(currentPath);
          if (current) {
            current.removed += 1;
          }
        }
      });
    }

    if (fileMap.size === 0) {
      return null;
    }

    return Object.fromEntries(fileMap.entries());
  }

  private finishPatch(
    sessionId: string,
    runtime: RunnerState,
    callId: string,
    payload: PatchEndPayload,
  ): void {
    this.ensurePatchStart(sessionId, runtime, callId, {});
    const current = runtime.patchesByCallId.get(callId);
    if (!current || current.completed) {
      return;
    }

    current.completed = true;
    const patchText = current.text || payload.patchText || "";
    const changes = this.derivePatchChanges(patchText) || payload.changes || null;
    this.appendEvent(sessionId, {
      type: "patch.end",
      turnId: runtime.turnId,
      messageId: null,
      callId,
      requestId: null,
      phase: null,
      stream: null,
      payload: {
        status: payload.status || "completed",
        durationMs: payload.durationMs ?? null,
        success: payload.success ?? (payload.status === "failed" ? false : null),
        rejected: payload.rejected ?? false,
        patchText: patchText || null,
        changes,
      },
    });

    if (runtime.activePatchCallId === callId) {
      runtime.activePatchCallId = null;
    }
  }

  private appendTokenCount(
    sessionId: string,
    turnId: string,
    payload: CodexQuotaPayload,
  ): void {
    this.appendEvent(sessionId, {
      type: "token_count",
      turnId,
      messageId: null,
      callId: null,
      requestId: null,
      phase: null,
      stream: null,
      payload,
    });
  }

  private appendError(
    sessionId: string,
    turnId: string | null,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.appendEvent(sessionId, {
      type: "error",
      turnId: turnId || null,
      messageId: null,
      callId: null,
      requestId: null,
      phase: null,
      stream: null,
      payload: {
        message,
        details: details ?? null,
      },
    });
  }

  private appendEvent(sessionId: string, input: EventInsertInput) {
    const event = this.options.eventStore.append(sessionId, input);
    const runtime = this.runners.get(sessionId);
    if (runtime) {
      runtime.transientSeqCursor = Math.max(runtime.transientSeqCursor, Number(event.seq || 0));
    }
    this.touchSession(sessionId);
    return event;
  }

  private publishTransientEvent(
    sessionId: string,
    runtime: RunnerState,
    input: EventInsertInput,
  ) {
    runtime.transientSeqCursor =
      Math.round((runtime.transientSeqCursor + TRANSIENT_SEQ_STEP) * 100000) / 100000;
    return this.options.eventStore.publishTransient(
      sessionId,
      input,
      runtime.transientSeqCursor,
    );
  }

  private touchSession(sessionId: string): void {
    this.options.db
      .prepare(
        `
          UPDATE sessions
          SET updated_at = ?
          WHERE id = ?
        `,
      )
      .run(nowIso(), sessionId);
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const session = this.getSessionOrThrow(sessionId);
    if (session.status === status) {
      return;
    }

    this.options.db
      .prepare(
        `
          UPDATE sessions
          SET status = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(status, nowIso(), sessionId);
  }

  private setPid(sessionId: string, pid: number): void {
    this.options.db
      .prepare(
        `
          UPDATE sessions
          SET pid = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(pid, nowIso(), sessionId);
  }

  private setCodexThreadId(sessionId: string, threadId: string): void {
    this.options.db
      .prepare(
        `
          UPDATE sessions
          SET codex_thread_id = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(threadId, nowIso(), sessionId);
  }

  private clearPid(sessionId: string): void {
    this.options.db
      .prepare(
        `
          UPDATE sessions
          SET pid = NULL, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(nowIso(), sessionId);
  }

  private getSessionOrThrow(sessionId: string): SessionRecord {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new AppError(404, "Session not found.");
    }
    return session;
  }

  private messageOf(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return "Unknown error";
  }

  private registerPendingApproval(sessionId: string, approval: PendingApproval): void {
    let sessionApprovals = this.pendingApprovals.get(sessionId);
    if (!sessionApprovals) {
      sessionApprovals = new Map();
      this.pendingApprovals.set(sessionId, sessionApprovals);
    }

    sessionApprovals.set(approval.requestId, approval);
    this.appendEvent(sessionId, {
      type: "approval.requested",
      turnId: approval.turnId,
      messageId: null,
      callId: approval.callId,
      requestId: String(approval.requestId),
      phase: null,
      stream: null,
      payload: this.serializePendingApproval(approval),
    });
  }

  private restorePendingApprovalFromEvents(
    sessionId: string,
    requestId: string,
  ): PendingApproval | null {
    const payload = this.options.eventStore.latestPendingApproval(sessionId);
    if (!payload || String(payload.requestId) !== String(requestId)) {
      return null;
    }

    const restored: PendingApproval = {
      requestId,
      runnerRequestId: Number.parseInt(String(requestId), 10),
      sessionId,
      turnId: null,
      callId: payload.callId || null,
      method: payload.method,
      params:
        payload.rawParams && typeof payload.rawParams === "object"
          ? payload.rawParams
          : {
              reason: payload.reason,
              command: payload.command,
              cwd: payload.cwd,
              grantRoot: payload.grantRoot,
            },
      createdAt: payload.createdAt,
    };

    let sessionApprovals = this.pendingApprovals.get(sessionId);
    if (!sessionApprovals) {
      sessionApprovals = new Map();
      this.pendingApprovals.set(sessionId, sessionApprovals);
    }
    sessionApprovals.set(requestId, restored);
    return restored;
  }

  private consumePendingApproval(
    sessionId: string,
    requestId: string,
    decision: "accept" | "acceptForSession" | "decline",
  ): void {
    const sessionApprovals = this.pendingApprovals.get(sessionId);
    const current = sessionApprovals?.get(requestId) ?? null;
    if (decision === "acceptForSession" && current) {
      this.promoteApprovalWritableRoot(sessionId, current);
    }
    if (sessionApprovals) {
      sessionApprovals.delete(requestId);
      if (sessionApprovals.size === 0) {
        this.pendingApprovals.delete(sessionId);
      }
    }

    const resolvedPayload: SessionApprovalResolvedPayload = {
      requestId,
      callId: current?.callId || null,
      decision,
      resolvedAt: nowIso(),
    };

    this.appendEvent(sessionId, {
      type: "approval.resolved",
      turnId: current?.turnId || null,
      messageId: null,
      callId: current?.callId || null,
      requestId,
      phase: null,
      stream: null,
      payload: resolvedPayload,
    });
  }

  private serializePendingApproval(approval: PendingApproval): SessionApprovalPayload {
    const params = approval.params;
    const commandText = this.extractApprovalCommand(approval.method, params);
    return {
      requestId: approval.requestId,
      callId: approval.callId,
      method: approval.method,
      title: this.describeApprovalTitle(approval.method),
      reason:
        typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : null,
      command: commandText,
      cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : null,
      grantRoot:
        typeof params.grantRoot === "string" && params.grantRoot.trim()
          ? params.grantRoot.trim()
          : null,
      createdAt: approval.createdAt,
      rawParams: params,
      resumable: true,
      source: "live",
    };
  }

  private extractApprovalCommand(
    method: string,
    params: Record<string, unknown>,
  ): string | null {
    if (typeof params.command === "string" && params.command.trim()) {
      return params.command.trim();
    }

    if (method === "execCommandApproval" && Array.isArray(params.command)) {
      const command = params.command
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .join(" ");
      return command || null;
    }

    return null;
  }

  private buildApprovalRetryRuntimePrompt(approval: PendingApproval): string {
    const commandText = this.extractApprovalCommand(approval.method, approval.params);
    const reason =
      typeof approval.params.reason === "string" && approval.params.reason.trim()
        ? approval.params.reason.trim()
        : "";

    if (commandText) {
      return [
        "Re-run the exact operation that previously requested approval.",
        "Do not do extra exploration.",
        "As soon as the approval prompt appears again, stop and wait for the user decision.",
        "",
        commandText,
      ].join("\n");
    }

    if (reason) {
      return [
        "Re-run the exact step that previously requested approval.",
        "Do not do extra exploration.",
        "As soon as the approval prompt appears again, stop and wait for the user decision.",
        "",
        `Original approval reason: ${reason}`,
      ].join("\n");
    }

    return [
      "Re-run the exact step that previously requested approval.",
      "Do not do extra exploration.",
      "As soon as the approval prompt appears again, stop and wait for the user decision.",
    ].join("\n");
  }

  private describeApprovalTitle(method: string): string {
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      return "Command execution requires approval";
    }

    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      return "File changes require approval";
    }

    if (method === "item/permissions/requestApproval") {
      return "Extra permissions require approval";
    }

    return "Approval required";
  }

  private withSessionWritableRoots(
    sessionId: string,
    launch: CodexExecLaunchInput | undefined,
  ): CodexExecLaunchInput | undefined {
    const roots = this.sessionWritableRoots.get(sessionId);
    if (!roots || roots.size === 0) {
      return launch;
    }

    const merged = new Set<string>(launch?.additionalWritableRoots ?? []);
    for (const root of roots) {
      merged.add(root);
    }

    return {
      ...(launch ?? {}),
      additionalWritableRoots: [...merged],
    };
  }

  private promoteApprovalWritableRoot(sessionId: string, approval: PendingApproval): void {
    const root = this.extractApprovalWritableRoot(approval);
    if (!root) {
      return;
    }

    let roots = this.sessionWritableRoots.get(sessionId);
    if (!roots) {
      roots = new Set();
      this.sessionWritableRoots.set(sessionId, roots);
    }
    roots.add(root);
  }

  private extractApprovalWritableRoot(approval: PendingApproval): string | null {
    const params = approval.params;

    if (typeof params.grantRoot === "string" && params.grantRoot.trim()) {
      return params.grantRoot.trim();
    }

    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    const reasonMatch = reason.match(/\sin\s(\/[^\s?]+)/);
    if (reasonMatch?.[1]) {
      return reasonMatch[1];
    }

    const command = this.extractApprovalCommand(approval.method, params);
    const commandMatch = command?.match(/\/Users\/[^\s'"]+/);
    if (commandMatch?.[0]) {
      const matchedPath = commandMatch[0];
      const slashIndex = matchedPath.lastIndexOf("/");
      return slashIndex > 0 ? matchedPath.slice(0, slashIndex) : matchedPath;
    }

    return null;
  }

  private buildApprovalResponsePayload(
    approval: PendingApproval,
    decision: "accept" | "acceptForSession" | "decline",
  ): unknown {
    switch (approval.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return {
          decision:
            decision === "decline"
              ? "decline"
              : decision === "acceptForSession"
                ? "acceptForSession"
                : "accept",
        };
      case "item/permissions/requestApproval": {
        const permissions =
          approval.params.permissions && typeof approval.params.permissions === "object"
            ? approval.params.permissions
            : {};
        return {
          permissions: decision === "decline" ? {} : permissions,
          scope: decision === "acceptForSession" ? "session" : "turn",
        };
      }
      case "execCommandApproval":
      case "applyPatchApproval":
        return {
          decision:
            decision === "decline"
              ? "denied"
              : decision === "acceptForSession"
                ? "approved_for_session"
                : "approved",
        };
      default:
        return {
          decision: "decline",
        };
    }
  }

  private resolveAssistantMessageId(
    runtime: RunnerState,
    phase: AssistantPhase,
    providedMessageId: string | null | undefined,
  ): string {
    if (providedMessageId) {
      runtime.assistantByPhase.set(phase, providedMessageId);
      return providedMessageId;
    }

    const current = runtime.assistantByPhase.get(phase);
    if (current) {
      const item = runtime.messagesById.get(current);
      if (item && !item.completed) {
        return current;
      }
    }

    const next = createId("msg");
    runtime.assistantByPhase.set(phase, next);
    return next;
  }

  private resolveReasoningMessageId(
    runtime: RunnerState,
    providedMessageId: string | null | undefined,
  ): string {
    if (providedMessageId) {
      return providedMessageId;
    }

    if (runtime.reasoning && !runtime.reasoning.completed) {
      return runtime.reasoning.messageId;
    }

    return createId("msg");
  }

  private resolveCommandCallId(
    runtime: RunnerState,
    providedCallId: string | null | undefined,
  ): string {
    if (providedCallId) {
      runtime.activeCommandCallId = providedCallId;
      return providedCallId;
    }

    if (runtime.activeCommandCallId) {
      const current = runtime.commandsByCallId.get(runtime.activeCommandCallId);
      if (current && !current.completed) {
        return runtime.activeCommandCallId;
      }
    }

    const next = createId("call");
    runtime.activeCommandCallId = next;
    return next;
  }

  private resolvePatchCallId(
    runtime: RunnerState,
    providedCallId: string | null | undefined,
  ): string {
    if (providedCallId) {
      runtime.activePatchCallId = providedCallId;
      return providedCallId;
    }

    if (runtime.activePatchCallId) {
      const current = runtime.patchesByCallId.get(runtime.activePatchCallId);
      if (current && !current.completed) {
        return runtime.activePatchCallId;
      }
    }

    const next = createId("call");
    runtime.activePatchCallId = next;
    return next;
  }

  private normalizeAssistantPhase(value: unknown): AssistantPhase {
    return value === "commentary" ? "commentary" : "final_answer";
  }

  private extractResponseItemMessageText(payload: Record<string, unknown>): string {
    const content = Array.isArray(payload.content) ? payload.content : [];
    return content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private parseJsonObject(raw: string | null): Record<string, unknown> {
    if (!raw) {
      return {};
    }

    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private normalizeTokenCountPayload(
    payload: Record<string, unknown>,
  ): CodexQuotaPayload | null {
    const rateLimits =
      payload.rate_limits && typeof payload.rate_limits === "object"
        ? (payload.rate_limits as Record<string, unknown>)
        : payload.rateLimits && typeof payload.rateLimits === "object"
          ? (payload.rateLimits as Record<string, unknown>)
          : null;

    if (!rateLimits) {
      return null;
    }

    const info = payload.info && typeof payload.info === "object"
      ? (payload.info as Record<string, unknown>)
      : undefined;
    const totalTokenUsage =
      info?.total_token_usage && typeof info.total_token_usage === "object"
        ? (info.total_token_usage as Record<string, unknown>)
        : undefined;
    const lastTokenUsage =
      info?.last_token_usage && typeof info.last_token_usage === "object"
        ? (info.last_token_usage as Record<string, unknown>)
        : undefined;
    const modelContextWindow =
      typeof info?.model_context_window === "number"
        ? info.model_context_window
        : typeof info?.model_context_window === "string"
          ? Number.parseInt(info.model_context_window, 10)
          : undefined;

    return {
      rateLimits,
      totalTokenUsage,
      lastTokenUsage,
      modelContextWindow: Number.isFinite(modelContextWindow) ? modelContextWindow : undefined,
      receivedAt: nowIso(),
      rawPayload: payload,
      source: "live",
    };
  }

  private readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private readRawText(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }
}
