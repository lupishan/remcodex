import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DatabaseClient } from "../db/client";
import type {
  EventInsertInput,
  ImportableCodexSessionRecord,
  SessionRecord,
  SessionStatus,
} from "../types/models";
import { AppError } from "../utils/errors";
import { createId } from "../utils/ids";
import { capTextValue } from "../utils/output-limits";

interface RolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface SemanticEventDraft {
  type: EventInsertInput["type"];
  turnId: string | null;
  messageId: string | null;
  callId: string | null;
  requestId: string | null;
  phase: EventInsertInput["phase"];
  stream: EventInsertInput["stream"];
  payload: EventInsertInput["payload"];
  timestamp: string;
}

interface CommandStartSnapshot {
  commandPayload: {
    command: string;
    cwd: string | null;
  };
}

interface TranslateRolloutResult {
  codexSessionId: string;
  workspacePath: string;
  sessionTitle: string;
  /** App session status for imported snapshots: always waiting_input (no local runner). */
  sessionStatus: SessionStatus;
  /** External rollout has at least one unclosed turn (separate from local runner). */
  sourceRolloutHasOpenTurn: boolean;
  firstTimestamp: string;
  lastTimestamp: string;
  events: SemanticEventDraft[];
  rawCursor: number;
}

function computeSourceRolloutHasOpenTurnFromRecords(records: RolloutRecord[]): boolean {
  const openTurnIds = new Set<string>();
  for (const record of records) {
    const payload =
      record.payload && typeof record.payload === "object"
        ? (record.payload as Record<string, unknown>)
        : {};
    if (record.type === "event_msg" && payload.type === "task_started") {
      const turnId =
        typeof payload.turn_id === "string" && payload.turn_id.trim() ? payload.turn_id.trim() : "";
      if (turnId) {
        openTurnIds.add(turnId);
      }
    }
    if (record.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      const turnId =
        typeof payload.turn_id === "string" && payload.turn_id.trim() ? payload.turn_id.trim() : "";
      if (turnId) {
        openTurnIds.delete(turnId);
      }
    }
  }
  return openTurnIds.size > 0;
}

interface ImportResult {
  sessionId: string;
  imported: boolean;
  syncedEvents: number;
}

interface SyncResult {
  sessionId: string;
  synced: boolean;
  appendedEvents: number;
  reason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveCodexHomeDir(): string {
  const override = process.env.CODEX_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.join(os.homedir(), ".codex");
}

function readJsonlLines(filePath: string): string[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function parseJsonlRecords(filePath: string): RolloutRecord[] {
  return readJsonlLines(filePath).map((line) => JSON.parse(line) as RolloutRecord);
}

function safeJsonParse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function shorten(text: string, max = 72): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      return typeof (part as { text?: unknown }).text === "string"
        ? String((part as { text: string }).text)
        : "";
    })
    .join("")
    .trim();
}

function extractReasoningSummary(summary: unknown): string {
  if (!Array.isArray(summary)) {
    return "";
  }

  return summary
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      return typeof (part as { text?: unknown }).text === "string"
        ? String((part as { text: string }).text)
        : "";
    })
    .join("")
    .trim();
}

function parseExecOutput(output: unknown): {
  commandLine: string | null;
  exitCode: number | null;
  durationMs: number | null;
  outputText: string;
} {
  const text = String(output || "");
  const exitMatch = text.match(/Process exited with code (-?\d+)/);
  const durationMatch = text.match(/Wall time: ([0-9.]+) seconds/);
  const commandMatch = text.match(/^Command:\s+(.+)$/m);
  const splitMarker = "\nOutput:\n";
  const splitIndex = text.indexOf(splitMarker);
  const outputText = splitIndex >= 0 ? text.slice(splitIndex + splitMarker.length) : text;

  return {
    commandLine: commandMatch?.[1] ?? null,
    exitCode: exitMatch ? Number.parseInt(exitMatch[1], 10) : null,
    durationMs: durationMatch
      ? Math.round(Number.parseFloat(durationMatch[1]) * 1000)
      : null,
    outputText,
  };
}

