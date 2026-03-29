import { accessSync, constants } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveExecutable(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.includes(path.sep)) {
    const candidate = path.resolve(trimmed);
    return isExecutable(candidate) ? candidate : trimmed;
  }

  const envPath = process.env.PATH ?? "";
  for (const root of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(root, trimmed);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  try {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const resolved = execFileSync(
      shell,
      ["-lc", `command -v ${shellQuote(trimmed)}`],
      { encoding: "utf8" },
    ).trim();

    return resolved || trimmed;
  } catch {
    return trimmed;
  }
}
