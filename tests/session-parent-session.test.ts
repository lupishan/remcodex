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

test("sessions can reference a parent session within the same project", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-parent-session-"));
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
    name: "Parent Project",
    path: projectPath,
  });
  const parent = manager.createSession({
    projectId: project.id,
    title: "Parent Session",
  });
  const child = manager.createSession({
    projectId: project.id,
    title: "Child Session",
    parentSessionId: parent.id,
  });

  assert.equal(child.parent_session_id, parent.id);
  assert.equal(manager.getSession(child.id)?.parent_session_id, parent.id);
  assert.equal(manager.listSessions().find((session) => session.id === child.id)?.parent_session_id, parent.id);
  assert.throws(
    () =>
      manager.createSession({
        projectId: project.id,
        parentSessionId: "missing-parent",
      }),
    /Parent session not found/,
  );
});
