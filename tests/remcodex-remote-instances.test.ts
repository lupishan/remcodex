import assert from "node:assert/strict";
import test from "node:test";

import { proxyRemoteMcpCall } from "../server/src/services/remote-mcp-client";
import {
  parseRemCodexRemoteInstances,
  resolveRemCodexRemoteInstance,
} from "../server/src/utils/remcodex-remote-instances";

test("remote instance configuration requires named HTTPS targets and credential references", () => {
  assert.deepEqual(
    parseRemCodexRemoteInstances(JSON.stringify([
      { name: "home", url: "https://remcodex.example/", credentialRef: "REMCODEX_HOME_TOKEN" },
    ])),
    [{ name: "home", url: "https://remcodex.example", credentialRef: "REMCODEX_HOME_TOKEN" }],
  );
  for (const value of [
    { name: "http", url: "http://remcodex.example", credentialRef: "TOKEN" },
    { name: "private", url: "https://127.0.0.1", credentialRef: "TOKEN" },
    { name: "credentials", url: "https://user:pass@example.com", credentialRef: "TOKEN" },
    { name: "missing-credential-ref", url: "https://example.com" },
  ]) {
    assert.throws(() => parseRemCodexRemoteInstances(JSON.stringify([value])), /https|private|credentials|credentialRef/i);
  }
});

test("remote instance resolution rejects unknown or unavailable credentials", () => {
  const instances = parseRemCodexRemoteInstances(
    JSON.stringify([{ name: "home", url: "https://remcodex.example", credentialRef: "HOME_TOKEN" }]),
  );
  assert.throws(() => resolveRemCodexRemoteInstance("other", instances, {}), /Unknown remote instance/);
  assert.throws(() => resolveRemCodexRemoteInstance("home", instances, {}), /credential is unavailable/);
  assert.equal(resolveRemCodexRemoteInstance("home", instances, { HOME_TOKEN: "target-secret" }).authorization, "Bearer target-secret");
});

test("remote MCP routing uses only the selected target credential and strips target metadata", async () => {
  const instances = parseRemCodexRemoteInstances(
    JSON.stringify([{ name: "home", url: "https://remcodex.example", credentialRef: "HOME_TOKEN" }]),
  );
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    if (requests.length === 1) {
      return new Response("", { status: 200, headers: { "mcp-session-id": "remote-session" } });
    }
    if (requests.length === 2) return new Response("", { status: 202 });
    return new Response("data: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"ok\":true}}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const output = { statusCode: 0, headers: new Map<string, string>(), body: "", status(code: number) { this.statusCode = code; return this; }, setHeader(name: string, value: string) { this.headers.set(name, value); return this; }, send(body: string) { this.body = body; return this; } };

  await proxyRemoteMcpCall(
    { id: 9, method: "tools/call", params: { arguments: { instanceName: "home", sessionId: "sensitive-session" } } },
    instances,
    output as never,
    { HOME_TOKEN: "target-secret", REMCODEX_MCP_API_TOKEN: "caller-secret" },
    fetchImpl,
  );

  assert.equal(output.statusCode, 200);
  assert.match(output.body, /"ok":true/);
  assert.equal(requests[2].url, "https://remcodex.example/mcp");
  assert.equal((requests[2].init.headers as Record<string, string>).authorization, "Bearer target-secret");
  assert.equal(JSON.parse(String(requests[2].init.body)).params.arguments.instanceName, undefined);
  assert.equal(JSON.stringify(requests).includes("caller-secret"), false);
});
