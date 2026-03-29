import type { CodexExecLaunchInput, CodexSandboxMode } from "../types/codex-launch";

const SANDBOX: Set<CodexSandboxMode> = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const SPEEDS = new Set(["default", "fast", "deep"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

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

export function normalizeCodexExecLaunchInput(raw: unknown): CodexExecLaunchInput | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const o = raw as Record<string, unknown>;
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

  if (
    !out.model &&
    !out.profile &&
    !out.sandbox &&
    !out.speed &&
    !out.reasoningEffort &&
    !out.enableFeatures?.length &&
    !out.disableFeatures?.length
  ) {
    return undefined;
  }

  return out;
}
