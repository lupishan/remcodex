import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CodexExecLaunchInput } from "../types/codex-launch";

export interface CodexUiModelOption {
  id: string;
  label: string;
}

export interface CodexUiReasoningOption {
  id: string;
  label: string;
  /** Subset of launch flags the UI may apply. */
  launch: Pick<CodexExecLaunchInput, "reasoningEffort">;
}

export interface CodexUiOptionsResponse {
  models: CodexUiModelOption[];
  reasoningLevels: CodexUiReasoningOption[];
}

interface RawCodexModelCacheEntry {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

interface RawCodexModelCache {
  models?: unknown;
}

const DEFAULT_OPTIONS: CodexUiOptionsResponse = {
  models: [
    { id: "gpt-5.4", label: "gpt-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { id: "gpt-5.2-codex", label: "gpt-5.2-codex" },
    { id: "gpt-5.2", label: "gpt-5.2" },
    { id: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
    { id: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
  ],
  reasoningLevels: [
    { id: "low", label: "Low", launch: { reasoningEffort: "low" } },
    { id: "medium", label: "Medium", launch: { reasoningEffort: "medium" } },
    { id: "high", label: "High", launch: { reasoningEffort: "high" } },
    { id: "xhigh", label: "Very high", launch: { reasoningEffort: "xhigh" } },
  ],
};

function resolveCodexHomeDir(): string {
  const override = process.env.CODEX_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.join(os.homedir(), ".codex");
}

function resolveModelsCachePath(): string {
  const override = process.env.CODEX_MODELS_CACHE_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.join(resolveCodexHomeDir(), "models_cache.json");
}

function sanitizeModel(raw: unknown): CodexUiModelOption | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const o = raw as RawCodexModelCacheEntry;
  const id = typeof o.slug === "string" ? o.slug.trim() : "";
  const label = typeof o.display_name === "string" ? o.display_name.trim() : "";
  const visibility = typeof o.visibility === "string" ? o.visibility.trim() : "";

  if (!id || !label || id.length > 96 || label.length > 120) {
    return null;
  }

  if (!/^[\w.+-]+$/i.test(id)) {
    return null;
  }

  if (visibility && visibility !== "list" && visibility !== "hide") {
    return null;
  }

  if (visibility !== "list") {
    return null;
  }

  return { id, label };
}

function parseModelsCache(raw: string): CodexUiOptionsResponse | null {
  try {
    const parsed = JSON.parse(raw) as RawCodexModelCache;
    const modelsIn = Array.isArray(parsed.models) ? parsed.models : [];
    const models = modelsIn.map(sanitizeModel).filter(Boolean) as CodexUiModelOption[];
    if (models.length === 0) {
      return null;
    }

    const seen = new Set<string>();
    const deduped = models.filter((model) => {
      if (seen.has(model.id)) {
        return false;
      }
      seen.add(model.id);
      return true;
    });

    return {
      models: deduped,
      reasoningLevels: DEFAULT_OPTIONS.reasoningLevels,
    };
  } catch {
    return null;
  }
}

/**
 * CODEX_UI_OPTIONS_JSON: full JSON { models, reasoningLevels }.
 * CODEX_MODELS_CACHE_PATH: optional override for ~/.codex/models_cache.json.
 * Falls back to DEFAULT_OPTIONS when unset or invalid.
 */
export function resolveCodexUiOptions(): CodexUiOptionsResponse {
  const fromEnv = process.env.CODEX_UI_OPTIONS_JSON?.trim();
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv) as CodexUiOptionsResponse;
      if (Array.isArray(parsed.models) && parsed.models.length > 0 && Array.isArray(parsed.reasoningLevels)) {
        return parsed;
      }
    } catch {
      /* ignore */
    }
  }

  const modelsCachePath = resolveModelsCachePath();
  if (existsSync(modelsCachePath)) {
    const parsed = parseModelsCache(readFileSync(modelsCachePath, "utf8"));
    if (parsed) {
      return parsed;
    }
  }

  return DEFAULT_OPTIONS;
}
