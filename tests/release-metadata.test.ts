import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");

test("release metadata is synchronized and documents the peer revision", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as { version: string; packages: { "": { version: string } } };
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const flake = fs.readFileSync(path.join(root, "flake.nix"), "utf8");

  assert.equal(packageJson.version, "0.1.0-beta.13");
  assert.equal(lockfile.version, packageJson.version);
  assert.equal(lockfile.packages[""].version, packageJson.version);
  assert.match(changelog, new RegExp(`^## ${packageJson.version.replaceAll(".", "\\.")} — `, "m"));
  assert.match(flake, new RegExp(`version = "${packageJson.version.replaceAll(".", "\\.")}";`));
});
