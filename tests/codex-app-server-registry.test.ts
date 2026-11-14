import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import net from "node:net";

import { CodexAppServerRegistryService } from "../server/src/services/codex-app-server-registry";

test("lists app-server instances only while their socket is present", async (t) => {
  const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-app-server-registry-"));
  const socketPath = path.join(registryDirectory, "session.sock");
  const registryPath = path.join(registryDirectory, "session.json");
  const socketServer = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { socketServer.once("error", reject); socketServer.listen(socketPath, resolve); });
  } catch (error) {
    fs.rmSync(registryDirectory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Unix socket creation is unavailable in this runtime"); return; }
    throw error;
  }
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      id: "tui-session",
      endpoint: `unix://${socketPath}`,
      wsEndpoint: `ws+unix://${socketPath}:/`,
      socketPath,
      pid: process.pid,
      cwd: registryDirectory,
      startedAt: new Date().toISOString(),
      source: "test",
    }),
  );

  const previousDirectory = process.env.CODEX_APP_SERVER_REGISTRY_DIR;
  process.env.CODEX_APP_SERVER_REGISTRY_DIR = registryDirectory;
  try {
    const registry = new CodexAppServerRegistryService({} as never);
    assert.deepEqual(registry.list().map((instance) => instance.id), ["tui-session"]);

    await new Promise<void>(resolve => socketServer.close(() => resolve()));
    assert.deepEqual(registry.list(), []);
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CODEX_APP_SERVER_REGISTRY_DIR;
    } else {
      process.env.CODEX_APP_SERVER_REGISTRY_DIR = previousDirectory;
    }
    fs.rmSync(registryDirectory, { recursive: true, force: true });
  }
});


test("regular files cannot impersonate registered app-server sockets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-registry-file-"));
  const socket = path.join(directory, "fake.sock");
  fs.writeFileSync(socket, "not a socket");
  fs.writeFileSync(path.join(directory, "test.json"), JSON.stringify({ id: "fake", socketPath: socket, endpoint: `unix://${socket}` }));
  const previous = process.env.CODEX_APP_SERVER_REGISTRY_DIR;
  process.env.CODEX_APP_SERVER_REGISTRY_DIR = directory;
  try { assert.deepEqual(new CodexAppServerRegistryService({} as never).list(), []); }
  finally { if (previous === undefined) delete process.env.CODEX_APP_SERVER_REGISTRY_DIR; else process.env.CODEX_APP_SERVER_REGISTRY_DIR = previous; fs.rmSync(directory, { recursive: true, force: true }); }
});
