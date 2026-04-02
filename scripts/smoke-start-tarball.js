const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const npmCache = path.join(os.tmpdir(), "remcodex-npm-cache");
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-start-smoke-"));
const smokeHome = path.join(smokeRoot, "home");
const smokeDb = path.join(smokeHome, ".remcodex", "smoke-start.db");
const smokePort = 33117;
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

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await requestJson(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  run("npm", ["run", "build"]);
  run("npm", ["pack"]);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const tarball = path.join(repoRoot, `remcodex-${packageJson.version}.tgz`);

  fs.writeFileSync(
    path.join(smokeRoot, "package.json"),
    JSON.stringify({ name: "remcodex-start-smoke", private: true, version: "1.0.0" }, null, 2),
  );

  run("npm", ["install", tarball], smokeRoot, createCleanEnv());

  const cliPath = path.join(smokeRoot, "node_modules", ".bin", "remcodex");
  console.log(`$ ${cliPath} --no-open --port ${smokePort} --db ${smokeDb}`);

  const child = spawn(
    cliPath,
    ["--no-open", "--port", String(smokePort), "--db", smokeDb],
    {
      cwd: smokeRoot,
      env: createCleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(text);
  });

  try {
    const health = await waitForHealth(`http://127.0.0.1:${smokePort}/health`, 15000);
    console.log(`Health check passed: ${JSON.stringify(health)}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }

  if (stderr.trim()) {
    console.log(`Captured stderr:\n${stderr}`);
  }

  console.log(`Start smoke test passed: ${smokeRoot}`);
  console.log(`Isolated HOME: ${smokeHome}`);
  console.log(`Captured stdout:\n${stdout}`);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const tarball = path.join(repoRoot, `remcodex-${packageJson.version}.tgz`);
    if (fs.existsSync(tarball)) {
      fs.unlinkSync(tarball);
    }
  });
