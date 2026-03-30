export const SESSION_STATUSES = [
  "idle",
  "starting",
  "running",
  "waiting_input",
  "stopping",
  "completed",
  "failed",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_SOURCE_KINDS = ["native", "imported_rollout"] as const;
export type SessionSourceKind = (typeof SESSION_SOURCE_KINDS)[number];

export const EVENT_TYPES = [
  "message.user",
  "message.assistant.start",
  "message.assistant.delta",
  "message.assistant.end",
  "reasoning.start",
  "reasoning.delta",
  "reasoning.end",
  "command.start",
  "command.output.delta",
  "command.end",
  "patch.start",
  "patch.output.delta",
  "patch.end",
  "approval.requested",
  "approval.resolved",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "error",
  "token_count",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ASSISTANT_PHASES = ["commentary", "final_answer"] as const;
export type AssistantPhase = (typeof ASSISTANT_PHASES)[number];

export const IO_STREAMS = ["stdout", "stderr"] as const;
export type IoStream = (typeof IO_STREAMS)[number];

export interface TokenCountPayload {
  rateLimits: Record<string, unknown>;
  totalTokenUsage?: Record<string, unknown>;
  lastTokenUsage?: Record<string, unknown>;
  modelContextWindow?: number;
  receivedAt: string;
  rawPayload?: Record<string, unknown>;
  source?: "live" | "rollout";
}

export type CodexQuotaPayload = TokenCountPayload;

export interface SessionApprovalPayload {
  requestId: string;
  callId: string | null;
  method: string;
  title: string;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  grantRoot: string | null;
  createdAt: string;
  rawParams?: Record<string, unknown>;
  resumable?: boolean;
  source?: "live" | "event-log";
}

export interface SessionApprovalResolvedPayload {
  requestId: string;
  callId: string | null;
  decision: string;
  resolvedAt: string;
}

export interface UserMessagePayload {
  text: string;
}

export interface AssistantMessageStartPayload {
  text?: string;
}

export interface AssistantMessageDeltaPayload {
  textDelta: string;
}

export interface AssistantMessageEndPayload {
  text?: string;
  finishReason?: string | null;
}

export interface ReasoningStartPayload {
  summary?: string | null;
}

export interface ReasoningDeltaPayload {
  textDelta: string;
  summary?: string | null;
}

export interface ReasoningEndPayload {
  summary?: string | null;
}

export interface CommandStartPayload {
  command: string;
  cwd: string | null;
  justification?: string | null;
  sandboxMode?: string | null;
  approvalRequired?: boolean | null;
  grantRoot?: string | null;
}

export interface CommandOutputDeltaPayload {
  textDelta: string;
  stream: IoStream;
  truncated?: boolean;
}

export interface CommandEndPayload {
  command?: string | null;
  cwd?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  aggregatedOutput?: string | null;
  formattedOutput?: string | null;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  status?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  rejected?: boolean;
}

export interface PatchStartPayload {
  summary?: string | null;
  target?: string | null;
}

export interface PatchOutputDeltaPayload {
  textDelta: string;
}

export interface PatchEndPayload {
  status?: string | null;
  durationMs?: number | null;
  success?: boolean | null;
  rejected?: boolean;
  patchText?: string | null;
  changes?: Record<string, { added?: number | null; removed?: number | null }> | null;
}

export interface TurnStartedPayload {
  createdAt?: string;
}

export interface TurnCompletedPayload {
  completedAt?: string;
  reason?: string | null;
}

export interface TurnAbortedPayload {
  abortedAt?: string;
  reason?: string | null;
}

export interface ErrorPayload {
  message: string;
  code?: string | null;
  details?: Record<string, unknown> | null;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  title: string | null;
  project_id: string;
  status: SessionStatus;
  pid: number | null;
  codex_thread_id: string | null;
  source_kind: SessionSourceKind;
  source_rollout_path: string | null;
  source_thread_id: string | null;
  source_sync_cursor: number | null;
  source_last_synced_at: string | null;
  /** 1/0 from DB: external Codex rollout still has an unclosed turn (not local runner state). */
  source_rollout_has_open_turn: number;
  created_at: string;
  updated_at: string;
}

export interface SessionListRecord extends SessionRecord {
  last_event_at: string | null;
  last_assistant_content: string | null;
  last_command: string | null;
  event_count: number;
}

export interface ImportableCodexSessionRecord {
  codexSessionId: string;
  rolloutPath: string;
  cwd: string | null;
  updatedAt: string;
  title: string | null;
  importedSessionId: string | null;
  importedAt: string | null;
}

export interface SessionEventRecord {
  id: string;
  session_id: string;
  turn_id: string | null;
  seq: number;
  event_type: EventType;
  message_id: string | null;
  call_id: string | null;
  request_id: string | null;
  phase: AssistantPhase | null;
  stream: IoStream | null;
  payload_json: string | null;
  created_at: string;
}

interface SemanticEventBase<TType extends EventType, TPayload> {
  id: string;
  sessionId: string;
  type: TType;
  seq: number;
  timestamp: string;
  turnId: string | null;
  messageId: string | null;
  callId: string | null;
  requestId: string | null;
  phase: AssistantPhase | null;
  stream: IoStream | null;
  payload: TPayload;
}

export type UserMessageEvent = SemanticEventBase<"message.user", UserMessagePayload>;
export type AssistantMessageStartEvent = SemanticEventBase<
  "message.assistant.start",
  AssistantMessageStartPayload
>;
export type AssistantMessageDeltaEvent = SemanticEventBase<
  "message.assistant.delta",
  AssistantMessageDeltaPayload
>;
export type AssistantMessageEndEvent = SemanticEventBase<
  "message.assistant.end",
  AssistantMessageEndPayload
>;
export type ReasoningStartEvent = SemanticEventBase<"reasoning.start", ReasoningStartPayload>;
export type ReasoningDeltaEvent = SemanticEventBase<"reasoning.delta", ReasoningDeltaPayload>;
export type ReasoningEndEvent = SemanticEventBase<"reasoning.end", ReasoningEndPayload>;
export type CommandStartEvent = SemanticEventBase<"command.start", CommandStartPayload>;
export type CommandOutputDeltaEvent = SemanticEventBase<
  "command.output.delta",
  CommandOutputDeltaPayload
>;
export type CommandEndEvent = SemanticEventBase<"command.end", CommandEndPayload>;
export type PatchStartEvent = SemanticEventBase<"patch.start", PatchStartPayload>;
export type PatchOutputDeltaEvent = SemanticEventBase<
  "patch.output.delta",
  PatchOutputDeltaPayload
>;
export type PatchEndEvent = SemanticEventBase<"patch.end", PatchEndPayload>;
export type ApprovalRequestedEvent = SemanticEventBase<
  "approval.requested",
  SessionApprovalPayload
>;
export type ApprovalResolvedEvent = SemanticEventBase<
  "approval.resolved",
  SessionApprovalResolvedPayload
>;
export type TurnStartedEvent = SemanticEventBase<"turn.started", TurnStartedPayload>;
export type TurnCompletedEvent = SemanticEventBase<"turn.completed", TurnCompletedPayload>;
export type TurnAbortedEvent = SemanticEventBase<"turn.aborted", TurnAbortedPayload>;
export type ErrorEvent = SemanticEventBase<"error", ErrorPayload>;
export type TokenCountEvent = SemanticEventBase<"token_count", TokenCountPayload>;

export type SessionEventPayload =
  | UserMessageEvent
  | AssistantMessageStartEvent
  | AssistantMessageDeltaEvent
  | AssistantMessageEndEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | CommandStartEvent
  | CommandOutputDeltaEvent
  | CommandEndEvent
  | PatchStartEvent
  | PatchOutputDeltaEvent
  | PatchEndEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnAbortedEvent
  | ErrorEvent
  | TokenCountEvent;

export type EventInsertInput = Omit<
  SessionEventPayload,
  "id" | "sessionId" | "seq" | "timestamp"
> & {
  id?: string;
  timestamp?: string;
};
