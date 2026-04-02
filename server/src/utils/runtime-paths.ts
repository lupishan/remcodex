import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function isPackageRoot(root: string): boolean {
  return (
    existsSync(path.join(root, "package.json")) &&
    existsSync(path.join(root, "web", "index.html"))
  );
}

export function resolvePackageRoot(startDir = __dirname): string {
  let current = path.resolve(startDir);

  while (true) {
    if (isPackageRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return process.cwd();
}

export function resolveDefaultDatabasePath(): string {
  return path.join(homedir(), ".remcodex", "remcodex.db");
}
