import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/src/db/client";
import { runMigrations } from "../server/src/db/migrations";
import { EventStore } from "../server/src/services/event-store";
import { ProjectManager } from "../server/src/services/project-manager";
import { SessionManager } from "../server/src/services/session-manager";
import type { AgentEnvironmentRegistry } from "../server/src/utils/agent-environment-registry";
import { resolveCodexHomePolicy } from "../server/src/services/codex-runner";

function makeProject(
  codexCommand: string,
  codexMode: "exec-json" | "app-server",
  agentEnvironmentRegistry?: AgentEnvironmentRegistry,
) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-diagnostics-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const eventStore = new EventStore(db);
  const projectManager = new ProjectManager(db, root, process.cwd());
  const manager = new SessionManager({
    db,
    eventStore,
    projectManager,
    codexCommand,
    codexMode,
    agentEnvironmentRegistry,
  });
  const project = projectManager.createProject({ name: "Diagnostics", path: projectPath });
  const session = manager.createSession({ projectId: project.id });
  return { eventStore, manager, projectPath, session };
}

function writeLauncher(root: string, script: string): string {
  const scriptPath = path.join(root, "runner.cjs");
  const launcherPath = path.join(root, "runner");
  fs.writeFileSync(scriptPath, script);
  fs.writeFileSync(launcherPath, `#!/bin/sh\nexec ${process.execPath} ${scriptPath} "$@"\n`);
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

async function waitForFailed(manager: SessionManager, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getSession(sessionId)?.status === "failed") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("session did not reach failed state");
}

test("persists stderr, command, cwd, and exit status for failed exec processes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-exec-runner-"));
  const command = writeLauncher(root, "process.stderr.write('exec diagnostic\\n'); process.exit(7);\n");
  const { eventStore, manager, projectPath, session } = makeProject(command, "exec-json");

  manager.sendMessage(session.id, "trigger failure");
  await waitForFailed(manager, session.id);

  const error = eventStore.listAll(session.id).find((event) => event.type === "error");
  assert.ok(error);
  assert.equal(error.payload.details?.command, command);
  assert.equal(error.payload.details?.cwd, projectPath);
  assert.equal(error.payload.details?.exitCode, 7);
  assert.equal(error.payload.details?.stderr, "exec diagnostic");
  assert.equal(error.payload.details?.executionMode, "exec-json");
});

test("persists stderr from app-server bootstrap failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-app-server-"));
  const codexHome = path.join(root, "reviewer");
  const command = writeLauncher(
    root,
    `const readline = require("node:readline");
process.stderr.write("bootstrap diagnostic CODEX_HOME=" + (process.env.CODEX_HOME || "") + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "bootstrap failed" } }) + "\\n");
});
`,
  );
  const { eventStore, manager, session } = makeProject(command, "app-server", {
    version: 1,
    defaultEnvironment: "reviewer",
    managedPaths: [root],
    allowedRoots: [root],
    environments: {
      reviewer: { name: "reviewer", codexHome, managedPath: root, allowedRoots: [root] },
    },
  });

  manager.sendMessage(session.id, "trigger bootstrap failure");
  await waitForFailed(manager, session.id);

  const error = eventStore.listAll(session.id).find((event) => event.type === "error");
  assert.ok(error);
  assert.match(String(error.payload.details?.stderr), new RegExp(`bootstrap diagnostic CODEX_HOME=${codexHome.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`));
  assert.equal(error.payload.details?.exitCode, 1);
  assert.equal(error.payload.details?.executionMode, "app-server");
});

test("launches local exec children with the session agent environment home", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-agent-home-"));
  const codexHome = path.join(root, "writer");
  const command = writeLauncher(
    root,
    "process.stderr.write(`CODEX_HOME=${process.env.CODEX_HOME || ''}\\n`); process.exit(7);\n",
  );
  const registry: AgentEnvironmentRegistry = {
    version: 1,
    defaultEnvironment: "writer",
    managedPaths: [root],
    allowedRoots: [root],
    environments: {
      writer: { name: "writer", codexHome, managedPath: root, allowedRoots: [root] },
    },
  };
  const { eventStore, manager, session } = makeProject(command, "exec-json", registry);
  manager.sendMessage(session.id, "use the selected environment");
  await waitForFailed(manager, session.id);

  const error = eventStore.listAll(session.id).find((event) => event.type === "error");
  assert.ok(error);
  assert.match(String(error.payload.details?.stderr), new RegExp(`CODEX_HOME=${codexHome.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`));
});

test("keeps remote app-server homes fixed on the external server", () => {
  assert.deepEqual(
    resolveCodexHomePolicy("app-server", "ws://remote.example/codex", "/managed/writer"),
    { codexHome: null, fixedByRemoteServer: true },
  );
  assert.deepEqual(
    resolveCodexHomePolicy("app-server", null, "/managed/writer"),
    { codexHome: "/managed/writer", fixedByRemoteServer: false },
  );
});

test("runs concurrent sessions with different agent environment homes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-concurrent-agent-home-"));
  const command = writeLauncher(
    root,
    "process.stderr.write(`CODEX_HOME=${process.env.CODEX_HOME || ''}\\n`); process.exit(7);\n",
  );
  const writerHome = path.join(root, "writer");
  const reviewerHome = path.join(root, "reviewer");
  const registry: AgentEnvironmentRegistry = {
    version: 1,
    defaultEnvironment: "writer",
    managedPaths: [root],
    allowedRoots: [root],
    environments: {
      writer: { name: "writer", codexHome: writerHome, managedPath: root, allowedRoots: [root] },
      reviewer: { name: "reviewer", codexHome: reviewerHome, managedPath: root, allowedRoots: [root] },
    },
  };
  const db = createDatabase(":memory:");
  runMigrations(db);
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot);
  const eventStore = new EventStore(db);
  const projectManager = new ProjectManager(db, root, process.cwd());
  const manager = new SessionManager({
    db,
    eventStore,
    projectManager,
    codexCommand: command,
    codexMode: "exec-json",
    agentEnvironmentRegistry: registry,
  });
  const project = projectManager.createProject({ name: "Concurrent Homes", path: projectRoot });
  const writer = manager.createSession({ projectId: project.id, agentEnvironment: "writer" });
  const reviewer = manager.createSession({ projectId: project.id, agentEnvironment: "reviewer" });

  manager.sendMessage(writer.id, "writer job");
  manager.sendMessage(reviewer.id, "reviewer job");
  await Promise.all([waitForFailed(manager, writer.id), waitForFailed(manager, reviewer.id)]);

  const writerError = eventStore.listAll(writer.id).find((event) => event.type === "error");
  const reviewerError = eventStore.listAll(reviewer.id).find((event) => event.type === "error");
  assert.match(String(writerError?.payload.details?.stderr), new RegExp(`CODEX_HOME=${writerHome.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`));
  assert.match(String(reviewerError?.payload.details?.stderr), new RegExp(`CODEX_HOME=${reviewerHome.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`));
});
