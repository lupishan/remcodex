import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexMcpToolPolicyOverrides,
  normalizeCodexExecLaunchInput,
} from "../server/src/utils/codex-launch";
import { CodexExecRunner } from "../server/src/services/codex-exec-runner";

test("MCP tool policies support server and tool selectors", () => {
  const launch = normalizeCodexExecLaunchInput({
    allowedTools: [{ server: "vikunja" }, { server: "rhizomatic_server", tool: "search" }],
    deniedTools: [{ server: "rhizomatic_server", tool: "delete" }],
  });

  assert.deepEqual(buildCodexMcpToolPolicyOverrides(launch && {
    allowedTools: launch.allowedTools,
    deniedTools: launch.deniedTools,
  }), {
    "mcp_servers.vikunja.enabled": true,
    "mcp_servers.rhizomatic_server.tools.search.enabled": true,
    "mcp_servers.rhizomatic_server.tools.delete.enabled": false,
  });
});

test("MCP tool policy preserves default behavior when omitted", () => {
  assert.equal(normalizeCodexExecLaunchInput({}), undefined);
  assert.deepEqual(buildCodexMcpToolPolicyOverrides(undefined), {});
});

test("MCP tool policy rejects malformed, duplicate, and overlapping selectors", () => {
  for (const input of [
    { allowedTools: [{ server: "bad name" }] },
    { allowedTools: [{ server: "server", tool: "bad/name" }] },
    { allowedTools: [{ server: "server" }, { server: "server" }] },
    {
      allowedTools: [{ server: "server" }],
      deniedTools: [{ server: "server", tool: "one" }],
    },
  ]) {
    assert.throws(() => normalizeCodexExecLaunchInput(input), /MCP tool policy|selectors/i);
  }
});

test("MCP tool policy rejects caller-supplied Codex override fields", () => {
  assert.throws(
    () => normalizeCodexExecLaunchInput({ allowedTools: [{ server: "server" }], config: "anything" }),
    /raw Codex configuration|unsupported fields/i,
  );
});

test("exec launch translates only validated MCP policy keys into -c arguments", () => {
  const launch = normalizeCodexExecLaunchInput({
    deniedTools: [{ server: "vikunja", tool: "delete_task" }],
  });
  const args = (new CodexExecRunner("codex", process.cwd()) as unknown as {
    buildExecArgs(prompt: string, threadId: string | null, launch: unknown): string[];
  }).buildExecArgs("hello", null, launch);

  assert.deepEqual(args.slice(0, 6), [
    "exec",
    "--json",
    "-c",
    "mcp_servers.vikunja.tools.delete_task.enabled=false",
    "--skip-git-repo-check",
    "--color",
  ]);
  assert.equal(args.includes("raw.caller.override=true"), false);
});
