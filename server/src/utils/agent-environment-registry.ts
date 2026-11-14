import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const REGISTRY_VERSION = 1;
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export interface AgentEnvironmentDefinition {
  name: string;
  codexHome: string;
  managedPath: string;
  allowedRoots: string[];
}

export interface AgentEnvironmentRegistry {
  version: number;
  defaultEnvironment: string | null;
  managedPaths: string[];
  allowedRoots: string[];
  environments: Record<string, AgentEnvironmentDefinition>;
}

export function defaultAgentEnvironmentRegistryPath(): string {
  return path.join(homedir(), ".config", "codex", "agent-environments.json");
}

function normalizeAbsolutePath(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty absolute path.`);
  }

  const raw = value.trim();
  if (!path.isAbsolute(raw) || raw.split(/[\\/]+/).includes("..")) {
    throw new Error(`${fieldName} must be an absolute path without traversal.`);
  }

  return path.normalize(raw);
}

function normalizePathList(value: unknown, fieldName: string, fallback: string[] = []): string[] {
  if (value == null) {
    return [...fallback];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array of absolute paths.`);
  }

  return [...new Set(value.map((item) => normalizeAbsolutePath(item, fieldName)))];
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeEnvironmentName(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value.trim())) {
    throw new Error(`${fieldName} must be a lowercase environment name.`);
  }
  return value.trim();
}

function asRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function loadAgentEnvironmentRegistry(
  registryPath = defaultAgentEnvironmentRegistryPath(),
): AgentEnvironmentRegistry {
  if (!existsSync(registryPath)) {
    return {
      version: REGISTRY_VERSION,
      defaultEnvironment: null,
      managedPaths: [],
      allowedRoots: [],
      environments: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read agent environment registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const root = asRecord(parsed, "Agent environment registry");
  if (root.version !== REGISTRY_VERSION) {
    throw new Error(`Agent environment registry version must be ${REGISTRY_VERSION}.`);
  }

  const managedPaths = normalizePathList(root.managed_paths ?? root.managedPaths, "managed_paths");
  const allowedRoots = normalizePathList(root.allowed_roots ?? root.allowedRoots, "allowed_roots");
  const environmentsRoot = asRecord(root.environments, "environments");
  const environments: Record<string, AgentEnvironmentDefinition> = {};

  Object.entries(environmentsRoot).forEach(([name, rawEnvironment]) => {
    const normalizedName = normalizeEnvironmentName(name, "environment name");
    const environment = asRecord(rawEnvironment, `environment ${normalizedName}`);
    const codexHome = normalizeAbsolutePath(
      environment.codex_home ?? environment.codexHome,
      `environment ${normalizedName}.codex_home`,
    );
    const environmentManagedPath = environment.managed_path ?? environment.managedPath;
    const managedPath = environmentManagedPath
      ? normalizeAbsolutePath(environmentManagedPath, `environment ${normalizedName}.managed_path`)
      : managedPaths.find((candidate) => isWithin(codexHome, candidate));
    if (!managedPath) {
      throw new Error(`environment ${normalizedName} must identify a managed path.`);
    }

    const environmentAllowedRoots = normalizePathList(
      environment.allowed_roots ?? environment.allowedRoots,
      `environment ${normalizedName}.allowed_roots`,
      allowedRoots,
    );
    if (environmentAllowedRoots.length === 0) {
      throw new Error(`environment ${normalizedName} must identify allowed roots.`);
    }
    if (!isWithin(codexHome, managedPath) || !environmentAllowedRoots.some((rootPath) => isWithin(codexHome, rootPath))) {
      throw new Error(`environment ${normalizedName}.codex_home is outside its managed or allowed roots.`);
    }

    environments[normalizedName] = {
      name: normalizedName,
      codexHome,
      managedPath,
      allowedRoots: environmentAllowedRoots,
    };
  });

  const defaultValue = root.default_environment ?? root.defaultEnvironment ?? root.default ?? null;
  const defaultEnvironment = defaultValue == null ? null : normalizeEnvironmentName(defaultValue, "default environment");
  if (defaultEnvironment && !environments[defaultEnvironment]) {
    throw new Error(`Default agent environment ${defaultEnvironment} is not registered.`);
  }

  return {
    version: REGISTRY_VERSION,
    defaultEnvironment,
    managedPaths,
    allowedRoots,
    environments,
  };
}

export function resolveAgentEnvironment(
  registry: AgentEnvironmentRegistry,
  requestedName?: string | null,
): AgentEnvironmentDefinition | null {
  const normalizedName = requestedName?.trim() || registry.defaultEnvironment;
  if (!normalizedName) {
    return null;
  }
  if (!NAME_PATTERN.test(normalizedName)) {
    throw new Error("Agent environment must be a registered name, not a filesystem path.");
  }

  const environment = registry.environments[normalizedName];
  if (!environment) {
    throw new Error(`Agent environment ${normalizedName} is not registered.`);
  }
  return environment;
}
