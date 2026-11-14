import assert from "node:assert/strict";
import test from "node:test";

import { sessionMatchesSearch } from "../web/utils/session-search.js";

const session = {
  title: "Deploy the RemCodex worker",
  projectId: "project-1",
  status: "running",
  lastAssistantContent: "The deployment is ready for review.",
  lastCommand: "npm run build",
  codexThreadId: "thread-abc",
};

const project = { name: "Programming RemCodex" };

test("session search matches titles and project metadata case-insensitively", () => {
  assert.equal(sessionMatchesSearch(session, project, "deploy"), true);
  assert.equal(sessionMatchesSearch(session, project, "PROGRAMMING REMCODEX"), true);
  assert.equal(sessionMatchesSearch(session, project, "thread-abc"), true);
});

test("session search matches reply and command previews", () => {
  assert.equal(sessionMatchesSearch(session, project, "ready for review"), true);
  assert.equal(sessionMatchesSearch(session, project, "npm run build"), true);
  assert.equal(sessionMatchesSearch(session, project, "not present"), false);
});

test("empty or whitespace-only session searches leave all sessions visible", () => {
  assert.equal(sessionMatchesSearch(session, project, ""), true);
  assert.equal(sessionMatchesSearch(session, project, "   "), true);
});
