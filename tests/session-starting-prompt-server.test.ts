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
import { composeMessageContentWithStartingPrompt } from "../server/src/utils/session-starting-prompt";

test("server stores and composes session starting prompts", () => {
  assert.equal(
    composeMessageContentWithStartingPrompt(
      "Inspect the current session state.",
      "Use RemCodex to keep the workspace in view.",
    ),
    "Use RemCodex to keep the workspace in view.\n\nInspect the current session state.",
  );

  const db = createDatabase(":memory:");
  runMigrations(db);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-starting-prompt-"));
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
    name: "Prompt Project",
    path: projectPath,
  });
  const session = manager.createSession({
    projectId: project.id,
    startingPrompt: "Use the profile prompt.",
  });

  assert.equal(session.starting_prompt, "Use the profile prompt.");
  assert.equal(manager.getSession(session.id)?.starting_prompt, "Use the profile prompt.");
  assert.equal(manager.listSessions()[0]?.starting_prompt, "Use the profile prompt.");
});
