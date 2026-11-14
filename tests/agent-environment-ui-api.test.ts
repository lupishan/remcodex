import assert from "node:assert/strict";
import test from "node:test";

import { createSession, getAgentEnvironments } from "../web/api.js";

test("browser API exposes environment discovery and forwards the selected environment", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(
      String(input) === "/api/agent-environments"
        ? { defaultEnvironment: "writer", items: [{ name: "writer" }] }
        : { sessionId: "session-1", agentEnvironment: "writer" },
    ), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    assert.deepEqual(await getAgentEnvironments(), {
      defaultEnvironment: "writer",
      items: [{ name: "writer" }],
    });
    await createSession({ projectId: "project-1", agentEnvironment: "writer" });
    assert.equal(requests[1]?.url, "/api/sessions");
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      projectId: "project-1",
      agentEnvironment: "writer",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
