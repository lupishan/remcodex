import { homedir } from "node:os";

import type { DatabaseClient } from "../db/client";
import type { AgentProfileRecord } from "../types/models";
import { AppError } from "../utils/errors";
import { createId } from "../utils/ids";

export interface AgentProfileSeed {
  name: string;
  startingPrompt: string;
  defaultDirectory: string;
  agentEnvironment?: string;
}

export const DEFAULT_ORCHESTRATOR_PROFILE = {
  name: "orchestrator",
  starting_prompt:
    "Manage delegated Codex work by reusing an existing session in the requested directory or starting a fresh session there when none exists.",
  default_directory: `${homedir()}/programming`,
  agent_environment: null,
};

export interface AgentProfileManagerOptions {
  initialProfiles?: AgentProfileSeed[];
}

export class AgentProfileManager {
  constructor(private readonly db: DatabaseClient, options: AgentProfileManagerOptions = {}) {
    this.seedProfiles(options.initialProfiles ?? []);
    this.ensureDefaultProfile();
  }

  listProfiles(): AgentProfileRecord[] {
    return this.db
      .prepare(
        `
          SELECT id, name, starting_prompt, default_directory, agent_environment, created_at, updated_at
          FROM agent_profiles
          ORDER BY name COLLATE NOCASE
        `,
      )
      .all() as AgentProfileRecord[];
  }

  getProfile(idOrName: string): AgentProfileRecord | null {
    return (
      (this.db
        .prepare(
          `
            SELECT id, name, starting_prompt, default_directory, agent_environment, created_at, updated_at
            FROM agent_profiles
            WHERE id = ? OR name = ?
          `,
        )
        .get(idOrName, idOrName) as AgentProfileRecord | undefined) ?? null
    );
  }

  createProfile(input: {
    name: string;
    startingPrompt: string;
    defaultDirectory: string;
    agentEnvironment?: string | null;
  }): AgentProfileRecord {
    return this.persistProfile(input, "create");
  }

  private seedProfiles(profiles: AgentProfileSeed[]): void {
    profiles.forEach((profile) => {
      this.persistProfile(profile, "upsert");
    });
  }

  private persistProfile(
    input: {
      name: string;
      startingPrompt: string;
      defaultDirectory: string;
      agentEnvironment?: string | null;
    },
    mode: "create" | "upsert",
  ): AgentProfileRecord {
    const name = input.name.trim();
    const startingPrompt = input.startingPrompt.trim();
    const defaultDirectory = input.defaultDirectory.trim();
    const agentEnvironment = input.agentEnvironment?.trim() || null;

    if (!name || !startingPrompt || !defaultDirectory) {
      throw new AppError(400, "Profile name, starting prompt, and default directory are required.");
    }

    const existing = this.getProfile(name);
    const timestamp = new Date().toISOString();
    const profile: AgentProfileRecord = existing
      ? {
          ...existing,
          name,
          starting_prompt: startingPrompt,
          default_directory: defaultDirectory,
          agent_environment: agentEnvironment,
          updated_at: timestamp,
        }
      : {
          id: createId("profile"),
          name,
          starting_prompt: startingPrompt,
          default_directory: defaultDirectory,
          agent_environment: agentEnvironment,
          created_at: timestamp,
          updated_at: timestamp,
        };

    try {
      if (existing) {
        if (mode === "create") {
          throw new AppError(409, "An agent profile with that name already exists.");
        }

        this.db
          .prepare(
            `
              UPDATE agent_profiles
              SET starting_prompt = ?, default_directory = ?, agent_environment = ?, updated_at = ?
              WHERE id = ?
            `,
          )
          .run(profile.starting_prompt, profile.default_directory, profile.agent_environment, profile.updated_at, profile.id);
      } else {
        this.db
          .prepare(
            `
              INSERT INTO agent_profiles
                (id, name, starting_prompt, default_directory, agent_environment, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            profile.id,
            profile.name,
            profile.starting_prompt,
            profile.default_directory,
            profile.agent_environment,
            profile.created_at,
            profile.updated_at,
          );
      }
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: agent_profiles.name")) {
        throw new AppError(409, "An agent profile with that name already exists.");
      }
      throw error;
    }

    return profile;
  }

  private ensureDefaultProfile(): void {
    const existing = this.getProfile(DEFAULT_ORCHESTRATOR_PROFILE.name);
    if (existing) {
      return;
    }

    this.createProfile({
      name: DEFAULT_ORCHESTRATOR_PROFILE.name,
      startingPrompt: DEFAULT_ORCHESTRATOR_PROFILE.starting_prompt,
      defaultDirectory: DEFAULT_ORCHESTRATOR_PROFILE.default_directory,
      agentEnvironment: DEFAULT_ORCHESTRATOR_PROFILE.agent_environment,
    });
  }
}
