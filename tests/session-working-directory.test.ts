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

function makeManagers() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-working-directory-"));
  const projectManager = new ProjectManager(db, root, process.cwd());
  const sessionManager = new SessionManager({
    db,
    eventStore: new EventStore(db),
    projectManager,
    codexCommand: "codex",
    codexMode: "app-server",
  });
  return { db, projectManager, root, sessionManager };
}

test("finds the reusable session for a canonicalized working directory", () => {
  const { db, projectManager, root, sessionManager } = makeManagers();
  const projectPath = path.join(root, "workspace");
  fs.mkdirSync(projectPath);
  const project = projectManager.getOrCreateProjectByPath(`${projectPath}/`, "Workspace");
  const session = sessionManager.createSession({ projectId: project.id, title: "Existing session" });

  assert.equal(
    sessionManager.findSessionByProjectPath(path.join(projectPath, "."))?.id,
    session.id,
  );

  db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(session.id);
  assert.equal(sessionManager.findSessionByProjectPath(projectPath), null);
});

test("registers an untracked working directory as a project", () => {
  const { projectManager, root } = makeManagers();
  const projectPath = path.join(root, "new-workspace");
  fs.mkdirSync(projectPath);

  const project = projectManager.getOrCreateProjectByPath(projectPath);

  assert.equal(project.name, "new-workspace");
  assert.equal(project.path, projectPath);
  assert.equal(projectManager.getProjectByPath(`${projectPath}/.`)?.id, project.id);
});

test("lists every session previously started in a working directory", () => {
  const { projectManager, root, sessionManager } = makeManagers();
  const projectPath = path.join(root, "workspace");
  fs.mkdirSync(projectPath);
  const project = projectManager.getOrCreateProjectByPath(projectPath);
  const first = sessionManager.createSession({ projectId: project.id, title: "First session" });
  const second = sessionManager.createSession({ projectId: project.id, title: "Second session" });

  const sessions = sessionManager.listSessionsByProjectPath(path.join(projectPath, "."));
  assert.equal(sessions.length, 2);
  assert.deepEqual(new Set(sessions.map((session) => session.id)), new Set([first.id, second.id]));
  assert.deepEqual(sessionManager.listSessionsByProjectPath(path.join(root, "missing")), []);
});

test("resumes a terminal session and optionally assigns a same-project parent", () => {
  const { db, projectManager, root, sessionManager } = makeManagers();
  const projectPath = path.join(root, "workspace");
  fs.mkdirSync(projectPath);
  const project = projectManager.getOrCreateProjectByPath(projectPath);
  const parent = sessionManager.createSession({ projectId: project.id, title: "Parent" });
  const session = sessionManager.createSession({ projectId: project.id, title: "Resumable" });
  db.prepare("UPDATE sessions SET status = 'failed' WHERE id = ?").run(session.id);

  const resumed = sessionManager.resumeSession(session.id, parent.id);

  assert.equal(resumed.status, "idle");
  assert.equal(resumed.parent_session_id, parent.id);
});

test("rejects a parent from another project when resuming", () => {
  const { projectManager, root, sessionManager } = makeManagers();
  const firstPath = path.join(root, "first");
  const secondPath = path.join(root, "second");
  fs.mkdirSync(firstPath);
  fs.mkdirSync(secondPath);
  const first = projectManager.getOrCreateProjectByPath(firstPath);
  const second = projectManager.getOrCreateProjectByPath(secondPath);
  const session = sessionManager.createSession({ projectId: first.id });
  const parent = sessionManager.createSession({ projectId: second.id });

  assert.throws(
    () => sessionManager.resumeSession(session.id, parent.id),
    /Parent session directory must be an ancestor/,
  );
});

test("allows parent sessions only along ancestor directory paths", () => {
  const { projectManager, root, sessionManager } = makeManagers();
  const programmingPath = path.join(root, "programming");
  const agenticPath = path.join(programmingPath, "by_category", "agentic");
  const remcodexPath = path.join(agenticPath, "remcodex");
  const productivityPath = path.join(programmingPath, "by_category", "productivity");
  for (const directory of [agenticPath, remcodexPath, productivityPath]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const programming = projectManager.getOrCreateProjectByPath(programmingPath);
  const agentic = projectManager.getOrCreateProjectByPath(agenticPath);
  const remcodex = projectManager.getOrCreateProjectByPath(remcodexPath);
  const productivity = projectManager.getOrCreateProjectByPath(productivityPath);
  const programmingSession = sessionManager.createSession({ projectId: programming.id });
  const agenticSession = sessionManager.createSession({
    projectId: agentic.id,
    parentSessionId: programmingSession.id,
  });

  const remcodexSession = sessionManager.createSession({
    projectId: remcodex.id,
    parentSessionId: agenticSession.id,
  });
  assert.equal(remcodexSession.parent_session_id, agenticSession.id);

  const productivitySession = sessionManager.createSession({ projectId: productivity.id });
  assert.throws(
    () => sessionManager.createSession({ projectId: agentic.id, parentSessionId: productivitySession.id }),
    /Parent session directory must be an ancestor/,
  );
});

test("stores and updates session descriptions, tags, and metadata", () => {
  const { projectManager, root, sessionManager } = makeManagers();
  const projectPath = path.join(root, "workspace");
  fs.mkdirSync(projectPath);
  const project = projectManager.getOrCreateProjectByPath(projectPath);

  const session = sessionManager.createSession({
    projectId: project.id,
    description: "Initial session context",
    tags: [" agentic ", "remcodex", "agentic"],
    metadata: { owner: "orchestrator", priority: 2 },
  });

  assert.equal(session.description, "Initial session context");
  assert.deepEqual(session.tags, ["agentic", "remcodex"]);
  assert.deepEqual(session.metadata, { owner: "orchestrator", priority: 2 });

  const updated = sessionManager.updateSessionMetadata({
    sessionId: session.id,
    description: null,
    tags: ["follow-up"],
    metadata: { owner: "worker", priority: 3 },
  });
  assert.equal(updated.description, null);
  assert.deepEqual(updated.tags, ["follow-up"]);
  assert.deepEqual(updated.metadata, { owner: "worker", priority: 3 });

  const descriptionOnly = sessionManager.updateSessionMetadata({
    sessionId: session.id,
    description: "Updated context",
  });
  assert.equal(descriptionOnly.description, "Updated context");
  assert.deepEqual(descriptionOnly.tags, ["follow-up"]);
  assert.deepEqual(descriptionOnly.metadata, { owner: "worker", priority: 3 });
});
