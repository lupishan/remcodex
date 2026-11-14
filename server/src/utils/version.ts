import { readFileSync } from "node:fs";
import path from "node:path";

import { resolvePackageRoot } from "./runtime-paths";

export function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(resolvePackageRoot(), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
