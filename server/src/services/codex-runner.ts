import type { CodexExecLaunchInput } from "../types/codex-launch";
import { CodexAppServerRunner } from "./codex-app-server-runner";
import { CodexRemoteAppServerRunner } from "./codex-remote-app-server-runner";
import { CodexExecRunner } from "./codex-exec-runner";

export type CodexExecutionMode = "exec-json" | "app-server";

export interface CodexRunner {
  start(prompt: string, threadId?: string | null, launch?: CodexExecLaunchInput): number;
  stop(): void;
  respond(requestId: number, result: unknown): boolean;
  onJsonEvent(listener: (event: unknown) => void): () => void;
  onText(listener: (stream: "stdout" | "stderr", text: string) => void): () => void;
  onExit(listener: (exitCode: number | null) => void): () => void;
  isAlive(): boolean;
}

export interface CodexHomePolicy {
  codexHome: string | null;
  fixedByRemoteServer: boolean;
}

export function buildCodexChildEnvironment(
  codexHome?: string | null,
  peerCredential?: string | null,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const refs: string[] = [];
  try {
    const instances: unknown = JSON.parse(env.REMCODEX_REMOTE_INSTANCES || "[]");
    if (Array.isArray(instances)) {
      for (const instance of instances) if (typeof instance?.credentialRef === "string") refs.push(instance.credentialRef);
    }
  } catch { /* Invalid instance configuration is rejected at startup. */ }
  for (const key of Object.keys(env)) if (key.startsWith("REMCODEX_") || refs.includes(key)) delete env[key];
  delete env.REMCODEX_PEER_ADMIN_TOKEN;
  delete env.REMCODEX_MCP_API_TOKEN;
  delete env.REMCODEX_PEER_TOKEN;
  if (codexHome) env.CODEX_HOME = codexHome;
  if (peerCredential) env.REMCODEX_PEER_TOKEN = peerCredential;
  return env;
}

/** Remote app servers own their Codex home; never apply the local session home to them. */
export function resolveCodexHomePolicy(
  mode: CodexExecutionMode,
  appServerEndpoint: string | null | undefined,
  codexHome: string | null | undefined,
): CodexHomePolicy {
  if (mode === "app-server" && appServerEndpoint?.trim()) {
    return { codexHome: null, fixedByRemoteServer: true };
  }

  return { codexHome: codexHome?.trim() || null, fixedByRemoteServer: false };
}

export function createCodexRunner(
  mode: CodexExecutionMode,
  command: string,
  cwd: string,
  appServerEndpoint?: string | null,
  codexHome?: string | null,
  peerCredential?: string | null,
): CodexRunner {
  const homePolicy = resolveCodexHomePolicy(mode, appServerEndpoint, codexHome);
  if (mode === "app-server") {
    if (appServerEndpoint) {
      return new CodexRemoteAppServerRunner(appServerEndpoint, cwd);
    }
    return new CodexAppServerRunner(command, cwd, homePolicy.codexHome, peerCredential);
  }

  return new CodexExecRunner(command, cwd, homePolicy.codexHome, peerCredential);
}
