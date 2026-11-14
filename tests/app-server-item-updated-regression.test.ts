import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDatabase } from "../server/src/db/client";
import { runMigrations } from "../server/src/db/migrations";
import { EventStore } from "../server/src/services/event-store";
import { ProjectManager } from "../server/src/services/project-manager";
import { SessionManager } from "../server/src/services/session-manager";

function makeRuntime(turnId: string) {
  return {
    runner: {
      isAlive() {
        return true;
      },
    },
    cwd: "/tmp/remcodex-test",
    command: "codex",
    stderr: "",
    stderrTruncated: false,
    stopRequested: false,
    transientSeqCursor: 0,
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
}

test("item/updated agent messages persist assistant deltas", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-test-"));
  const projectPath = path.join(tmpRoot, "project");
  fs.mkdirSync(projectPath, { recursive: true });

  const eventStore = new EventStore(db);
  const projectManager = new ProjectManager(db, tmpRoot, process.cwd());
  const manager = new SessionManager({
    db,
    eventStore,
    projectManager,
    codexCommand: "codex",
    codexMode: "app-server",
  });

  const project = projectManager.createProject({
    name: "Regression Project",
    path: projectPath,
  });
  const session = manager.createSession({
    projectId: project.id,
    title: "Regression Session",
  });
  const runtime = makeRuntime("turn-local-1");

  manager["handleAppServerMessage"](session.id, runtime, {
    method: "item/updated",
    params: {
      turnId: "turn-remote-1",
      item: {
        id: "msg-1",
        type: "agentMessage",
        phase: "final_answer",
        content: [{ type: "text", text: "assistant from item updated" }],
      },
    },
  });

  const events = eventStore.listAll(session.id);
  const assistantDelta = events.find((event) => event.type === "message.assistant.delta");
  assert.ok(assistantDelta, "expected an assistant delta event");
  assert.equal(assistantDelta?.payload?.textDelta, "assistant from item updated");
});

test("item/updated reasoning messages persist reasoning deltas", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-test-"));
  const projectPath = path.join(tmpRoot, "project");
  fs.mkdirSync(projectPath, { recursive: true });

  const eventStore = new EventStore(db);
  const projectManager = new ProjectManager(db, tmpRoot, process.cwd());
  const manager = new SessionManager({
    db,
    eventStore,
    projectManager,
    codexCommand: "codex",
    codexMode: "app-server",
  });

  const project = projectManager.createProject({
    name: "Regression Project",
    path: projectPath,
  });
  const session = manager.createSession({
    projectId: project.id,
    title: "Regression Session",
  });
  const runtime = makeRuntime("turn-local-2");

  manager["handleAppServerMessage"](session.id, runtime, {
    method: "item/updated",
    params: {
      turnId: "turn-remote-2",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        summary: "reasoning summary from item updated",
      },
    },
  });

  const events = eventStore.listAll(session.id);
  const reasoningDelta = events.find((event) => event.type === "reasoning.delta");
  assert.ok(reasoningDelta, "expected a reasoning delta event");
  assert.equal(reasoningDelta?.payload?.textDelta, "reasoning summary from item updated");
});
