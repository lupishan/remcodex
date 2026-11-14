import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { CodexRemoteAppServerRunner, REMOTE_APPROVAL_POLICY, REMOTE_SANDBOX_MODE } from "../server/src/services/codex-remote-app-server-runner";

test("remote control preserves sandbox, routes approvals, and ignores unrelated threads", async () => {
  assert.equal(REMOTE_APPROVAL_POLICY, "on-request");
  assert.equal(REMOTE_SANDBOX_MODE, "workspace-write");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const requests: any[] = [], events: any[] = [];
  let approval: any;
  server.on("connection", ws => ws.on("message", data => {
    const m = JSON.parse(data.toString()); requests.push(m);
    if (m.id === 900) { approval = m; return; }
    if (!m.id) return;
    const result = m.method === "thread/resume" ? { thread: { id: "a" } } : m.method === "turn/start" ? { turn: { id: "t" } } : {};
    ws.send(JSON.stringify({ id: m.id, result }));
    if (m.method === "turn/start") {
      ws.send(JSON.stringify({ method: "turn/started", params: { threadId: "a", turn: { id: "t" } } }));
      ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: "b", turn: { id: "other", status: "completed" } } }));
      ws.send(JSON.stringify({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: "a", turnId: "t" } }));
      setTimeout(() => ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: "a", turn: { id: "t", status: "completed" } } })), 30);
    }
  }));
  const runner = new CodexRemoteAppServerRunner(`ws://127.0.0.1:${(server.address() as { port: number }).port}`, "/tmp");
  runner.onJsonEvent((e: any) => { events.push(e); if (e.id === 900) runner.respond(900, { decision: "accept" }); });
  try {
    const exited = new Promise<number | null>(resolve => runner.onExit(resolve));
    runner.start("hello", "a", { sandbox: "read-only" });
    assert.equal(await exited, 0);
    assert.equal(requests.find(m => m.method === "thread/resume").params.sandbox, "read-only");
    assert.equal(requests.find(m => m.method === "turn/start").params.approvalPolicy, "on-request");
    assert.equal(requests.some(m => m.method === "mcpServerStatus/list"), false);
    assert.ok(approval?.result);
    assert.equal(events.some(m => m.params?.threadId === "b"), false);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("unexpected remote disconnect fails the run", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  server.on("connection", ws => ws.close());
  const runner = new CodexRemoteAppServerRunner(`ws://127.0.0.1:${(server.address() as { port: number }).port}`, "/tmp");
  const exited = new Promise<number | null>(resolve => runner.onExit(resolve));
  runner.start("hello", "a");
  assert.equal(await exited, 1);
  await new Promise<void>(resolve => server.close(() => resolve()));
});
