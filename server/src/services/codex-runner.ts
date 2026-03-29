import type { CodexExecLaunchInput } from "../types/codex-launch";
import { CodexAppServerRunner } from "./codex-app-server-runner";
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

export function createCodexRunner(
  mode: CodexExecutionMode,
  command: string,
  cwd: string,
): CodexRunner {
  if (mode === "app-server") {
    return new CodexAppServerRunner(command, cwd);
  }

  return new CodexExecRunner(command, cwd);
}
