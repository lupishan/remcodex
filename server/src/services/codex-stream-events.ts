import type { CodexJsonEvent } from "./codex-exec-runner";
import type { AssistantPhase, EventType, IoStream } from "../types/models";

const LEGACY_EVENT_TYPES = new Set([
  "thread.started",
  "item.started",
  "item.completed",
  "turn.completed",
]);

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

export interface SemanticEventDraft {
  type: EventType;
  turnId?: string | null;
  messageId?: string | null;
  callId?: string | null;
  requestId?: string | null;
  phase?: AssistantPhase | null;
  stream?: IoStream | null;
  payload: Record<string, unknown>;
}

export type CodexSemanticSignal =
  | {
      kind: "thread_started";
      threadId: string;
    }
  | {
      kind: "approval_request";
      requestId: number;
      method: string;
      params: Record<string, unknown>;
      turnId: string | null;
      callId: string | null;
    }
  | {
      kind: "event";
      event: SemanticEventDraft;
    };

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRawText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readTurnId(params?: Record<string, unknown> | null): string | null {
  return (
    readString(params?.turnId) ||
    readString(asRecord(params?.turn)?.id) ||
    readString(params?.turn_id) ||
    null
  );
}

function readItem(params?: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(params?.item);
}

function normalizePhase(value: unknown): AssistantPhase | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function readMessageId(params?: Record<string, unknown> | null): string | null {
  const item = readItem(params);
  return (
    readString(params?.messageId) ||
    readString(params?.message_id) ||
    readString(params?.itemId) ||
    readString(item?.id) ||
    null
  );
}

function readCallId(params?: Record<string, unknown> | null): string | null {
  const item = readItem(params);
  return (
    readString(params?.callId) ||
    readString(params?.call_id) ||
    readString(params?.itemId) ||
    readString(item?.callId) ||
    readString(item?.call_id) ||
    readString(item?.id) ||
    null
  );
}

function readIoStream(value: unknown): IoStream | null {
  return value === "stderr" ? "stderr" : value === "stdout" ? "stdout" : null;
}

function readItemType(params?: Record<string, unknown> | null): string | null {
  const item = readItem(params);
  return readString(item?.type);
}

function isPatchItemType(type: string | null): boolean {
  return type === "fileChange" || type === "patch" || type === "applyPatch";
}

function readMessageText(item: Record<string, unknown> | null): string | null {
  const direct = readString(item?.text);
  if (direct) {
    return direct;
  }

  const content = Array.isArray(item?.content) ? item?.content : [];
  const text = content
    .map((entry) => {
      const record = asRecord(entry);
      return readString(record?.text) || "";
    })
    .filter(Boolean)
    .join("\n");

  return text || null;
}

export function isCodexLegacyEvent(raw: unknown): raw is CodexJsonEvent {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const type = (raw as { type?: unknown }).type;
  return typeof type === "string" && LEGACY_EVENT_TYPES.has(type);
}

export function isCodexEnvelopeEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const type = (raw as { type?: unknown }).type;
  return type === "response_item" || type === "event_msg";
}

export function isCodexAppServerMessage(
  raw: unknown,
): raw is { method: string; params?: unknown; id?: number } {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const method = (raw as { method?: unknown }).method;
  return typeof method === "string";
}

