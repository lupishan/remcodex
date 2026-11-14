const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");

const repoRoot = path.resolve(__dirname, "..");
const npmCache = path.join(os.tmpdir(), "remcodex-npm-cache");
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-mcp-smoke-"));
const smokeHome = path.join(smokeRoot, "home");
const smokeDb = path.join(smokeHome, ".remcodex", "smoke-mcp.db");
const smokePort = 33118;
const authToken = "smoke-mcp-token";
const runtimeBin = path.dirname(process.execPath);

fs.mkdirSync(smokeHome, { recursive: true });

function createCleanEnv(extra = {}) {
  return {
    PATH: [runtimeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    TERM: process.env.TERM,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    HOME: smokeHome,
    USERPROFILE: smokeHome,
    XDG_CONFIG_HOME: path.join(smokeHome, ".config"),
    XDG_DATA_HOME: path.join(smokeHome, ".local", "share"),
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    CODEX_COMMAND: "true",
    REMCODEX_MCP_API_TOKEN: authToken,
    ...extra,
  };
}

function run(command, args, cwd = repoRoot, env = createCleanEnv()) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env,
  });
}

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        if (body && body.ok) {
          return body;
        }
      }
    } catch {
      // Keep polling until the server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => child.once("exit", resolve));
}

async function main() {
  run("npm", ["run", "build"]);

  const cliPath = path.join(repoRoot, "dist", "server", "src", "cli.js");
  const disabledDb = path.join(smokeHome, ".remcodex", "disabled-mcp.db");
  const disabledChild = spawn(
    process.execPath,
    [cliPath, "--no-open", "--port", "33119", "--db", disabledDb],
    {
      cwd: repoRoot,
      env: createCleanEnv({ REMCODEX_MCP_API_TOKEN: "" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let disabledStdout = "";
  let disabledStderr = "";
  disabledChild.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    disabledStdout += text;
    process.stdout.write(text);
  });
  disabledChild.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    disabledStderr += text;
    process.stderr.write(text);
  });

  try {
    const disabledHealth = await waitForHealth("http://127.0.0.1:33119/health", 15000);
    console.log(`Disabled-mode health check passed: ${JSON.stringify(disabledHealth)}`);

    const disabledResponse = await fetch("http://127.0.0.1:33119/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: {
            name: "remcodex-smoke",
            version: "1.0.0",
          },
          capabilities: {},
        },
      }),
    });
    if (disabledResponse.status !== 404) {
      throw new Error(`Expected MCP to be disabled without a token, got ${disabledResponse.status}`);
    }
  } finally {
    disabledChild.kill("SIGTERM");
    await waitForProcessExit(disabledChild);
  }

  console.log(`$ ${process.execPath} ${cliPath} --no-open --port ${smokePort} --db ${smokeDb}`);

  const runningChild = spawn(
    process.execPath,
    [cliPath, "--no-open", "--port", String(smokePort), "--db", smokeDb],
    {
      cwd: repoRoot,
      env: createCleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  runningChild.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    process.stdout.write(text);
  });
  runningChild.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(text);
  });

  try {
    const health = await waitForHealth(`http://127.0.0.1:${smokePort}/health`, 15000);
    console.log(`Health check passed: ${JSON.stringify(health)}`);

    const mcpUrl = `http://127.0.0.1:${smokePort}/mcp`;
    const unauthorized = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: {
            name: "remcodex-smoke",
            version: "1.0.0",
          },
          capabilities: {},
        },
      }),
    });
    if (unauthorized.status !== 401) {
      throw new Error(`Expected 401 without auth, got ${unauthorized.status}`);
    }

    const client = new Client({ name: "remcodex-smoke", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${authToken}`,
        },
      },
    });

    try {
      await client.connect(transport);
      const toolsList = await client.listTools();
      const toolNames = toolsList.tools.map((tool) => tool.name);
      if (!toolNames.includes("list-sessions")) {
        throw new Error(`Expected MCP tools response to include list-sessions, got ${JSON.stringify(toolNames)}`);
      }
    } finally {
      await transport.close().catch(() => null);
      await client.close().catch(() => null);
    }

    console.log("MCP auth smoke test passed.");
  } finally {
    runningChild.kill("SIGTERM");
    await new Promise((resolve) => runningChild.once("exit", resolve));
  }

  if (stderr.trim()) {
    console.log(`Captured stderr:\n${stderr}`);
  }
  if (disabledStderr.trim()) {
    console.log(`Captured disabled stderr:\n${disabledStderr}`);
  }
  if (disabledStdout.trim()) {
    console.log(`Captured disabled stdout:\n${disabledStdout}`);
  }

  console.log(`Smoke test passed: ${smokeRoot}`);
  console.log(`Isolated HOME: ${smokeHome}`);
  console.log(`Captured stdout:\n${stdout}`);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