function buildCommandPayload(toolName: string, args: Record<string, unknown>) {
  if (toolName === "exec_command") {
    return {
      command: typeof args.cmd === "string" ? args.cmd : "exec_command",
      cwd: typeof args.workdir === "string" ? args.workdir : null,
      justification: typeof args.justification === "string" ? args.justification : null,
      sandboxMode:
        typeof args.sandbox_permissions === "string" ? args.sandbox_permissions : null,
      approvalRequired: args.sandbox_permissions === "require_escalated",
      grantRoot: null,
    };
  }

  return {
    command: `${toolName} ${shorten(JSON.stringify(args || {}), 160)}`.trim(),
    cwd: typeof args.workdir === "string" ? args.workdir : null,
    justification: null,
    sandboxMode: null,
    approvalRequired: false,
    grantRoot: null,
  };
}

function buildPatchStartPayload(toolName: string, input: unknown) {
  return {
    summary: `${toolName} ${shorten(String(input || ""), 160)}`.trim(),
    target: null,
  };
}

function buildTokenPayload(payload: Record<string, unknown>, timestamp: string) {
  const info =
    payload.info && typeof payload.info === "object"
      ? (payload.info as Record<string, unknown>)
      : {};

  return {
    rateLimits:
      payload.rate_limits && typeof payload.rate_limits === "object"
        ? (payload.rate_limits as Record<string, unknown>)
        : payload.rateLimits && typeof payload.rateLimits === "object"
          ? (payload.rateLimits as Record<string, unknown>)
          : {},
    totalTokenUsage:
      info.total_token_usage && typeof info.total_token_usage === "object"
        ? (info.total_token_usage as Record<string, unknown>)
        : {},
    lastTokenUsage:
      info.last_token_usage && typeof info.last_token_usage === "object"
        ? (info.last_token_usage as Record<string, unknown>)
        : {},
    modelContextWindow:
      typeof info.model_context_window === "number" ? info.model_context_window : undefined,
    receivedAt: timestamp,
    rawPayload: payload,
    source: "rollout" as const,
  };
}

function runInTransaction(db: DatabaseClient, callback: () => void): void {
  db.exec("BEGIN");
  try {
    callback();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function scanRolloutPaths(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const results: string[] = [];
  const visit = (currentPath: string) => {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        results.push(entryPath);
      }
    }
  };

  visit(root);
  return results.sort((left, right) => {
    const leftMtime = statSync(left).mtimeMs;
    const rightMtime = statSync(right).mtimeMs;
    return rightMtime - leftMtime;
  });
}

