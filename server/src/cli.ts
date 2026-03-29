#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";

import type { CodexExecutionMode } from "./services/codex-runner";
import { DEFAULT_PORT, startRemCodexServer, resolveDefaultDatabasePath, resolvePackageRoot } from "./app";
import { resolveExecutable } from "./utils/command";

interface CliFlags {
  port?: number;
  databasePath?: string;
  noOpen: boolean;
}

function print(message = "") {
  process.stdout.write(`${message}\n`);
}

function printError(message = "") {
  process.stderr.write(`${message}\n`);
}

function readPackageVersion(): string {
  try {
    const packageRoot = resolvePackageRoot();
    const packageJson = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string): { ok: boolean; resolved: string } {
  const resolved = resolveExecutable(command);
  const ok =
    Boolean(resolved) &&
    (resolved.includes(path.sep) || path.isAbsolute(resolved)) &&
    isExecutableFile(resolved);

  return { ok, resolved };
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    noOpen: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--no-open") {
      flags.noOpen = true;
      continue;
    }
    if (token === "--port") {
      const value = argv[index + 1];
      const parsed = Number.parseInt(value ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        flags.port = parsed;
      }
      index += 1;
      continue;
    }
    if (token === "--db" || token === "--database") {
      const value = argv[index + 1];
      if (value) {
        flags.databasePath = path.resolve(value);
      }
      index += 1;
    }
  }

  return flags;
}

function getLanAddresses(): string[] {
  const interfaces = networkInterfaces();
  const addresses: string[] = [];

  Object.values(interfaces).forEach((entries) => {
    entries?.forEach((entry) => {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    });
  });

  return Array.from(new Set(addresses));
}

function openBrowser(url: string) {
  let command = "";
  let args: string[] = [];

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

function usage() {
  print("RemCodex");
  print("");
  print("Usage:");
  print("  remcodex                Start the local web app");
  print("  remcodex start          Start the local web app");
  print("  remcodex doctor         Check local environment");
  print("  remcodex version        Show version");
  print("");
  print("Options:");
  print("  --port <number>         Preferred port");
  print("  --db <path>             Use a specific SQLite database path");
  print("  --no-open               Do not open a browser automatically");
}

async function runDoctor(flags: CliFlags): Promise<number> {
  const version = readPackageVersion();
  const rawCodexCommand = process.env.CODEX_COMMAND ?? "codex";
  const codex = commandExists(rawCodexCommand);
  const packageRoot = resolvePackageRoot();
  const databasePath = flags.databasePath ?? process.env.DATABASE_PATH ?? resolveDefaultDatabasePath();
  const databaseDir = path.dirname(databasePath);
  const databaseDirExists = existsSync(databaseDir);
  const databaseDirWritable =
    databaseDirExists && (() => {
      try {
        accessSync(databaseDir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();

  print(`RemCodex v${version}`);
  print("");
  print(`Node: ${process.version}`);
  print(`Package root: ${packageRoot}`);
  print(`Database path: ${databasePath}`);
  print(
    `Database dir: ${databaseDirExists ? (databaseDirWritable ? "writable" : "not writable") : "missing (will be created on first start)"}`,
  );
  print(`Default project root: ${process.env.PROJECT_ROOTS?.trim() || homedir()}`);
  print(`Codex command: ${rawCodexCommand}`);
  print(`Codex resolved: ${codex.resolved}`);
  print(`Codex available: ${codex.ok ? "yes" : "no"}`);

  if (!codex.ok) {
    printError("");
    printError("Codex CLI was not found in PATH.");
    printError("Install Codex first, or set CODEX_COMMAND to the correct executable.");
    return 1;
  }

  print("");
  print("Environment looks good.");
  return 0;
}

async function runStart(flags: CliFlags): Promise<number> {
  const version = readPackageVersion();
  const rawCodexCommand = process.env.CODEX_COMMAND ?? "codex";
  const codex = commandExists(rawCodexCommand);

  if (!codex.ok) {
    printError("Codex CLI was not found in PATH.");
    printError("Install Codex first, or set CODEX_COMMAND to the correct executable.");
    return 1;
  }

  const preferredPort = flags.port ?? Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const codexMode: CodexExecutionMode = process.env.CODEX_MODE === "exec-json" ? "exec-json" : "app-server";

  let started = null as Awaited<ReturnType<typeof startRemCodexServer>> | null;
  let activePort = preferredPort;

  for (let offset = 0; offset < 20; offset += 1) {
    const candidate = preferredPort + offset;
    try {
      started = await startRemCodexServer({
        port: candidate,
        databasePath: flags.databasePath,
        codexCommand: rawCodexCommand,
        codexMode,
        logStartup: false,
      });
      activePort = candidate;
      break;
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "EADDRINUSE") {
        continue;
      }
      throw error;
    }
  }

  if (!started) {
    printError(`Could not find an available port starting from ${preferredPort}.`);
    return 1;
  }

  const localUrl = `http://127.0.0.1:${activePort}`;
  const lanUrls = getLanAddresses().map((address) => `http://${address}:${activePort}`);

  print(`RemCodex v${version}`);
  print("");
  print("Starting local workspace...");
  print(`Codex: ${codex.resolved}`);
  print(`Mode: ${started.codexMode}`);
  print(`Database: ${started.databasePath}`);
  print("");
  print(`Local: ${localUrl}`);
  lanUrls.forEach((url) => {
    print(`LAN:   ${url}`);
  });

  if (!flags.noOpen) {
    openBrowser(localUrl);
    print("");
    print("Opening browser...");
  }

  const shutdown = async () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    try {
      await started?.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return await new Promise<number>((resolve) => {
    started?.server.on("close", () => resolve(0));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    print(readPackageVersion());
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }

  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "start";
  const flagArgs = command === "start" ? argv.slice(1) : argv;
  const flags = parseFlags(flagArgs);

  switch (command) {
    case "start":
      process.exitCode = await runStart(flags);
      return;
    case "doctor":
      process.exitCode = await runDoctor(flags);
      return;
    case "version":
      print(readPackageVersion());
      return;
    case "help":
      usage();
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printError(message);
  process.exitCode = 1;
});
