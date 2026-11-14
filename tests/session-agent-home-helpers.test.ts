import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { resolveCodexStatus } from "../server/src/utils/codex-status";
import { resolveCodexQuotaSnapshot } from "../server/src/utils/codex-quota";

test("status inspection reads the selected session agent environment home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-status-home-"));
  const statePath = path.join(root, "state_5.sqlite");
  const db = new Database(statePath);
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER)");
  db.prepare("INSERT INTO threads (id, rollout_path, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    "thread-writer",
    "sessions/writer.jsonl",
    root,
    1_700_000_000,
    1_700_000_000,
  );
  db.close();

  const status = resolveCodexStatus({ threadId: "thread-writer", codexHome: root });
  assert.equal(status.source, "threadId");
  assert.equal(status.thread?.threadId, "thread-writer");
  assert.equal(status.thread?.cwd, root);
});

test("quota inspection reads rollout history from the selected agent environment home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-quota-home-"));
  const sessionsRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsRoot, "writer-thread.jsonl"),
    JSON.stringify({
      type: "token_count",
      timestamp: "2026-08-21T00:00:00.000Z",
      rate_limits: { primary: { used_percent: 25 } },
      info: { model_context_window: 1000 },
    }) + "\n",
    "utf8",
  );

  const snapshot = resolveCodexQuotaSnapshot({ threadId: "writer-thread", codexHome: root });
  assert.equal(snapshot?.source, "rollout");
  assert.deepEqual(snapshot?.rateLimits, { primary: { used_percent: 25 } });
  assert.equal(snapshot?.modelContextWindow, 1000);
});
