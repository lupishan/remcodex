import { mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";

import { createCodexOptionsRouter } from "./controllers/codex-options.controller";
import { createMessageRouter } from "./controllers/message.controller";
import { createProjectRouter } from "./controllers/project.controller";
import { createSessionRouter } from "./controllers/session.controller";
import { createDatabase } from "./db/client";
import { runMigrations } from "./db/migrations";
import { registerSessionGateway } from "./gateways/ws.gateway";
import { EventStore } from "./services/event-store";
import { CodexRolloutSyncService } from "./services/codex-rollout-sync";
import { ProjectManager } from "./services/project-manager";
import { SessionManager } from "./services/session-manager";
import { SessionTimelineService } from "./services/session-timeline-service";
import type { CodexExecutionMode } from "./services/codex-runner";
import { resolveDefaultDatabasePath, resolvePackageRoot } from "./utils/runtime-paths";
import { resolveExecutable } from "./utils/command";
import { isAppError } from "./utils/errors";

export interface RemCodexServerOptions {
  port?: number;
  databasePath?: string;
  projectRootsEnv?: string;
  repoRoot?: string;
  codexCommand?: string;
  codexMode?: CodexExecutionMode;
  logStartup?: boolean;
}

export interface StartedRemCodexServer {
  app: express.Express;
  server: http.Server;
  port: number;
  repoRoot: string;
  databasePath: string;
  codexCommand: string;
  codexMode: CodexExecutionMode;
  projectRoots: string[];
  stop: () => Promise<void>;
}

interface BuiltRemCodexServer {
  app: express.Express;
  server: http.Server;
  closeDatabase: () => void;
  port: number;
  repoRoot: string;
  databasePath: string;
  codexCommand: string;
  codexMode: CodexExecutionMode;
  projectRoots: string[];
  logStartup: boolean;
}

function buildRemCodexServer(options: RemCodexServerOptions = {}): BuiltRemCodexServer {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : resolvePackageRoot();
  const port = options.port ?? Number.parseInt(process.env.PORT ?? "18840", 10);
  const databasePath =
    options.databasePath ??
    process.env.DATABASE_PATH ??
    resolveDefaultDatabasePath();
  const codexCommand = resolveExecutable(options.codexCommand ?? process.env.CODEX_COMMAND ?? "codex");
  const codexMode: CodexExecutionMode =
    options.codexMode ?? (process.env.CODEX_MODE === "exec-json" ? "exec-json" : "app-server");
  const projectRootsEnv = options.projectRootsEnv ?? process.env.PROJECT_ROOTS;

  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = createDatabase(databasePath);
  runMigrations(db);

  const eventStore = new EventStore(db);
  const sessionTimeline = new SessionTimelineService(eventStore);
  const projectManager = new ProjectManager(db, projectRootsEnv, repoRoot);
  const codexRolloutSync = new CodexRolloutSyncService(db);
  const sessionManager = new SessionManager({
    db,
    eventStore,
    projectManager,
    codexCommand,
    codexMode,
  });

  const app = express();
  const server = http.createServer(app);

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      codexMode,
      codexCommand,
      projectRoots: projectManager.listAllowedRoots(),
      now: new Date().toISOString(),
    });
  });

  app.use("/api/projects", createProjectRouter(projectManager));
  app.use(
    "/api/codex",
    createCodexOptionsRouter({
      sessionManager,
      projectManager,
      eventStore,
      codexMode,
      codexRolloutSync,
    }),
  );
  app.use(
    "/api/sessions",
    createSessionRouter(
      sessionManager,
      eventStore,
      projectManager,
      codexRolloutSync,
      sessionTimeline,
    ),
  );
  app.use("/api/sessions/:sessionId/messages", createMessageRouter(sessionManager));

  const webRoot = path.join(repoRoot, "web");
  app.use(express.static(webRoot));
  app.get("/", (_request, response) => {
    response.sendFile(path.join(webRoot, "index.html"));
  });

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (isAppError(error)) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : "Internal server error";
      response.status(500).json({
        error: message,
      });
    },
  );

  registerSessionGateway(server, {
    eventStore,
    sessionManager,
  });

  return {
    app,
    server,
    closeDatabase: () => {
      const closable = db as typeof db & { close?: () => void };
      closable.close?.();
    },
    port,
    repoRoot,
    databasePath,
    codexCommand,
    codexMode,
    projectRoots: projectManager.listAllowedRoots(),
    logStartup: options.logStartup ?? true,
  };
}

export async function startRemCodexServer(
  options: RemCodexServerOptions = {},
): Promise<StartedRemCodexServer> {
  const built = buildRemCodexServer(options);

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      built.server.off("listening", handleListening);
      reject(error);
    };

    const handleListening = () => {
      built.server.off("error", handleError);
      resolve();
    };

    built.server.once("error", handleError);
    built.server.once("listening", handleListening);
    built.server.listen(built.port);
  });

  if (built.logStartup) {
    console.log(
      JSON.stringify({
        message: "RemCodex listening",
        port: built.port,
        codexMode: built.codexMode,
        databasePath: built.databasePath,
        codexCommand: built.codexCommand,
      }),
    );
  }

  return {
    app: built.app,
    server: built.server,
    port: built.port,
    repoRoot: built.repoRoot,
    databasePath: built.databasePath,
    codexCommand: built.codexCommand,
    codexMode: built.codexMode,
    projectRoots: built.projectRoots,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        built.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          built.closeDatabase();
          resolve();
        });
      }),
  };
}

async function main() {
  await startRemCodexServer();
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "Failed to start RemCodex",
        error: message,
      }),
    );
    process.exitCode = 1;
  });
}
