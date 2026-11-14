import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRemCodexServer } from "../server/src/app";

function writeRegistry(root: string): string {
  const registryPath = path.join(root, "agent-environments.json");
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      default: "writer",
      managed_paths: [root],
      allowed_roots: [root],
      environments: {
        writer: { codex_home: path.join(root, "writer"), managed_path: root },
        reviewer: { codex_home: path.join(root, "reviewer"), managed_path: root },
      },
    }),
    "utf8",
  );
  return registryPath;
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

test("REST exposes registered environments and preserves profile/session precedence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-agent-api-"));
  const previousRegistryPath = process.env.CODEX_AGENT_ENVIRONMENTS_PATH;
  process.env.CODEX_AGENT_ENVIRONMENTS_PATH = writeRegistry(root);
  const server = await startRemCodexServer({
    port: 0,
    databasePath: path.join(root, "remcodex.sqlite"),
    configPath: path.join(root, "missing.toml"),
    projectRootsEnv: root,
    codexCommand: "codex",
    logStartup: false,
  });

  try {
    const address = server.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const environments = await json(await fetch(`${baseUrl}/api/agent-environments`));
    assert.equal(environments.defaultEnvironment, "writer");
    assert.deepEqual(
      environments.items.map((item) => item.name),
      ["writer", "reviewer"],
    );
    assert.equal(environments.items[0].codexHome, undefined);
    assert.equal(environments.items[0].managedPath, root);

    const project = await json(await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Agent API", path: root, createMissing: true }),
    }));
    const profile = await json(await fetch(`${baseUrl}/api/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "reviewer-profile",
        startingPrompt: "Review the session.",
        defaultDirectory: root,
        agentEnvironment: "reviewer",
      }),
    }));
    assert.equal(profile.agent_environment, "reviewer");

    const created = await json(await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.projectId, profile: "reviewer-profile" }),
    }));
    assert.equal(created.agentEnvironment, "reviewer");

    const overridden = await json(await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.projectId,
        profile: "reviewer-profile",
        agentEnvironment: "writer",
      }),
    }));
    assert.equal(overridden.agentEnvironment, "writer");
    const detail = await json(await fetch(`${baseUrl}/api/sessions/${overridden.sessionId}`));
    assert.equal(detail.agentEnvironment, "writer");

    const invalid = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.projectId, agentEnvironment: "../secret" }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await json(invalid)).error, /registered name|agent environment/i);
  } finally {
    await server.stop();
    if (previousRegistryPath === undefined) {
      delete process.env.CODEX_AGENT_ENVIRONMENTS_PATH;
    } else {
      process.env.CODEX_AGENT_ENVIRONMENTS_PATH = previousRegistryPath;
    }
  }
});

test("MCP create-session accepts a profile and explicit environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-agent-mcp-"));
  const previousRegistryPath = process.env.CODEX_AGENT_ENVIRONMENTS_PATH;
  const previousToken = process.env.REMCODEX_MCP_API_TOKEN;
  process.env.CODEX_AGENT_ENVIRONMENTS_PATH = writeRegistry(root);
  process.env.REMCODEX_MCP_API_TOKEN = "test-mcp-token";
  const server = await startRemCodexServer({
    port: 0,
    databasePath: path.join(root, "remcodex.sqlite"),
    configPath: path.join(root, "missing.toml"),
    projectRootsEnv: root,
    codexCommand: "codex",
    logStartup: false,
  });

  try {
    const address = server.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const project = await json(await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "MCP Agent API", path: root, createMissing: true }),
    }));
    await fetch(`${baseUrl}/api/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "reviewer-profile",
        startingPrompt: "Review the session.",
        defaultDirectory: root,
        agentEnvironment: "reviewer",
      }),
    });

    const mcpHeaders = {
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-mcp-token",
      "content-type": "application/json",
    };
    const initialize = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const call = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create-session",
          arguments: {
            projectId: project.projectId,
            profile: "reviewer-profile",
            agentEnvironment: "writer",
          },
        },
      }),
    });
    assert.equal(call.status, 200);
    const body = await call.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine, body);
    const result = JSON.parse(dataLine.slice("data: ".length)) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const payload = JSON.parse(result.result?.content?.[0]?.text ?? "{}");
    assert.equal(payload.agentEnvironment, "writer");
    assert.match(payload.sessionUrl, /#\/sessions\//);
  } finally {
    await server.stop();
    if (previousRegistryPath === undefined) {
      delete process.env.CODEX_AGENT_ENVIRONMENTS_PATH;
    } else {
      process.env.CODEX_AGENT_ENVIRONMENTS_PATH = previousRegistryPath;
    }
    if (previousToken === undefined) {
      delete process.env.REMCODEX_MCP_API_TOKEN;
    } else {
      process.env.REMCODEX_MCP_API_TOKEN = previousToken;
    }
  }
});
