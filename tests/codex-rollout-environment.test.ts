import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/src/db/client";
import { runMigrations } from "../server/src/db/migrations";
import { CodexRolloutSyncService } from "../server/src/services/codex-rollout-sync";

test("rollout discovery reads the selected agent environment home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-rollout-home-"));
  const rolloutPath = path.join(root, "sessions", "2026", "rollout-writer.jsonl");
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({ type: "session_meta", payload: { id: "writer-thread", cwd: root } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-21T00:00:00.000Z",
        payload: { type: "user_message", message: "Inspect the workspace" },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const db = createDatabase(":memory:");
  runMigrations(db);
  const service = new CodexRolloutSyncService(db);
  const items = service.listImportableSessions(20, root);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.codexSessionId, "writer-thread");
  assert.equal(items[0]?.rolloutPath, path.resolve(rolloutPath));
  assert.equal(items[0]?.title, "Inspect the workspace");
});
