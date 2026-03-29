import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";

export function ensureNodePtyHelperExecutable(): void {
  if (process.platform !== "darwin") {
    return;
  }

  let packageJsonPath: string;
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

  if (!existsSync(helperPath)) {
    return;
  }

  const currentMode = statSync(helperPath).mode & 0o777;
  const nextMode = currentMode | 0o111;
  if (currentMode !== nextMode) {
    chmodSync(helperPath, nextMode);
  }
}
