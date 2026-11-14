import { existsSync, readFileSync } from "node:fs";

import type { AgentProfileSeed } from "../services/agent-profile-manager";

export interface RemCodexConfig {
  profiles: AgentProfileSeed[];
}

function stripInlineComment(line: string): string {
  let inDoubleQuotes = false;
  let inSingleQuotes = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      continue;
    }

    if (char === "#" && !inDoubleQuotes && !inSingleQuotes) {
      return line.slice(0, index).trimEnd();
    }
  }

  return line.trimEnd();
}

function unescapeTomlBasicString(value: string): string {
  let out = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      out += char;
      continue;
    }

    index += 1;
    const next = value[index];
    if (next === undefined) {
      throw new Error("Invalid TOML escape at end of string.");
    }

    switch (next) {
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      default:
        out += next;
        break;
    }
  }

  return out;
}

function parseTomlString(rawValue: string, lineNumber: number): string {
  const value = rawValue.trim();
  if (!value) {
    return "";
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    return unescapeTomlBasicString(value.slice(1, -1));
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  throw new Error(`Line ${lineNumber}: expected a quoted TOML string.`);
}

function finalizeProfile(
  profile: Partial<AgentProfileSeed> | null,
  lineNumber: number,
): AgentProfileSeed | null {
  if (!profile) {
    return null;
  }

  const name = String(profile.name || "").trim();
  const startingPrompt = String(profile.startingPrompt || "").trim();
  const defaultDirectory = String(profile.defaultDirectory || "").trim();
  const agentEnvironment = String(profile.agentEnvironment || "").trim();
  if (!name && !startingPrompt && !defaultDirectory) {
    return null;
  }

  if (!name || !startingPrompt || !defaultDirectory) {
    throw new Error(
      `Line ${lineNumber}: each [[profiles]] entry needs name, starting_prompt, and default_directory.`,
    );
  }

  return {
    name,
    startingPrompt,
    defaultDirectory,
    ...(agentEnvironment ? { agentEnvironment } : {}),
  };
}

export function loadRemCodexConfig(configPath: string): RemCodexConfig {
  if (!existsSync(configPath)) {
    return { profiles: [] };
  }

  const raw = readFileSync(configPath, "utf8");
  const profiles: AgentProfileSeed[] = [];
  let currentProfile: Partial<AgentProfileSeed> | null = null;
  let currentLineNumber = 0;

  const commitCurrent = (lineNumber: number) => {
    const profile = finalizeProfile(currentProfile, lineNumber);
    if (profile) {
      profiles.push(profile);
    }
    currentProfile = null;
    currentLineNumber = 0;
  };

  raw.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = stripInlineComment(line).trim();
    if (!trimmed) {
      return;
    }

    if (trimmed === "[[profiles]]") {
      commitCurrent(currentLineNumber || lineNumber);
      currentProfile = {};
      currentLineNumber = lineNumber;
      return;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!match) {
      throw new Error(`Line ${lineNumber}: only [[profiles]] tables and key/value pairs are supported.`);
    }

    if (!currentProfile) {
      throw new Error(`Line ${lineNumber}: profile fields must appear inside a [[profiles]] table.`);
    }

    const key = match[1];
    const value = parseTomlString(match[2], lineNumber);
    if (key === "name") {
      currentProfile.name = value;
    } else if (key === "starting_prompt") {
      currentProfile.startingPrompt = value;
    } else if (key === "default_directory") {
      currentProfile.defaultDirectory = value;
    } else if (key === "agent_environment") {
      currentProfile.agentEnvironment = value;
    }
  });

  commitCurrent(currentLineNumber || raw.split(/\r?\n/).length);

  const deduped = new Map<string, AgentProfileSeed>();
  for (const profile of profiles) {
    deduped.set(profile.name, profile);
  }

  return { profiles: [...deduped.values()] };
}