export function translateCodexAppServerMessage(
  raw: { method: string; params?: unknown; id?: number },
): CodexSemanticSignal[] {
  const params = asRecord(raw.params);
  const turnId = readTurnId(params);
  const signals: CodexSemanticSignal[] = [];

  if (raw.method === "thread/started") {
    const thread = asRecord(params?.thread);
    const threadId = readString(thread?.id);
    if (threadId) {
      signals.push({
        kind: "thread_started",
        threadId,
      });
    }
    return signals;
  }

  if (APPROVAL_METHODS.has(raw.method) && typeof raw.id === "number") {
    signals.push({
      kind: "approval_request",
      requestId: raw.id,
      method: raw.method,
      params: params ?? {},
      turnId,
      callId: readCallId(params),
    });
    return signals;
  }

  if (raw.method === "thread/tokenUsage/updated") {
    const tokenUsage = asRecord(params?.tokenUsage);
    signals.push({
      kind: "event",
      event: {
        type: "token_count",
        turnId,
        payload: {
          rateLimits:
            asRecord(params?.rateLimits) ||
            asRecord(params?.rate_limits) ||
            asRecord(tokenUsage?.rateLimits) ||
            {},
          totalTokenUsage:
            asRecord(tokenUsage?.total) ||
            asRecord(tokenUsage?.totalTokenUsage) ||
            undefined,
          lastTokenUsage:
            asRecord(tokenUsage?.last) ||
            asRecord(tokenUsage?.lastTokenUsage) ||
            undefined,
          modelContextWindow:
            readNumber(params?.modelContextWindow) ??
            readNumber(tokenUsage?.modelContextWindow) ??
            undefined,
          receivedAt: new Date().toISOString(),
          rawPayload: params ?? {},
          source: "live",
        },
      },
    });
    return signals;
  }

  if (raw.method === "turn/started") {
    signals.push({
      kind: "event",
      event: {
        type: "turn.started",
        turnId,
        payload: {
          createdAt: new Date().toISOString(),
        },
      },
    });
    return signals;
  }

  if (raw.method === "turn/completed") {
    const turn = asRecord(params?.turn);
    const status = readString(turn?.status) || "completed";
    const error = asRecord(turn?.error);
    if (error && readString(error.message)) {
      signals.push({
        kind: "event",
        event: {
          type: "error",
          turnId,
          payload: {
            message: readString(error.message) || "Turn failed.",
            code: readString(error.code),
            details: error,
          },
        },
      });
    }

    signals.push({
      kind: "event",
      event: {
        type:
          status === "cancelled" || status === "aborted" || status === "failed"
            ? "turn.aborted"
            : "turn.completed",
        turnId,
        payload:
          status === "cancelled" || status === "aborted" || status === "failed"
            ? {
                abortedAt: new Date().toISOString(),
                reason: readString(error?.message) || status,
              }
            : {
                completedAt: new Date().toISOString(),
              },
      },
    });
    return signals;
  }

  if (raw.method === "error") {
    const error = asRecord(params?.error);
    signals.push({
      kind: "event",
      event: {
        type: "error",
        turnId,
        payload: {
          message: readString(error?.message) || "Codex app-server reported an error.",
          code: readString(error?.code),
          details: {
            ...(error ?? {}),
            willRetry: params?.willRetry ?? null,
          },
        },
      },
    });
    return signals;
  }

  if (raw.method === "item/agentMessage/delta") {
    signals.push({
      kind: "event",
      event: {
        type: "message.assistant.delta",
        turnId,
        messageId: readMessageId(params),
        phase:
          normalizePhase(params?.phase) ||
          normalizePhase(readItem(params)?.phase) ||
          "final_answer",
        payload: {
          textDelta: readRawText(params?.delta) || "",
        },
      },
    });
    return signals;
  }

  if (raw.method === "item/updated" || raw.method === "item/agentMessage/updated") {
    const item = readItem(params) || params;
    const itemType =
      readItemType(params) ||
      readString(item?.type) ||
      readString(params?.type);
    if (itemType === "agentMessage") {
      signals.push({
        kind: "event",
        event: {
          type: "message.assistant.delta",
          turnId,
          messageId: readMessageId(params),
          phase:
            normalizePhase(params?.phase) ||
            normalizePhase(item?.phase) ||
            "final_answer",
          payload: {
            text: readMessageText(item) || "",
          },
        },
      });
      return signals;
    }

    if (itemType === "reasoning") {
      const summary = readString(item?.summary) || "";
      signals.push({
        kind: "event",
        event: {
          type: "reasoning.delta",
          turnId,
          messageId: readMessageId(params),
          payload: {
            text: summary,
            summary,
          },
        },
      });
      return signals;
    }
  }

  if (raw.method === "item/reasoning/delta" || raw.method === "item/reasoningSummary/delta") {
    signals.push({
      kind: "event",
      event: {
        type: "reasoning.delta",
        turnId,
        messageId: readMessageId(params),
        payload: {
          textDelta: readRawText(params?.delta) || readRawText(params?.summary) || "",
          summary: readString(params?.summary),
        },
      },
    });
    return signals;
  }

  if (raw.method === "item/commandExecution/outputDelta") {
    signals.push({
      kind: "event",
      event: {
        type: "command.output.delta",
        turnId,
        callId: readCallId(params),
        stream: readIoStream(params?.stream) || "stdout",
        payload: {
          stream: readIoStream(params?.stream) || "stdout",
          textDelta: readRawText(params?.delta) || "",
        },
      },
    });
    return signals;
  }

  if (raw.method === "item/fileChange/outputDelta" || raw.method === "item/patch/outputDelta") {
    signals.push({
      kind: "event",
      event: {
        type: "patch.output.delta",
        turnId,
        callId: readCallId(params),
        payload: {
          textDelta: readRawText(params?.delta) || "",
        },
      },
    });
    return signals;
  }

  if (raw.method === "item/started") {
    const item = readItem(params);
    const itemType = readItemType(params);
    if (itemType === "agentMessage") {
      signals.push({
        kind: "event",
        event: {
          type: "message.assistant.start",
          turnId,
          messageId: readMessageId(params),
          phase: normalizePhase(item?.phase) || "final_answer",
          payload: {
            text: readMessageText(item) || "",
          },
        },
      });
      return signals;
    }

    if (itemType === "reasoning") {
      signals.push({
        kind: "event",
        event: {
          type: "reasoning.start",
          turnId,
          messageId: readMessageId(params),
          payload: {
            summary: readString(item?.summary),
          },
        },
      });
      return signals;
    }

    if (itemType === "commandExecution") {
      signals.push({
        kind: "event",
        event: {
          type: "command.start",
          turnId,
          callId: readCallId(params),
          payload: {
            command: readString(item?.command) || "",
            cwd: readString(item?.cwd),
            justification: readString(item?.justification),
            sandboxMode: readString(item?.sandbox) || readString(item?.sandboxMode),
            approvalRequired: Boolean(item?.approvalRequired ?? false),
            grantRoot: readString(item?.grantRoot),
          },
        },
      });
      return signals;
    }

    if (isPatchItemType(itemType)) {
      signals.push({
        kind: "event",
        event: {
          type: "patch.start",
          turnId,
          callId: readCallId(params),
          payload: {
            summary: readString(item?.summary),
            target: readString(item?.target),
          },
        },
      });
      return signals;
    }
  }

  if (raw.method === "item/completed") {
    const item = readItem(params);
    const itemType = readItemType(params);
    if (itemType === "agentMessage") {
      signals.push({
        kind: "event",
        event: {
          type: "message.assistant.end",
          turnId,
          messageId: readMessageId(params),
          phase: normalizePhase(item?.phase) || "final_answer",
          payload: {
            text: readMessageText(item) || "",
            finishReason: readString(item?.finishReason) || readString(item?.finish_reason),
          },
        },
      });
      return signals;
    }

    if (itemType === "reasoning") {
      signals.push({
        kind: "event",
        event: {
          type: "reasoning.end",
          turnId,
          messageId: readMessageId(params),
          payload: {
            summary: readString(item?.summary),
          },
        },
      });
      return signals;
    }

    if (itemType === "commandExecution") {
      signals.push({
        kind: "event",
        event: {
          type: "command.end",
          turnId,
          callId: readCallId(params),
          payload: {
            command: readString(item?.command),
            cwd: readString(item?.cwd),
            status: readString(item?.status),
            exitCode: readNumber(item?.exitCode),
            durationMs: readNumber(item?.durationMs) ?? readNumber(item?.duration_ms),
            rejected: item?.rejected === true,
          },
        },
      });
      return signals;
    }

    if (isPatchItemType(itemType)) {
      signals.push({
        kind: "event",
        event: {
          type: "patch.end",
          turnId,
          callId: readCallId(params),
          payload: {
            status: readString(item?.status),
            durationMs: readNumber(item?.durationMs) ?? readNumber(item?.duration_ms),
            success: typeof item?.success === "boolean" ? item.success : null,
            rejected: item?.rejected === true,
          },
        },
      });
      return signals;
    }
  }

  return signals;
}
