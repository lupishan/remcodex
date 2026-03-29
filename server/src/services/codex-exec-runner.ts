import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { CodexExecLaunchInput } from "../types/codex-launch";
import type { CodexRunner } from "./codex-runner";

export interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
}

export class CodexExecRunner implements CodexRunner {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly jsonListeners = new Set<(event: unknown) => void>();
  private readonly textListeners = new Set<
    (stream: "stdout" | "stderr", text: string) => void
  >();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private stdoutBuffer = "";
  private stopTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
  ) {}

  start(prompt: string, threadId?: string | null, launch?: CodexExecLaunchInput): number {
    const args = this.buildExecArgs(prompt, threadId, launch);

    this.process = spawn(this.command, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: "pipe",
    });

    if (!this.process.pid) {
      throw new Error("Failed to start codex exec process.");
    }

    this.process.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf8"));
    });

    this.process.stderr.on("data", (chunk: Buffer) => {
      this.emitText("stderr", chunk.toString("utf8"));
    });

    this.process.on("close", (exitCode) => {
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }

      this.flushStdoutRemainder();
      this.process = null;
      this.exitListeners.forEach((listener) => listener(exitCode));
    });

    this.process.on("error", (error) => {
      this.emitText("stderr", `Failed to spawn Codex exec: ${error.message}`);
    });

    return this.process.pid;
  }

  stop(): void {
    if (!this.process) {
      return;
    }

    this.process.kill("SIGINT");
    this.stopTimer = setTimeout(() => {
      this.process?.kill("SIGTERM");
    }, 1500);
    this.stopTimer.unref();
  }

  respond(): boolean {
    return false;
  }

  onJsonEvent(listener: (event: unknown) => void): () => void {
    this.jsonListeners.add(listener);
    return () => {
      this.jsonListeners.delete(listener);
    };
  }

  onText(listener: (stream: "stdout" | "stderr", text: string) => void): () => void {
    this.textListeners.add(listener);
    return () => {
      this.textListeners.delete(listener);
    };
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  isAlive(): boolean {
    return this.process !== null;
  }

  private buildExecArgs(
    prompt: string,
    threadId: string | null | undefined,
    launch: CodexExecLaunchInput | undefined,
  ): string[] {
    const mid: string[] = [];

    if (launch?.model) {
      mid.push("-m", launch.model);
    }

    if (launch?.profile) {
      mid.push("-p", launch.profile);
    }

    if (launch?.sandbox) {
      mid.push("-s", launch.sandbox);
    }

    if (launch?.reasoningEffort) {
      mid.push("-c", `model_reasoning_effort=${launch.reasoningEffort}`);
    }

    if (launch?.speed === "fast") {
      mid.push("--enable", "fast_mode");
    } else if (launch?.speed === "deep") {
      mid.push("--disable", "fast_mode");
    }

    for (const name of launch?.enableFeatures ?? []) {
      mid.push("--enable", name);
    }

    for (const name of launch?.disableFeatures ?? []) {
      mid.push("--disable", name);
    }

    if (threadId) {
      return ["exec", "resume", "--json", ...mid, "--skip-git-repo-check", threadId, prompt];
    }

    return ["exec", "--json", ...mid, "--skip-git-repo-check", "--color", "never", prompt];
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";

    lines.forEach((line) => this.handleJsonLine(line));
  }

  private flushStdoutRemainder(): void {
    if (!this.stdoutBuffer.trim()) {
      this.stdoutBuffer = "";
      return;
    }

    this.handleJsonLine(this.stdoutBuffer);
    this.stdoutBuffer = "";
  }

  private handleJsonLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as unknown;
      this.jsonListeners.forEach((listener) => listener(event));
    } catch {
      this.emitText("stdout", trimmed);
    }
  }

  private emitText(stream: "stdout" | "stderr", text: string): void {
    if (!text) {
      return;
    }

    this.textListeners.forEach((listener) => listener(stream, text.trimEnd()));
  }
}
