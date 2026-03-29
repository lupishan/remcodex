import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { CodexQuotaPayload } from "../types/models";

interface ResolveCodexQuotaInput {
  threadId?: string | null;
  cwd?: string | null;
}

interface CodexThreadLookupRow {
  id: string;
  rollout_path: string;
  cwd: string;
  updated_at: number;
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

function readNumberField(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }

  if (typeof input === "string" && input.trim()) {
    const parsed = Number.parseFloat(input);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizeTokenCountPayload(
  payload: Record<string, unknown>,
  source: CodexQuotaPayload["source"],
  timestamp?: string,
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
  const modelContextWindow = readNumberField(info?.model_context_window);

  return {
    rateLimits,
    totalTokenUsage,
    lastTokenUsage,
    modelContextWindow,
    receivedAt: timestamp || new Date().toISOString(),
    rawPayload: payload,
    source,
  };
}

function parseQuotaLine(line: string): CodexQuotaPayload | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const raw = JSON.parse(trimmed) as {
      timestamp?: unknown;
      type?: unknown;
      payload?: unknown;
    };

    const timestamp =
      typeof raw.timestamp === "string" && raw.timestamp.trim() ? raw.timestamp.trim() : undefined;

    if (raw.type === "event_msg" && raw.payload && typeof raw.payload === "object") {
      const payload = raw.payload as { type?: unknown };
      if (payload.type === "token_count") {
        return normalizeTokenCountPayload(
          raw.payload as Record<string, unknown>,
          "rollout",
          timestamp,
        );
      }
    }

    if (raw.type === "token_count") {
      return normalizeTokenCountPayload(raw as Record<string, unknown>, "rollout", timestamp);
    }
  } catch {
    return null;
  }

  return null;
}

function findRolloutPathInStateDb(input: ResolveCodexQuotaInput): string | null {
  const dbPath = resolveStateDbPath();
  if (!existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath);
  try {
    const byId = db.prepare("SELECT id, rollout_path, cwd, updated_at FROM threads WHERE id = ? LIMIT 1");
    const byCwd = db.prepare(
      "SELECT id, rollout_path, cwd, updated_at FROM threads WHERE cwd = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
    );

    let row: CodexThreadLookupRow | undefined;
    if (input.threadId?.trim()) {
      row = byId.get(input.threadId.trim()) as CodexThreadLookupRow | undefined;
    }

    if (!row && input.cwd?.trim()) {
      row = byCwd.get(input.cwd.trim()) as CodexThreadLookupRow | undefined;
    }

    if (!row?.rollout_path) {
      return null;
    }

    const resolved = path.isAbsolute(row.rollout_path)
      ? row.rollout_path
      : path.resolve(resolveCodexHomeDir(), row.rollout_path);

    return existsSync(resolved) ? resolved : null;
  } finally {
    (db as { close?: () => void }).close?.();
  }
}

function scanDirForRollout(rootDir: string, threadId: string): string | null {
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const name of entries) {
      const nextPath = path.join(current, name);
      let stats;
      try {
        stats = statSync(nextPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(nextPath);
        continue;
      }

      if (
        stats.isFile() &&
        name.includes(threadId) &&
        name.endsWith(".jsonl")
      ) {
        return nextPath;
      }
    }
  }

  return null;
}

function findRolloutPathInSessions(threadId: string): string | null {
  const sessionsDir = path.join(resolveCodexHomeDir(), "sessions");
  if (!existsSync(sessionsDir)) {
    return null;
  }

  return scanDirForRollout(sessionsDir, threadId);
}

function readLatestQuotaFromRollout(rolloutPath: string): CodexQuotaPayload | null {
  if (!existsSync(rolloutPath)) {
    return null;
  }

  const body = readFileSync(rolloutPath, "utf8");
  const lines = body.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseQuotaLine(lines[index] || "");
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function resolveCodexQuotaSnapshot(
  input: ResolveCodexQuotaInput = {},
): CodexQuotaPayload | null {
  const rolloutPath =
    findRolloutPathInStateDb(input) ||
    (input.threadId?.trim() ? findRolloutPathInSessions(input.threadId.trim()) : null);

  if (!rolloutPath) {
    return null;
  }

  return readLatestQuotaFromRollout(rolloutPath);
}
