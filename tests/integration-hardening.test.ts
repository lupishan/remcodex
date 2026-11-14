import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startRemCodexServer } from "../server/src/app";
import { createDatabase } from "../server/src/db/client";
import { runMigrations } from "../server/src/db/migrations";
import { EventStore } from "../server/src/services/event-store";
import { ProjectManager } from "../server/src/services/project-manager";
import { SessionManager } from "../server/src/services/session-manager";
import { PeerCommunicationService } from "../server/src/services/peer-communication";
import { buildCodexChildEnvironment } from "../server/src/services/codex-runner";
import { parseRemCodexRemoteInstances } from "../server/src/utils/remcodex-remote-instances";

test("control authentication protects REST/WS and rejects foreign origins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-auth-"));
  const previous = process.env.REMCODEX_API_TOKEN;
  process.env.REMCODEX_API_TOKEN = "test-control-secret";
  const server = await startRemCodexServer({ port: 0, databasePath: path.join(root, "db"), configPath: path.join(root, "none"), projectRootsEnv: root, logStartup: false });
  const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);
    assert.equal((await fetch(base)).status, 401);
    const login = await fetch(`${base}/auth/session`, { method: "POST", headers: { authorization: "Bearer test-control-secret" } });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/projects`, { headers: { cookie, origin: "https://evil.example" } })).status, 401);
    const project: any = await (await fetch(`${base}/api/projects`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "test", path: root }) })).json();
    const session: any = await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ projectId: project.projectId }) })).json();
    const url = base.replace("http:", "ws:") + `/ws/sessions/${session.sessionId}`;
    const rejected = new WebSocket(url, { headers: { cookie }, origin: "https://evil.example" });
    await new Promise<void>((resolve, reject) => { rejected.on("error", () => resolve()); rejected.on("open", () => { rejected.terminate(); reject(new Error("Untrusted socket opened")); }); });
    const ws = new WebSocket(url, { headers: { cookie }, origin: base });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.close(); await new Promise<void>(resolve => ws.once("close", () => resolve()));
  } finally {
    await server.stop();
    if (previous === undefined) delete process.env.REMCODEX_API_TOKEN; else process.env.REMCODEX_API_TOKEN = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sessions reject cycles and respect environment during reuse", () => {
  const db = createDatabase(":memory:"); runMigrations(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-tree-"));
  try {
    const projects = new ProjectManager(db, root, root);
    const project = projects.createProject({ name: "test", path: root });
    const manager = new SessionManager({ db, eventStore: new EventStore(db), projectManager: projects, codexCommand: "codex", codexMode: "app-server" });
    const a = manager.createSession({ projectId: project.id });
    const b = manager.createSession({ projectId: project.id, parentSessionId: a.id });
    assert.throws(() => manager.resumeSession(a.id, b.id), /cycle/);
    assert.equal(manager.findSessionByProjectPath(root, "reviewer"), null);
    assert.ok(manager.findSessionByProjectPath(root, null));
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("administrator rotation and disabling revoke old credentials", () => {
  const db = createDatabase(":memory:"); runMigrations(db);
  try {
    new PeerCommunicationService(db, undefined, "old-secret");
    const rotated = new PeerCommunicationService(db, undefined, "new-secret");
    assert.throws(() => rotated.authenticate("old-secret"), /inactive/);
    assert.ok(rotated.authenticate("new-secret"));
    const disabled = new PeerCommunicationService(db);
    assert.throws(() => disabled.authenticate("new-secret"), /inactive/);
  } finally { db.close(); }
});

test("configured remote credentials never enter worker environments", () => {
  const previous = process.env.REMCODEX_REMOTE_INSTANCES;
  process.env.REMCODEX_REMOTE_INSTANCES = JSON.stringify([{ credentialRef: "TEST_REMOTE_SECRET" }]);
  process.env.TEST_REMOTE_SECRET = "private-remote-token";
  try { assert.equal(buildCodexChildEnvironment(null, "worker").TEST_REMOTE_SECRET, undefined); }
  finally { delete process.env.TEST_REMOTE_SECRET; if (previous === undefined) delete process.env.REMCODEX_REMOTE_INSTANCES; else process.env.REMCODEX_REMOTE_INSTANCES = previous; }
});

test("private IPv6 remote targets are rejected", () => {
  for (const url of ["https://[::1]", "https://[fd00::1]"]) {
    assert.throws(() => parseRemCodexRemoteInstances(JSON.stringify([{ name: "test", url, credentialRef: "TOKEN" }])), /private/);
  }
});
