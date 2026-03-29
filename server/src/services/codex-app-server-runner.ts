import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { CodexExecLaunchInput } from "../types/codex-launch";
import type { CodexRunner } from "./codex-runner";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface ThreadStartResult {
  thread?: {
    id?: string;
  };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CodexAppServerRunner implements CodexRunner {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly jsonListeners = new Set<(event: unknown) => void>();
  private readonly textListeners = new Set<
    (stream: "stdout" | "stderr", text: string) => void
  >();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private requestId = 1;
  private finalized = false;
  private stopTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
  ) {}

  start(prompt: string, threadId?: string | null, launch?: CodexExecLaunchInput): number {
    this.process = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: process.env,
      stdio: "pipe",
    });

    if (!this.process.pid) {
      throw new Error("Failed to start codex app-server process.");
    }

    this.process.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf8"));
    });

    this.process.stderr.on("data", (chunk: Buffer) => {
      this.emitText("stderr", chunk.toString("utf8"));
    });

    this.process.on("close", (exitCode) => {
      this.clearStopTimer();
      this.flushStdoutRemainder();
      this.rejectPendingRequests(
        new Error("Codex app-server closed before replying to all requests."),
      );
      this.process = null;

      if (!this.finalized) {
        this.finalized = true;
        this.exitListeners.forEach((listener) => listener(exitCode));
      }
    });

    this.process.on("error", (error) => {
      this.emitText("stderr", `Failed to spawn Codex app-server: ${error.message}`);
    });

    void this.bootstrap(prompt, threadId, launch).catch((error) => {
      this.emitText("stderr", `Failed to initialize Codex app-server: ${this.messageOf(error)}`);
      this.finish(1);
    });

    return this.process.pid;
  }

  stop(): void {
    if (!this.process) {
      return;
    }

    this.process.stdin.end();
    this.process.kill("SIGINT");
    this.stopTimer = setTimeout(() => {
      this.process?.kill("SIGTERM");
    }, 1500);
    this.stopTimer.unref();
  }

  respond(requestId: number, result: unknown): boolean {
    if (!this.process || !Number.isFinite(requestId)) {
      return false;
    }

    this.respondJsonRpc(requestId, result);
    return true;
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

  private async bootstrap(
    prompt: string,
    threadId: string | null | undefined,
    launch: CodexExecLaunchInput | undefined,
  ): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "remote-agent-console",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.notify("initialized");

    const approvalPolicy = "on-request";
    const sandboxMode = launch?.sandbox ?? "workspace-write";
    const config = this.buildConfig(launch);

    const threadResult = (threadId
      ? await this.request("thread/resume", {
          threadId,
          cwd: this.cwd,
          approvalPolicy,
          sandbox: sandboxMode,
          config,
          persistExtendedHistory: true,
        })
      : await this.request("thread/start", {
          cwd: this.cwd,
          approvalPolicy,
          sandbox: sandboxMode,
          config,
          experimentalRawEvents: false,
          persistExtendedHistory: true,
        })) as ThreadStartResult;

    const resolvedThreadId = threadResult.thread?.id ?? threadId;
    if (!resolvedThreadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }

    await this.request("turn/start", {
      threadId: resolvedThreadId,
      input: [
        {
          type: "text",
          text: prompt,
          text_elements: [],
        },
      ],
      approvalPolicy,
      sandboxPolicy: this.buildSandboxPolicy(sandboxMode, launch),
      model: launch?.model ?? null,
      effort: launch?.reasoningEffort ?? null,
    });
  }

  private buildConfig(launch: CodexExecLaunchInput | undefined): Record<string, unknown> | null {
    const config: Record<string, unknown> = {};

    if (launch?.profile) {
      config.profile = launch.profile;
    }

    if (launch?.enableFeatures?.length) {
      for (const name of launch.enableFeatures) {
        config[`features.${name}`] = true;
      }
    }

    if (launch?.disableFeatures?.length) {
      for (const name of launch.disableFeatures) {
        config[`features.${name}`] = false;
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  }

  private buildSandboxPolicy(
    sandboxMode: CodexExecLaunchInput["sandbox"] | undefined,
    launch: CodexExecLaunchInput | undefined,
  ): unknown {
    if (sandboxMode === "read-only") {
      return {
        type: "readOnly",
        access: {
          type: "fullAccess",
        },
        networkAccess: false,
      };
    }

    if (sandboxMode === "danger-full-access") {
      return {
        type: "dangerFullAccess",
      };
    }

    return {
      type: "workspaceWrite",
      writableRoots: this.workspaceWritableRoots(launch?.additionalWritableRoots),
      readOnlyAccess: {
        type: "fullAccess",
      },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private workspaceWritableRoots(additionalRoots?: string[]): string[] {
    const roots = new Set<string>();
    roots.add(this.cwd);
    for (const root of additionalRoots ?? []) {
      if (typeof root === "string" && root.trim()) {
        roots.add(root.trim());
      }
    }
    roots.add(path.join(os.homedir(), ".codex", "memories"));
    return [...roots];
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.requestId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.writeJson(request);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.writeJson({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private writeJson(message: object): void {
    if (!this.process) {
      throw new Error("Codex app-server process is not running.");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      this.handleJsonLine(line);
    }
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
      const message = JSON.parse(trimmed) as unknown;
      this.handleJsonMessage(message);
    } catch {
      this.emitText("stdout", trimmed);
    }
  }

  private handleJsonMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }

    if ("id" in message && typeof message.id === "number" && !("method" in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);

      if (response.error) {
        pending.reject(
          new Error(response.error.message || `JSON-RPC request failed (${message.id}).`),
        );
        return;
      }

      pending.resolve(response.result);
      return;
    }

    if (!("method" in message) || typeof message.method !== "string") {
      return;
    }

    if ("id" in message && typeof message.id === "number") {
      this.handleServerRequest(message as JsonRpcNotification & { id: number });
      return;
    }

    this.handleNotification(message as JsonRpcNotification);
  }

  private handleServerRequest(message: JsonRpcNotification & { id: number }): void {
    this.jsonListeners.forEach((listener) => listener(message));

    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval":
        return;
      default:
        this.respondJsonRpcError(message.id, -32601, `Unsupported server request: ${message.method}`);
    }
  }

  private handleNotification(message: JsonRpcNotification): void {
    const method = message.method;
    this.jsonListeners.forEach((listener) => listener(message));

    if (method === "turn/completed") {
      const params = message.params as Record<string, unknown> | undefined;
      const turn = params?.turn as { status?: unknown } | undefined;
      this.finish(turn?.status === "failed" ? 1 : 0);
    }
  }

  private respondJsonRpc(id: number, result: unknown): void {
    this.writeJson({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private respondJsonRpcError(id: number, code: number, message: string): void {
    this.writeJson({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    });
  }

  private finish(exitCode: number | null): void {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    this.exitListeners.forEach((listener) => listener(exitCode));

    if (!this.process) {
      return;
    }

    this.process.stdin.end();
    this.process.kill("SIGTERM");
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private clearStopTimer(): void {
    if (!this.stopTimer) {
      return;
    }

    clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  private emitText(stream: "stdout" | "stderr", text: string): void {
    if (!text) {
      return;
    }

    const normalized = text.trimEnd();
    if (!normalized) {
      return;
    }

    this.textListeners.forEach((listener) => listener(stream, normalized));
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
