import type {
  CodexExecLaunchInput,
  CodexMcpToolPolicy,
  CodexMcpToolSelector,
  CodexSandboxMode,
} from "../types/codex-launch";
import { AppError } from "./errors";

const SANDBOX: Set<CodexSandboxMode> = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const SPEEDS = new Set(["default", "fast", "deep"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const SERVER_SELECTOR = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOOL_SELECTOR = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function sanitizeToken(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const t = value.trim();
  if (!t || t.length > maxLen) {
    return undefined;
  }

  if (!/^[\w.+-]+$/i.test(t)) {
    return undefined;
  }

  return t;
}

function sanitizeProfile(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const t = value.trim();
  if (!t || t.length > 64) {
    return undefined;
  }

  if (!/^[\w-]+$/i.test(t)) {
    return undefined;
  }

  return t;
}

function sanitizeFeatureName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const t = value.trim();
  if (!t || t.length > 64) {
    return undefined;
  }

  if (!/^[a-z][a-z0-9_]*$/i.test(t)) {
    return undefined;
  }

  return t;
}

function parseToolSelector(value: unknown, field: string): CodexMcpToolSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, `${field} selectors must be objects.`);
  }

  const raw = value as Record<string, unknown>;
  const server = typeof raw.server === "string" ? raw.server.trim() : "";
  const tool = raw.tool === undefined ? undefined : typeof raw.tool === "string" ? raw.tool.trim() : "";
  if (!SERVER_SELECTOR.test(server)) {
    throw new AppError(400, `${field} selectors require a valid server name.`);
  }
  if (tool !== undefined && !TOOL_SELECTOR.test(tool)) {
    throw new AppError(400, `${field} selectors require a valid tool name.`);
  }
  if (Object.keys(raw).some((key) => key !== "server" && key !== "tool")) {
    throw new AppError(400, `${field} selectors contain unsupported fields.`);
  }

  return tool === undefined ? { server } : { server, tool };
}

function selectorOverlaps(left: CodexMcpToolSelector, right: CodexMcpToolSelector): boolean {
  return left.server === right.server &&
    (left.tool === undefined || right.tool === undefined || left.tool === right.tool);
}

export function normalizeCodexMcpToolPolicy(raw: unknown): CodexMcpToolPolicy | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "codex.mcpToolPolicy must be an object.");
  }

  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "allowedTools" && key !== "deniedTools")) {
    throw new AppError(400, "codex.mcpToolPolicy contains unsupported fields.");
  }

  const parseList = (key: "allowedTools" | "deniedTools"): CodexMcpToolSelector[] | undefined => {
    if (value[key] === undefined) {
      return undefined;
    }
    if (!Array.isArray(value[key]) || value[key].length > 128) {
      throw new AppError(400, `codex.mcpToolPolicy.${key} must be an array of at most 128 selectors.`);
    }
    const selectors = value[key].map((selector, index) => parseToolSelector(selector, `codex.mcpToolPolicy.${key}[${index}]`));
    const seen = new Set<string>();
    for (const selector of selectors) {
      const selectorKey = `${selector.server}\0${selector.tool ?? "*"}`;
      if (seen.has(selectorKey)) {
        throw new AppError(400, `codex.mcpToolPolicy.${key} contains duplicate selectors.`);
      }
      seen.add(selectorKey);
    }
    return selectors.length > 0 ? selectors : undefined;
  };

  const allowedTools = parseList("allowedTools");
  const deniedTools = parseList("deniedTools");
  for (const allowed of allowedTools ?? []) {
    for (const denied of deniedTools ?? []) {
      if (selectorOverlaps(allowed, denied)) {
        throw new AppError(400, "codex.mcpToolPolicy allow and deny selectors overlap.");
      }
    }
  }

  if (!allowedTools && !deniedTools) {
    return undefined;
  }
  return { ...(allowedTools ? { allowedTools } : {}), ...(deniedTools ? { deniedTools } : {}) };
}

export function buildCodexMcpToolPolicyOverrides(
  policy: CodexMcpToolPolicy | undefined,
): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const [selectors, enabled] of [
    [policy?.allowedTools ?? [], true],
    [policy?.deniedTools ?? [], false],
  ] as const) {
    for (const selector of selectors) {
      const path = selector.tool
        ? `mcp_servers.${selector.server}.tools.${selector.tool}.enabled`
        : `mcp_servers.${selector.server}.enabled`;
      overrides[path] = enabled;
    }
  }
  return overrides;
}

export function normalizeCodexExecLaunchInput(raw: unknown): CodexExecLaunchInput | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const o = raw as Record<string, unknown>;
  if (o.config !== undefined || o.overrides !== undefined || o.codexConfig !== undefined) {
    throw new AppError(400, "Raw Codex configuration overrides are not accepted.");
  }
  const model = sanitizeToken(o.model, 96);
  const profile = sanitizeProfile(o.profile);
  const sandbox =
    typeof o.sandbox === "string" && SANDBOX.has(o.sandbox as CodexSandboxMode)
      ? (o.sandbox as CodexSandboxMode)
      : undefined;
  const speed =
    typeof o.speed === "string" && SPEEDS.has(o.speed) ? (o.speed as "default" | "fast" | "deep") : undefined;
  const reasoningEffort =
    typeof o.reasoningEffort === "string" && REASONING_EFFORTS.has(o.reasoningEffort)
      ? (o.reasoningEffort as "low" | "medium" | "high" | "xhigh")
      : undefined;

  const enableFeatures = Array.isArray(o.enableFeatures)
    ? o.enableFeatures.map(sanitizeFeatureName).filter(Boolean)
    : [];
  const disableFeatures = Array.isArray(o.disableFeatures)
    ? o.disableFeatures.map(sanitizeFeatureName).filter(Boolean)
    : [];
  const mcpToolPolicy = normalizeCodexMcpToolPolicy(
    o.mcpToolPolicy ??
      (o.allowedTools !== undefined || o.deniedTools !== undefined
        ? { allowedTools: o.allowedTools, deniedTools: o.deniedTools }
        : undefined),
  );

  const out: CodexExecLaunchInput = {};
  if (model) {
    out.model = model;
  }

  if (profile) {
    out.profile = profile;
  }

  if (sandbox) {
    out.sandbox = sandbox;
  }

  if (speed && speed !== "default") {
    out.speed = speed;
  }

  if (reasoningEffort) {
    out.reasoningEffort = reasoningEffort;
  }

  if (enableFeatures.length > 0) {
    out.enableFeatures = enableFeatures as string[];
  }

  if (disableFeatures.length > 0) {
    out.disableFeatures = disableFeatures as string[];
  }

  if (mcpToolPolicy) {
    out.allowedTools = mcpToolPolicy.allowedTools;
    out.deniedTools = mcpToolPolicy.deniedTools;
  }

  if (
    !out.model &&
    !out.profile &&
    !out.sandbox &&
    !out.speed &&
    !out.reasoningEffort &&
    !out.enableFeatures?.length &&
    !out.disableFeatures?.length
    && !out.allowedTools?.length
    && !out.deniedTools?.length
  ) {
    return undefined;
  }

  return out;
}
