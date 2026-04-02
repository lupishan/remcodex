const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const npmCache = path.join(os.tmpdir(), "remcodex-npm-cache");
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-smoke-"));
const smokeHome = path.join(smokeRoot, "home");
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

try {
  run("npm", ["run", "build"]);
  run("npm", ["pack"]);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const tarball = path.join(repoRoot, `remcodex-${packageJson.version}.tgz`);

  fs.writeFileSync(
    path.join(smokeRoot, "package.json"),
    JSON.stringify({ name: "remcodex-smoke", private: true, version: "1.0.0" }, null, 2),
  );

  run("npm", ["install", tarball], smokeRoot, createCleanEnv());
  run(
    path.join(smokeRoot, "node_modules", ".bin", "remcodex"),
    ["doctor", "--db", path.join(smokeHome, ".remcodex", "smoke.db")],
    smokeRoot,
    createCleanEnv(),
  );

  console.log(`Smoke test passed: ${smokeRoot}`);
  console.log(`Isolated HOME: ${smokeHome}`);
} finally {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const tarball = path.join(repoRoot, `remcodex-${packageJson.version}.tgz`);
  if (fs.existsSync(tarball)) {
    fs.unlinkSync(tarball);
  }
}
