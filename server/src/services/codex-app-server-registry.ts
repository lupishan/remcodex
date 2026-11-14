import net from "node:net";
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";

import type { CodexRolloutSyncService } from "./codex-rollout-sync";

export interface CodexAppServerInstance {
  id: string;
  endpoint: string;
  wsEndpoint: string;
  socketPath: string;
  pid: number | null;
  cwd: string | null;
  startedAt: string | null;
  source: string | null;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface RegistryThread {
  id?: unknown;
  path?: unknown;
}

function defaultRegistryDirectory(): string {
  return process.env.CODEX_APP_SERVER_REGISTRY_DIR?.trim() ||
    path.join(process.env.XDG_RUNTIME_DIR?.trim() || `/tmp/remcodex-${process.getuid?.() ?? "user"}`, "codex-app-servers");
}

function connectWebSocket(endpoint: string): WebSocket {
  if (endpoint.startsWith("ws+unix://")) {
    const value = endpoint.slice("ws+unix://".length);
    const separator = value.lastIndexOf(":/");
    const socketPath = separator >= 0 ? value.slice(0, separator) : value;
    return new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => net.createConnection({ path: socketPath }),
    });
  }

  return new WebSocket(endpoint, { perMessageDeflate: false });
}

function parseInstance(raw: unknown): CodexAppServerInstance | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const socketPath = typeof value.socketPath === "string" ? value.socketPath.trim() : "";
  if (!id || !endpoint || !socketPath || !existsSync(socketPath)) {
    return null;
  }

  const stat = lstatSync(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) return null;
  if (endpoint !== `unix://${socketPath}`) return null;
  const wsEndpoint = `ws+unix://${socketPath}:/`;
  if (value.wsEndpoint && value.wsEndpoint !== wsEndpoint) return null;
  return {
    id,
    endpoint,
    wsEndpoint,
    socketPath,
    pid: typeof value.pid === "number" ? value.pid : null,
    cwd: typeof value.cwd === "string" ? value.cwd : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    source: typeof value.source === "string" ? value.source : null,
  };
}

export class CodexAppServerRegistryService {
  private readonly registryDirectory: string;
  private liveInstances: CodexAppServerInstance[] = [];
  private syncInFlight: Promise<CodexAppServerInstance[]> | null = null;
  private refreshedAt = 0;

  live(): CodexAppServerInstance[] {
    if (Date.now() - this.refreshedAt > 2000) void this.sync().catch(() => undefined);
    const present = new Set(this.list().map(instance => instance.id));
    return this.liveInstances.filter(instance => present.has(instance.id));
  }

  constructor(private readonly rolloutSync: CodexRolloutSyncService) {
    this.registryDirectory = defaultRegistryDirectory();
  }

  list(): CodexAppServerInstance[] {
    try {
      if (!existsSync(this.registryDirectory)) {
        return [];
      }

      const directory = lstatSync(this.registryDirectory);
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) return [];
      return readdirSync(this.registryDirectory)
        .filter((name) => name.endsWith(".json")).slice(0, 64)
        .flatMap((name) => {
          try {
            const metadata = path.join(this.registryDirectory, name);
            const stat = lstatSync(metadata);
            if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 16 * 1024) return [];
            const parsed = parseInstance(JSON.parse(readFileSync(metadata, "utf8")));
            return parsed ? [parsed] : [];
          } catch {
            return [];
          }
        });
    } catch { return []; }
  }

  async sync(): Promise<CodexAppServerInstance[]> {
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = (async () => {
      const instances = this.list();
      const results = await Promise.all(instances.map(async instance => {
        try {
          const threads = await this.listThreads(instance);
          for (const thread of threads) {
            const rolloutPath = typeof thread.path === "string" ? thread.path.trim() : "";
            if (!rolloutPath || !existsSync(rolloutPath)) continue;
            const imported = this.rolloutSync.importRollout(rolloutPath);
            this.rolloutSync.attachAppServer(imported.sessionId, { id: instance.id, endpoint: instance.endpoint, pid: instance.pid });
          }
          return instance;
        } catch { return null; }
      }));
      this.liveInstances = results.filter((instance): instance is CodexAppServerInstance => instance !== null);
      this.refreshedAt = Date.now();
      return this.liveInstances;
    })();
    try { return await this.syncInFlight; } finally { this.syncInFlight = null; }
  }

  private listThreads(instance: CodexAppServerInstance): Promise<RegistryThread[]> {
    return new Promise((resolve, reject) => {
      const socket = connectWebSocket(instance.wsEndpoint);
      let requestId = 1;
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      let settled = false;
      const timer = setTimeout(() => fail(new Error("App-server discovery timed out.")), 2000);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
        socket.terminate();
        reject(error);
      };
      const request = (method: string, params?: unknown): Promise<unknown> => {
        const id = requestId++;
        return new Promise((requestResolve, requestReject) => {
          pending.set(id, { resolve: requestResolve, reject: requestReject });
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcMessage));
        });
      };

      socket.once("close", () => fail(new Error("App-server closed during discovery.")));
      socket.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
      socket.once("open", async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "remcodex-discovery", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          });
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
          const threads: RegistryThread[] = [];
          let cursor: string | null = null;
          const seenCursors = new Set<string>();
          for (let page = 0; page < 10; page++) {
            const result = await request("thread/list", { cwd: instance.cwd, limit: 100, cursor });
            const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
            const items = Array.isArray(value.data) ? value.data : Array.isArray(value.threads) ? value.threads : [];
            threads.push(...items.filter((thread): thread is RegistryThread => Boolean(thread && typeof thread === "object")));
            cursor = typeof value.nextCursor === "string" && value.nextCursor ? value.nextCursor : null;
            if (!cursor || seenCursors.has(cursor)) break;
            seenCursors.add(cursor);
          }
          settled = true; clearTimeout(timer); socket.close(); resolve(threads);

        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (typeof message.id !== "number") {
            return;
          }
          const resolver = pending.get(message.id);
          if (!resolver) {
            return;
          }
          pending.delete(message.id);
          if (message.error) {
            resolver.reject(new Error("App-server request failed."));
            fail(new Error(`Codex app-server request failed: ${JSON.stringify(message.error)}`));
            return;
          }
          resolver.resolve(message.result);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
}
