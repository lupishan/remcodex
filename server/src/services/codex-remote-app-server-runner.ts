import net from "node:net";
import WebSocket from "ws";

import type { CodexExecLaunchInput } from "../types/codex-launch";
import type { CodexRunner } from "./codex-runner";
import { buildCodexMcpToolPolicyOverrides } from "../utils/codex-launch";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export const REMOTE_APPROVAL_POLICY = "on-request";
export const REMOTE_SANDBOX_MODE = "workspace-write";
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval",
]);

function connectWebSocket(endpoint: string): WebSocket {
  if (endpoint.startsWith("ws+unix://") || endpoint.startsWith("unix://")) {
    const prefix = endpoint.startsWith("ws+unix://") ? "ws+unix://" : "unix://";
    const value = endpoint.slice(prefix.length);
    const separator = value.lastIndexOf(":/");
    const socketPath = separator >= 0 ? value.slice(0, separator) : value;
    return new WebSocket("ws://localhost/", {
      perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: 4 * 1024 * 1024,
      createConnection: () => net.createConnection({ path: socketPath }),
    });
  }

  return new WebSocket(endpoint, { perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: 4 * 1024 * 1024 });
}

export class CodexRemoteAppServerRunner implements CodexRunner {
  private socket: WebSocket | null = null;
  private readonly jsonListeners = new Set<(event: unknown) => void>();
  private readonly textListeners = new Set<(stream: "stdout" | "stderr", text: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private requestId = 1;
  private finalized = false;
  private currentTurnId: string | null = null;
  private currentThreadId: string | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly cwd: string,
  ) {}

  start(prompt: string, threadId?: string | null, launch?: CodexExecLaunchInput): number {
    if (!threadId) {
      throw new Error("A remote app-server session must have a Codex thread id.");
    }

    const socket = connectWebSocket(this.endpoint);
    this.socket = socket;
    this.currentThreadId = threadId;
    socket.on("open", () => {
      void this.bootstrap(prompt, threadId, launch).catch((error) => {
        this.emitText("stderr", `Failed to initialize remote Codex app-server: ${this.messageOf(error)}`);
        this.finish(1);
      });
    });
    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("error", (error) => this.emitText("stderr", this.messageOf(error)));
    socket.on("close", () => {
      this.rejectPendingRequests(new Error("Remote Codex app-server closed."));
      this.socket = null;
      if (!this.finalized) {
        this.finalized = true;
        this.exitListeners.forEach((listener) => listener(1));
      }
    });

    return 0;
  }

  stop(): void {
    if (!this.socket) {
      return;
    }
    if (!this.currentTurnId) {
      this.emitText("stderr", "Cannot confirm an interrupt before a turn has started.");
      this.finish(1);
      return;
    }
    void this.request("turn/interrupt", {
      threadId: this.currentThreadId, turnId: this.currentTurnId,
    }).then(() => this.finish(0)).catch((error) => {
      this.emitText("stderr", `Interrupt was not confirmed: ${this.messageOf(error)}`);
      this.finish(1);
    });
  }

  respond(requestId: number, result: unknown): boolean {
    if (!this.socket || !Number.isFinite(requestId)) {
      return false;
    }
    this.write({ jsonrpc: "2.0", id: requestId, result });
    return true;
  }

  onJsonEvent(listener: (event: unknown) => void): () => void {
    this.jsonListeners.add(listener);
    return () => this.jsonListeners.delete(listener);
  }

  onText(listener: (stream: "stdout" | "stderr", text: string) => void): () => void {
    this.textListeners.add(listener);
    return () => this.textListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  isAlive(): boolean {
    return this.socket !== null && this.socket.readyState !== WebSocket.CLOSED;
  }

  private async bootstrap(prompt: string, threadId: string, launch?: CodexExecLaunchInput): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "remcodex", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");

    const approvalPolicy = REMOTE_APPROVAL_POLICY;
    const sandboxMode = launch?.sandbox ?? REMOTE_SANDBOX_MODE;
    const config = await this.buildConfig(launch);
    const result = await this.request("thread/resume", {
      threadId,
      cwd: this.cwd,
      approvalPolicy,
      sandbox: sandboxMode,
      config,
      persistExtendedHistory: true,
    }) as { thread?: { id?: string } };
    const resolvedThreadId = result.thread?.id ?? threadId;
    this.currentThreadId = resolvedThreadId;
    const started = await this.request("turn/start", {
      threadId: resolvedThreadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      approvalPolicy,
      sandboxPolicy: this.buildSandboxPolicy(sandboxMode, launch),
      model: launch?.model ?? null,
      effort: launch?.reasoningEffort ?? null,
    }) as { turn?: { id?: string } };
    this.currentTurnId = started.turn?.id ?? this.currentTurnId;
  }

  private async buildConfig(launch: CodexExecLaunchInput | undefined): Promise<Record<string, unknown> | null> {
    const config: Record<string, unknown> = {};
    for (const name of launch?.enableFeatures ?? []) config[`features.${name}`] = true;
    for (const name of launch?.disableFeatures ?? []) config[`features.${name}`] = false;
    Object.assign(config, buildCodexMcpToolPolicyOverrides(
      launch?.allowedTools || launch?.deniedTools
        ? { allowedTools: launch.allowedTools, deniedTools: launch.deniedTools }
        : undefined,
    ));
    if (launch?.profile) config.profile = launch.profile;

    return Object.keys(config).length ? config : null;
  }

  private buildSandboxPolicy(mode: CodexExecLaunchInput["sandbox"] | undefined, launch?: CodexExecLaunchInput): unknown {
    if (mode === "read-only") return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
    if (mode === "danger-full-access") return { type: "dangerFullAccess" };
    return {
      type: "workspaceWrite",
      writableRoots: [this.cwd, ...(launch?.additionalWritableRoots ?? [])],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Remote app-server timed out: ${method}`));
      }, 10_000);
      this.pendingRequests.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        clearTimeout(timer); this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Remote Codex app-server is not connected.");
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.emitText("stdout", text);
      return;
    }

    if (typeof message.id === "number" && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;
    const params = message.params as Record<string, unknown> | undefined;
    // Shared servers may broadcast other threads. Never deliver those to this session.
    if (!params || params.threadId !== this.currentThreadId) return;
    const turn = params.turn as Record<string, unknown> | undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : null;
    if (turnId && this.currentTurnId && turnId !== this.currentTurnId) return;
    if (message.method === "turn/started") this.currentTurnId = turnId;
    this.jsonListeners.forEach((listener) => listener(message));
    if (typeof message.id === "number") {
      if (!APPROVAL_METHODS.has(message.method)) this.respondUnsupportedRequest(message.id, message.method);
      return;
    }
    if (message.method === "turn/completed" && turnId && turnId === this.currentTurnId) {
      this.finish(turn?.status === "failed" ? 1 : 0);
    }
  }

  private respondUnsupportedRequest(id: number, method: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
  }

  private finish(exitCode: number): void {
    if (this.finalized) return;
    this.finalized = true;
    this.rejectPendingRequests(new Error("Remote turn finished."));
    this.exitListeners.forEach((listener) => listener(exitCode));
    this.socket?.close();
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pendingRequests.clear();
  }

  private emitText(stream: "stdout" | "stderr", text: string): void {
    if (text.trim()) this.textListeners.forEach((listener) => listener(stream, text.trimEnd()));
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
