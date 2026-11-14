import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/src/db/client";
import { runMigrations } from "../server/src/db/migrations";
import {
  AgentProfileManager,
  DEFAULT_ORCHESTRATOR_PROFILE,
} from "../server/src/services/agent-profile-manager";
import { loadRemCodexConfig } from "../server/src/utils/remcodex-config";

test("remcodex config loads startup profiles from TOML", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-config-"));
  const configPath = path.join(tmpRoot, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      "# sample config",
      "",
      "[[profiles]]",
      `name = "remcodex-demo"`,
      `starting_prompt = "Use RemCodex to inspect the current session."`,
      `default_directory = "/home/evak/programming/by_category/agentic/remcodex"`,
      `agent_environment = "remcodex"`,
      "",
      "[[profiles]]",
      `name = 'remcodex-review'`,
      `starting_prompt = 'Review the current RemCodex worktree.'`,
      `default_directory = '/home/evak/programming/by_category/agentic/remcodex'`,
      "",
    ].join("\n"),
    "utf8",
  );

  const config = loadRemCodexConfig(configPath);

  assert.deepEqual(config.profiles, [
    {
      name: "remcodex-demo",
      startingPrompt: "Use RemCodex to inspect the current session.",
      defaultDirectory: "/home/evak/programming/by_category/agentic/remcodex",
      agentEnvironment: "remcodex",
    },
    {
      name: "remcodex-review",
      startingPrompt: "Review the current RemCodex worktree.",
      defaultDirectory: "/home/evak/programming/by_category/agentic/remcodex",
    },
  ]);
});

test("profile manager seeds configured profiles on startup", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const manager = new AgentProfileManager(db, {
    initialProfiles: [
      {
        name: DEFAULT_ORCHESTRATOR_PROFILE.name,
        startingPrompt: "Custom orchestrator prompt.",
        defaultDirectory: "/home/evak/programming/custom",
      },
      {
        name: "remcodex-demo",
        startingPrompt: "Demo prompt.",
        defaultDirectory: "/home/evak/programming/by_category/agentic/remcodex",
        agentEnvironment: "remcodex",
      },
    ],
  });

  const profiles = manager.listProfiles();
  assert.equal(profiles.length, 2);
  assert.deepEqual(
    profiles.map((profile) => ({
      name: profile.name,
      starting_prompt: profile.starting_prompt,
      default_directory: profile.default_directory,
      agent_environment: profile.agent_environment,
    })),
    [
      {
        name: "orchestrator",
        starting_prompt: "Custom orchestrator prompt.",
        default_directory: "/home/evak/programming/custom",
        agent_environment: null,
      },
      {
        name: "remcodex-demo",
        starting_prompt: "Demo prompt.",
        default_directory: "/home/evak/programming/by_category/agentic/remcodex",
        agent_environment: "remcodex",
      },
    ],
  );
});
