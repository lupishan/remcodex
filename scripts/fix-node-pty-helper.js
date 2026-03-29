const fs = require("node:fs");
const path = require("node:path");

function fixNodePtyHelper() {
  if (process.platform !== "darwin") {
    return;
  }

  let packageJsonPath;
  try {
    packageJsonPath = require.resolve("node-pty/package.json");
  } catch {
    return;
  }

  const helperPath = path.join(
    path.dirname(packageJsonPath),
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );

  if (!fs.existsSync(helperPath)) {
    return;
  }

  const currentMode = fs.statSync(helperPath).mode & 0o777;
  const nextMode = currentMode | 0o111;

  if (currentMode !== nextMode) {
    fs.chmodSync(helperPath, nextMode);
    console.log(`[postinstall] fixed executable bit: ${helperPath}`);
  }
}

fixNodePtyHelper();