function translateRolloutRecords(
  records: RolloutRecord[],
  emitFromRecordIndex = 0,
): TranslateRolloutResult {
  const sessionMeta = records.find((record) => record.type === "session_meta")?.payload as
    | Record<string, unknown>
    | undefined;
  const codexSessionId = String(sessionMeta?.id || "").trim();
  if (!codexSessionId) {
    throw new AppError(400, "Unable to find session_meta.id in rollout.");
  }

  const workspacePath = String(sessionMeta?.cwd || process.cwd()).trim() || process.cwd();
  const semanticEvents: SemanticEventDraft[] = [];
  let currentTurnId: string | null = null;
  let activeTurnId: string | null = null;
  let assistantCounter = 0;
  let reasoningCounter = 0;
  const commandStarts = new Map<string, CommandStartSnapshot>();
  const lastFinalAssistantMessageIdByTurn = new Map<string, string>();
  let firstUserMessage = "";

  function appendSemantic(recordIndex: number, event: SemanticEventDraft) {
    if (recordIndex < emitFromRecordIndex) {
      return;
    }
    semanticEvents.push(event);
  }

  function downgradePreviousFinalAssistant(turnId: string | null) {
    if (!turnId) {
      return;
    }

    const previousMessageId = lastFinalAssistantMessageIdByTurn.get(turnId);
    if (!previousMessageId) {
      return;
    }

    for (const event of semanticEvents) {
      if (
        event.turnId === turnId &&
        event.messageId === previousMessageId &&
        (event.type === "message.assistant.start" ||
          event.type === "message.assistant.delta" ||
          event.type === "message.assistant.end")
      ) {
        event.phase = "commentary";
      }
    }
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const timestamp =
      typeof record.timestamp === "string" && record.timestamp.trim()
        ? record.timestamp.trim()
        : nowIso();

    if (record.type === "turn_context") {
      const payload =
        record.payload && typeof record.payload === "object"
          ? (record.payload as Record<string, unknown>)
          : {};
      currentTurnId =
        typeof payload.turn_id === "string" && payload.turn_id.trim()
          ? payload.turn_id.trim()
          : currentTurnId;
      continue;
    }

    if (record.type === "event_msg") {
      const payload =
        record.payload && typeof record.payload === "object"
          ? (record.payload as Record<string, unknown>)
          : {};
      switch (payload.type) {
        case "task_started": {
          const nextTurnId: string | null =
            typeof payload.turn_id === "string" && payload.turn_id.trim()
              ? payload.turn_id.trim()
              : currentTurnId;
          if (activeTurnId && nextTurnId && activeTurnId !== nextTurnId) {
            appendSemantic(index, {
              type: "turn.completed",
              turnId: activeTurnId,
              messageId: null,
              callId: null,
              requestId: null,
              phase: null,
              stream: null,
              payload: {
                completedAt: timestamp,
                reason: "implicit_rollover",
              },
              timestamp,
            });
          }

          currentTurnId = nextTurnId;
          activeTurnId = nextTurnId;
          appendSemantic(index, {
            type: "turn.started",
            turnId: currentTurnId,
            messageId: null,
            callId: null,
            requestId: null,
            phase: null,
            stream: null,
            payload: {
              createdAt: timestamp,
            },
            timestamp,
          });
          break;
        }
        case "user_message": {
          const text = typeof payload.message === "string" ? payload.message.trim() : "";
          if (!text) {
            break;
          }
          if (!firstUserMessage) {
            firstUserMessage = text;
          }
          appendSemantic(index, {
            type: "message.user",
            turnId: currentTurnId,
            messageId: null,
            callId: null,
            requestId: null,
            phase: null,
            stream: null,
            payload: { text },
            timestamp,
          });
          break;
        }
        case "token_count": {
          appendSemantic(index, {
            type: "token_count",
            turnId: currentTurnId,
            messageId: null,
            callId: null,
            requestId: null,
            phase: null,
            stream: null,
            payload: buildTokenPayload(payload, timestamp),
            timestamp,
          });
          break;
        }
        case "task_complete": {
          const turnId: string | null =
            typeof payload.turn_id === "string" && payload.turn_id.trim()
              ? payload.turn_id.trim()
              : currentTurnId;
          if (turnId && activeTurnId === turnId) {
            activeTurnId = null;
          }
          appendSemantic(index, {
            type: "turn.completed",
            turnId,
            messageId: null,
            callId: null,
            requestId: null,
            phase: null,
            stream: null,
            payload: {
              completedAt: timestamp,
              reason: null,
            },
            timestamp,
          });
          break;
        }
        case "turn_aborted": {
          const turnId: string | null =
            typeof payload.turn_id === "string" && payload.turn_id.trim()
              ? payload.turn_id.trim()
              : currentTurnId;
          if (turnId && activeTurnId === turnId) {
            activeTurnId = null;
          }
          appendSemantic(index, {
            type: "turn.aborted",
            turnId,
            messageId: null,
            callId: null,
            requestId: null,
            phase: null,
            stream: null,
            payload: {
              abortedAt: timestamp,
              reason: typeof payload.reason === "string" ? payload.reason : null,
            },
            timestamp,
          });
          break;
        }
        case "agent_reasoning": {
          const text = typeof payload.text === "string" ? payload.text.trim() : "";
          if (!text) {
            break;
          }
          const messageId = `msg_reasoning_${String((reasoningCounter += 1)).padStart(4, "0")}`;
          appendSemantic(index, {
            type: "reasoning.start",
            turnId: currentTurnId,
            messageId,
            callId: null,
            requestId: null,
            phase: null,
            stream: null,
            payload: {
              summary: "",
            },
            timestamp,
          });
          appendSemantic(index, {
            type: "reasoning.delta",
            turnId: currentTurnId,
            messageId,
            callId: null,
            requestId: null,
            phase: null,
            stream: null,
            payload: {
              textDelta: text,
              summary: text,
            },
            timestamp,
          });
          appendSemantic(index, {
            type: "reasoning.end",
            turnId: currentTurnId,
            messageId,
            callId: null,
            requestId: null,
            phase: null,
            stream: null,
            payload: {
              summary: text,
            },
            timestamp,
          });
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (record.type !== "response_item") {
      continue;
    }

    const payload =
      record.payload && typeof record.payload === "object"
        ? (record.payload as Record<string, unknown>)
        : {};

    switch (payload.type) {
      case "message": {
        if (payload.role !== "assistant") {
          break;
        }

        const text = extractMessageText(payload.content);
        if (!text) {
          break;
        }

        const phase = payload.phase === "commentary" ? "commentary" : "final_answer";
        const messageId = `msg_assistant_${String((assistantCounter += 1)).padStart(4, "0")}`;
        if (phase === "final_answer") {
          downgradePreviousFinalAssistant(currentTurnId);
          if (currentTurnId) {
            lastFinalAssistantMessageIdByTurn.set(currentTurnId, messageId);
          }
        }
        appendSemantic(index, {
          type: "message.assistant.start",
          turnId: currentTurnId,
          messageId,
          callId: null,
          requestId: null,
          phase,
          stream: null,
          payload: { text: "" },
          timestamp,
        });
        appendSemantic(index, {
          type: "message.assistant.delta",
          turnId: currentTurnId,
          messageId,
          callId: null,
          requestId: null,
          phase,
          stream: null,
          payload: { textDelta: text },
          timestamp,
        });
        appendSemantic(index, {
          type: "message.assistant.end",
          turnId: currentTurnId,
          messageId,
          callId: null,
          requestId: null,
          phase,
          stream: null,
          payload: {
            text,
            finishReason: null,
          },
          timestamp,
        });
        break;
      }
      case "reasoning": {
        const summary = extractReasoningSummary(payload.summary);
        if (!summary) {
          break;
        }

        const messageId = `msg_reasoning_${String((reasoningCounter += 1)).padStart(4, "0")}`;
        appendSemantic(index, {
          type: "reasoning.start",
          turnId: currentTurnId,
          messageId,
          callId: null,
          requestId: null,
          phase: null,
          stream: null,
          payload: {
            summary: "",
          },
          timestamp,
        });
        appendSemantic(index, {
          type: "reasoning.delta",
          turnId: currentTurnId,
          messageId,
          callId: null,
          requestId: null,
          phase: null,
          stream: null,
          payload: {
            textDelta: summary,
            summary,
          },
          timestamp,
        });
        appendSemantic(index, {
          type: "reasoning.end",
          turnId: currentTurnId,
          messageId,
          callId: null,
          requestId: null,
          phase: null,
          stream: null,
          payload: {
            summary,
          },
          timestamp,
        });
        break;
      }
      case "function_call": {
        const callId =
          typeof payload.call_id === "string" && payload.call_id.trim()
            ? payload.call_id.trim()
            : `call_${index}`;
        const args = safeJsonParse(payload.arguments) || {};
        const commandPayload = buildCommandPayload(
          typeof payload.name === "string" ? payload.name : "tool_call",
          args,
        );
        commandStarts.set(callId, {
          commandPayload: {
            command: commandPayload.command,
            cwd: commandPayload.cwd,
          },
        });
        appendSemantic(index, {
          type: "command.start",
          turnId: currentTurnId,
          messageId: null,
          callId,
          requestId: null,
          phase: null,
          stream: null,
          payload: commandPayload,
          timestamp,
        });
        break;
      }
      case "function_call_output": {
        const callId =
          typeof payload.call_id === "string" && payload.call_id.trim()
            ? payload.call_id.trim()
            : `call_${index}`;
        const started = commandStarts.get(callId) || null;
        const parsed = parseExecOutput(payload.output);
        const cappedOutput = parsed.outputText ? capTextValue(parsed.outputText) : null;
        appendSemantic(index, {
          type: "command.end",
          turnId: currentTurnId,
          messageId: null,
          callId,
          requestId: null,
          phase: null,
          stream: null,
          payload: {
            command: parsed.commandLine || started?.commandPayload.command || null,
            cwd: started?.commandPayload.cwd || null,
            stdout: cappedOutput?.text || null,
            aggregatedOutput: cappedOutput?.text || null,
            stdoutTruncated: cappedOutput?.truncated || undefined,
            status:
              parsed.exitCode == null
                ? "completed"
                : parsed.exitCode === 0
                  ? "completed"
                  : "failed",
            exitCode: parsed.exitCode,
            durationMs: parsed.durationMs,
            rejected: false,
          },
          timestamp,
        });
        break;
      }
      case "custom_tool_call": {
        const callId =
          typeof payload.call_id === "string" && payload.call_id.trim()
            ? payload.call_id.trim()
            : `patch_${index}`;
        appendSemantic(index, {
          type: "patch.start",
          turnId: currentTurnId,
          messageId: null,
          callId,
          requestId: null,
          phase: null,
          stream: null,
          payload: buildPatchStartPayload(
            typeof payload.name === "string" ? payload.name : "custom_tool",
            payload.input,
          ),
          timestamp,
        });
        break;
      }
      case "custom_tool_call_output": {
        const callId =
          typeof payload.call_id === "string" && payload.call_id.trim()
            ? payload.call_id.trim()
            : `patch_${index}`;
        const outputPayload = safeJsonParse(payload.output) || {};
        const text =
          typeof outputPayload.output === "string"
            ? outputPayload.output
            : typeof payload.output === "string"
              ? payload.output
              : "";
        const metadata =
          outputPayload.metadata && typeof outputPayload.metadata === "object"
            ? (outputPayload.metadata as Record<string, unknown>)
            : {};
        const durationSeconds =
          typeof metadata.duration_seconds === "number"
            ? metadata.duration_seconds
            : Number(metadata.duration_seconds);
        const exitCode =
          typeof metadata.exit_code === "number"
            ? metadata.exit_code
            : Number.isFinite(Number(metadata.exit_code))
              ? Number(metadata.exit_code)
              : null;

        if (text) {
          appendSemantic(index, {
            type: "patch.output.delta",
            turnId: currentTurnId,
            messageId: null,
            callId,
            requestId: null,
            phase: null,
            stream: null,
            payload: { textDelta: text },
            timestamp,
          });
        }

        appendSemantic(index, {
          type: "patch.end",
          turnId: currentTurnId,
          messageId: null,
          callId,
          requestId: null,
          phase: null,
          stream: null,
          payload: {
            status:
              typeof exitCode === "number"
                ? exitCode === 0
                  ? "completed"
                  : "failed"
                : "completed",
            durationMs:
              Number.isFinite(durationSeconds) && durationSeconds >= 0
                ? Math.round(durationSeconds * 1000)
                : null,
            success: typeof exitCode === "number" ? exitCode === 0 : true,
          },
          timestamp,
        });
        break;
      }
      default:
        break;
    }
  }

  const firstTimestamp = semanticEvents[0]?.timestamp || nowIso();
  const lastTimestamp =
    semanticEvents[semanticEvents.length - 1]?.timestamp || firstTimestamp || nowIso();
  const sourceRolloutHasOpenTurn = computeSourceRolloutHasOpenTurnFromRecords(records);

  return {
    codexSessionId,
    workspacePath,
    sessionTitle: firstUserMessage
      ? `Imported Codex: ${shorten(firstUserMessage, 60)}`
      : `Imported Codex Session ${codexSessionId.slice(0, 8)}`,
    sessionStatus: "waiting_input",
    sourceRolloutHasOpenTurn,
    firstTimestamp,
    lastTimestamp,
    events: semanticEvents,
    rawCursor: records.length,
  };
}

export class CodexRolloutSyncService {
  constructor(private readonly db: DatabaseClient) {}

  listImportableSessions(limit = 20): ImportableCodexSessionRecord[] {
    const rolloutRoot = path.join(resolveCodexHomeDir(), "sessions");
    const rolloutPaths = scanRolloutPaths(rolloutRoot).slice(0, Math.max(1, limit));
    const importedByPath = new Map<
      string,
      { session_id: string; imported_at: string | null }
    >(
      (
        this.db
          .prepare(
            `
              SELECT id AS session_id, source_rollout_path, source_last_synced_at AS imported_at
              FROM sessions
              WHERE source_kind = 'imported_rollout'
                AND source_rollout_path IS NOT NULL
            `,
          )
          .all() as Array<{
          session_id: string;
          source_rollout_path: string | null;
          imported_at: string | null;
        }>
      )
        .filter((row) => typeof row.source_rollout_path === "string" && row.source_rollout_path)
        .map((row) => [
          path.resolve(String(row.source_rollout_path)),
          { session_id: row.session_id, imported_at: row.imported_at },
        ]),
    );
    const nativeThreadIds = new Set(
      (
        this.db
          .prepare(
            `
              SELECT codex_thread_id
              FROM sessions
              WHERE source_kind = 'native'
                AND codex_thread_id IS NOT NULL
                AND codex_thread_id != ''
            `,
          )
          .all() as Array<{ codex_thread_id: string | null }>
      )
        .map((row) => String(row.codex_thread_id || "").trim())
        .filter(Boolean),
    );

    return rolloutPaths
      .map((rolloutPath) => {
        const records = parseJsonlRecords(rolloutPath);
        const sessionMeta = records.find((record) => record.type === "session_meta")?.payload as
          | Record<string, unknown>
          | undefined;
        const codexSessionId = String(sessionMeta?.id || "").trim();
        const cwd =
          typeof sessionMeta?.cwd === "string" && sessionMeta.cwd.trim()
            ? sessionMeta.cwd.trim()
            : null;
        const firstUserEvent = records.find(
          (record) =>
            record.type === "event_msg" &&
            record.payload &&
            typeof record.payload === "object" &&
            (record.payload as Record<string, unknown>).type === "user_message",
        );
        const firstUserMessage =
          firstUserEvent &&
          typeof (firstUserEvent.payload as Record<string, unknown>).message === "string"
            ? String((firstUserEvent.payload as Record<string, unknown>).message).trim()
            : "";
        const resolvedPath = path.resolve(rolloutPath);
        const imported = importedByPath.get(resolvedPath);

        return {
          codexSessionId,
          rolloutPath: resolvedPath,
          cwd,
          updatedAt: statSync(rolloutPath).mtime.toISOString(),
          title: firstUserMessage ? shorten(firstUserMessage, 80) : null,
          importedSessionId: imported?.session_id ?? null,
          importedAt: imported?.imported_at ?? null,
        };
      })
      .filter((item) => !item.codexSessionId || !nativeThreadIds.has(item.codexSessionId));
  }

  importRollout(rolloutPathInput: string): ImportResult {
    const rolloutPath = path.resolve(rolloutPathInput.trim());
    if (!rolloutPathInput.trim()) {
      throw new AppError(400, "rolloutPath is required.");
    }
    if (!existsSync(rolloutPath)) {
      throw new AppError(404, "Rollout file not found.");
    }

    const existing = this.db
      .prepare(
        `
          SELECT id
          FROM sessions
          WHERE source_kind = 'imported_rollout'
            AND source_rollout_path = ?
          LIMIT 1
        `,
      )
      .get(rolloutPath) as { id: string } | undefined;

    if (existing) {
      const sync = this.syncImportedSession(existing.id);
      return {
        sessionId: existing.id,
        imported: false,
        syncedEvents: sync.appendedEvents,
      };
    }

    const translated = translateRolloutRecords(parseJsonlRecords(rolloutPath), 0);
    const sessionId = createId("sess");
    const projectId = this.findOrCreateProjectForImportedRollout(
      translated.workspacePath,
      translated.firstTimestamp,
    );

    const insertEvent = this.db.prepare(
      `
        INSERT INTO session_events (
          id,
          session_id,
          turn_id,
          seq,
          event_type,
          message_id,
          call_id,
          request_id,
          phase,
          stream,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    runInTransaction(this.db, () => {
      this.db
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
          sessionId,
          translated.sessionTitle,
          projectId,
          translated.sessionStatus,
          null,
          translated.codexSessionId,
          "imported_rollout",
          rolloutPath,
          translated.codexSessionId,
          translated.rawCursor,
          translated.lastTimestamp,
          translated.sourceRolloutHasOpenTurn ? 1 : 0,
          translated.firstTimestamp,
          translated.lastTimestamp,
        );

      translated.events.forEach((event, index) => {
        insertEvent.run(
          `${sessionId}_import_${String(index + 1).padStart(6, "0")}`,
          sessionId,
          event.turnId,
          index + 1,
          event.type,
          event.messageId,
          event.callId,
          event.requestId,
          event.phase,
          event.stream,
          JSON.stringify(event.payload ?? {}),
          event.timestamp,
        );
      });
    });

    return {
      sessionId,
      imported: true,
      syncedEvents: translated.events.length,
    };
  }

  syncImportedSession(sessionId: string): SyncResult {
    const session = this.db
      .prepare(
        `
          SELECT *
          FROM sessions
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(sessionId) as SessionRecord | undefined;

    if (!session) {
      throw new AppError(404, "Session not found.");
    }

    if (session.source_kind !== "imported_rollout" || !session.source_rollout_path) {
      return {
        sessionId,
        synced: false,
        appendedEvents: 0,
        reason: "not-imported",
      };
    }

    if (session.status === "starting" || session.status === "running" || session.status === "stopping") {
      return {
        sessionId,
        synced: false,
        appendedEvents: 0,
        reason: "live-runtime",
      };
    }

    const rolloutPath = path.resolve(session.source_rollout_path);
    if (!existsSync(rolloutPath)) {
      throw new AppError(404, "Imported rollout source no longer exists.");
    }

    const records = parseJsonlRecords(rolloutPath);
    const cursor = Math.max(0, session.source_sync_cursor ?? 0);
    if (records.length <= cursor) {
      return {
        sessionId,
        synced: false,
        appendedEvents: 0,
        reason: "up-to-date",
      };
    }

    const translated = translateRolloutRecords(records, cursor);
    if (translated.events.length === 0) {
      this.db
        .prepare(
          `
            UPDATE sessions
            SET
              source_sync_cursor = ?,
              source_last_synced_at = ?,
              source_rollout_has_open_turn = ?,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          records.length,
          translated.lastTimestamp,
          translated.sourceRolloutHasOpenTurn ? 1 : 0,
          nowIso(),
          sessionId,
        );
      return {
        sessionId,
        synced: true,
        appendedEvents: 0,
      };
    }

    const currentMaxSeq = (
      this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS value FROM session_events WHERE session_id = ?")
        .get(sessionId) as { value: number }
    ).value;
    const insertEvent = this.db.prepare(
      `
        INSERT INTO session_events (
          id,
          session_id,
          turn_id,
          seq,
          event_type,
          message_id,
          call_id,
          request_id,
          phase,
          stream,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    runInTransaction(this.db, () => {
      translated.events.forEach((event, index) => {
        const seq = currentMaxSeq + index + 1;
        insertEvent.run(
          `${sessionId}_sync_${String(seq).padStart(6, "0")}`,
          sessionId,
          event.turnId,
          seq,
          event.type,
          event.messageId,
          event.callId,
          event.requestId,
          event.phase,
          event.stream,
          JSON.stringify(event.payload ?? {}),
          event.timestamp,
        );
      });

      this.db
        .prepare(
          `
            UPDATE sessions
            SET
              title = COALESCE(title, ?),
              codex_thread_id = COALESCE(codex_thread_id, ?),
              source_thread_id = COALESCE(source_thread_id, ?),
              source_sync_cursor = ?,
              source_last_synced_at = ?,
              source_rollout_has_open_turn = ?,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          translated.sessionTitle,
          translated.codexSessionId,
          translated.codexSessionId,
          translated.rawCursor,
          translated.lastTimestamp,
          translated.sourceRolloutHasOpenTurn ? 1 : 0,
          nowIso(),
          sessionId,
        );
    });

    return {
      sessionId,
      synced: true,
      appendedEvents: translated.events.length,
    };
  }

  private findOrCreateProjectForImportedRollout(workspacePath: string, createdAt: string): string {
    const existing = this.db
      .prepare(
        `
          SELECT id
          FROM projects
          WHERE path = ?
          LIMIT 1
        `,
      )
      .get(workspacePath) as { id: string } | undefined;

    if (existing?.id) {
      return existing.id;
    }

    const projectId = createId("proj");
    this.db
      .prepare(
        `
          INSERT INTO projects (id, name, path, created_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(projectId, `Imported Rollout: ${path.basename(workspacePath)}`, workspacePath, createdAt);
    return projectId;
  }
}
