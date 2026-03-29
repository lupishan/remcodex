import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

interface CodexThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  source: string;
  model_provider: string;
  cwd: string;
  title: string;
  sandbox_policy: string;
  approval_mode: string;
  tokens_used: number;
  has_user_event: number;
  archived: number;
  archived_at: number | null;
  git_sha: string | null;
  git_branch: string | null;
  git_origin_url: string | null;
  cli_version: string | null;
  first_user_message: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  memory_mode: string | null;
  model: string | null;
  reasoning_effort: string | null;
}

export interface CodexStatusThread {
  threadId: string;
  rolloutPath: string;
  source: string;
  modelProvider: string;
  cwd: string;
  title: string;
  sandboxPolicy: string;
  approvalMode: string;
  tokensUsed: number;
  hasUserEvent: boolean;
  archived: boolean;
  archivedAt: string | null;
  gitSha: string | null;
  gitBranch: string | null;
  gitOriginUrl: string | null;
  cliVersion: string | null;
  firstUserMessage: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  memoryMode: string | null;
  model: string | null;
  reasoningEffort: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodexStatusResponse {
  thread: CodexStatusThread | null;
  source: "threadId" | "cwd" | "latest" | "none";
  runtime: {
    executionMode: "codex exec --json" | "codex app-server";
    interactiveApprovalUi: boolean;
    cwd: string | null;
    workspaceRoot: string | null;
    sandboxMode: string | null;
    approvalMode: string | null;
    writableRoots: string[];
  };
  fetchedAt: string;
}

interface ResolveCodexStatusInput {
  threadId?: string | null;
  cwd?: string | null;
  executionMode?: CodexStatusResponse["runtime"]["executionMode"];
  interactiveApprovalUi?: boolean;
}

function resolveCodexHomeDir(): string {
  const override = process.env.CODEX_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.join(os.homedir(), ".codex");
}

function resolveStateDbPath(): string {
  const override = process.env.CODEX_STATE_DB_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.join(resolveCodexHomeDir(), "state_5.sqlite");
}

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function normalizeNonEmpty(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function parseSandboxPolicy(raw: string | null | undefined): {
  sandboxMode: string | null;
  writableRoots: string[];
} {
  const text = normalizeNonEmpty(raw);
  if (!text) {
    return {
      sandboxMode: null,
      writableRoots: [],
    };
  }

  if (!text.startsWith("{")) {
    return {
      sandboxMode: text,
      writableRoots: [],
    };
  }

  try {
    const parsed = JSON.parse(text) as {
      type?: unknown;
      writable_roots?: unknown;
    };

    const writableRoots = Array.isArray(parsed.writable_roots)
      ? parsed.writable_roots
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];

    return {
      sandboxMode: normalizeNonEmpty(typeof parsed.type === "string" ? parsed.type : null),
      writableRoots,
    };
  } catch {
    return {
      sandboxMode: text,
      writableRoots: [],
    };
  }
}

function deriveWritableRoots(sandboxMode: string | null, cwd: string | null, parsedRoots: string[]): string[] {
  if (parsedRoots.length > 0) {
    return parsedRoots;
  }

  if (sandboxMode === "danger-full-access") {
    return ["<full-access>"];
  }

  if (sandboxMode === "workspace-write") {
    const roots = [];
    if (cwd) {
      roots.push(cwd);
    }
    roots.push("/tmp");
    return roots;
  }

  return [];
}

function buildRuntime(
  row: CodexThreadRow | undefined,
  input: ResolveCodexStatusInput,
): CodexStatusResponse["runtime"] {
  const cwd = normalizeNonEmpty(row?.cwd ?? input.cwd ?? null);
  const parsedPolicy = parseSandboxPolicy(row?.sandbox_policy ?? null);
  const sandboxMode = parsedPolicy.sandboxMode;
  const approvalMode = normalizeNonEmpty(row?.approval_mode ?? null);

  return {
    executionMode: input.executionMode ?? "codex app-server",
    interactiveApprovalUi: input.interactiveApprovalUi ?? false,
    cwd,
    workspaceRoot: cwd,
    sandboxMode,
    approvalMode,
    writableRoots: deriveWritableRoots(sandboxMode, cwd, parsedPolicy.writableRoots),
  };
}

function mapThread(row: CodexThreadRow): CodexStatusThread {
  return {
    threadId: row.id,
    rolloutPath: row.rollout_path,
    source: row.source,
    modelProvider: row.model_provider,
    cwd: row.cwd,
    title: row.title,
    sandboxPolicy: row.sandbox_policy,
    approvalMode: row.approval_mode,
    tokensUsed: row.tokens_used,
    hasUserEvent: row.has_user_event !== 0,
    archived: row.archived !== 0,
    archivedAt: row.archived_at == null ? null : toIso(row.archived_at),
    gitSha: row.git_sha,
    gitBranch: row.git_branch,
    gitOriginUrl: row.git_origin_url,
    cliVersion: row.cli_version,
    firstUserMessage: row.first_user_message,
    agentNickname: row.agent_nickname,
    agentRole: row.agent_role,
    memoryMode: row.memory_mode,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function resolveCodexStatus(input: ResolveCodexStatusInput = {}): CodexStatusResponse {
  const dbPath = resolveStateDbPath();
  if (!existsSync(dbPath)) {
    return {
      thread: null,
      source: "none",
      runtime: buildRuntime(undefined, input),
      fetchedAt: new Date().toISOString(),
    };
  }

  const db = new Database(dbPath);
  try {
    const byId = db.prepare("SELECT * FROM threads WHERE id = ? LIMIT 1");
    const byCwd = db.prepare("SELECT * FROM threads WHERE cwd = ? ORDER BY updated_at DESC, id DESC LIMIT 1");
    const latest = db.prepare("SELECT * FROM threads ORDER BY updated_at DESC, id DESC LIMIT 1");

    let row: CodexThreadRow | undefined;
    let source: CodexStatusResponse["source"] = "none";

    if (input.threadId?.trim()) {
      row = byId.get(input.threadId.trim()) as CodexThreadRow | undefined;
      source = row ? "threadId" : "none";
    }

    if (!row && input.cwd?.trim()) {
      row = byCwd.get(input.cwd.trim()) as CodexThreadRow | undefined;
      source = row ? "cwd" : source;
    }

    if (!row) {
      row = latest.get() as CodexThreadRow | undefined;
      source = row ? "latest" : "none";
    }

    return {
      thread: row ? mapThread(row) : null,
      source,
      runtime: buildRuntime(row, input),
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    (db as { close?: () => void }).close?.();
  }
}
