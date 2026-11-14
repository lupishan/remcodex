import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodexChildEnvironment } from "../server/src/services/codex-runner";

test("worker child environments contain only the session worker credential", () => {
  const previousAdmin = process.env.REMCODEX_PEER_ADMIN_TOKEN;
  const previousMcp = process.env.REMCODEX_MCP_API_TOKEN;
  const previousWorker = process.env.REMCODEX_PEER_TOKEN;
  process.env.REMCODEX_PEER_ADMIN_TOKEN = "administrator-secret";
  process.env.REMCODEX_MCP_API_TOKEN = "mcp-administrator-secret";
  process.env.REMCODEX_PEER_TOKEN = "old-worker-secret";
  try {
    const env = buildCodexChildEnvironment("/tmp/codex-home", "new-worker-secret");
    assert.equal(env.CODEX_HOME, "/tmp/codex-home");
    assert.equal(env.REMCODEX_PEER_TOKEN, "new-worker-secret");
    assert.equal(env.REMCODEX_PEER_ADMIN_TOKEN, undefined);
    assert.equal(env.REMCODEX_MCP_API_TOKEN, undefined);
  } finally {
    if (previousAdmin === undefined) delete process.env.REMCODEX_PEER_ADMIN_TOKEN;
    else process.env.REMCODEX_PEER_ADMIN_TOKEN = previousAdmin;
    if (previousMcp === undefined) delete process.env.REMCODEX_MCP_API_TOKEN;
    else process.env.REMCODEX_MCP_API_TOKEN = previousMcp;
    if (previousWorker === undefined) delete process.env.REMCODEX_PEER_TOKEN;
    else process.env.REMCODEX_PEER_TOKEN = previousWorker;
  }
});

test("worker launch environment construction does not persist credential text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-peer-launch-"));
  const env = buildCodexChildEnvironment(path.join(root, "home"), "session-worker-secret");
  assert.equal(Object.values(env).includes("session-worker-secret"), true);
  assert.equal(fs.readdirSync(root).length, 0);
});
