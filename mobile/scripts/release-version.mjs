import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const VERSION_NAME = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function readReleaseVersion(path = new URL("../version.properties", import.meta.url)) {
  const values = Object.fromEntries(
    fs.readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`Invalid release-version line: ${line}`);
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );

  if (!VERSION_NAME.test(values.versionName ?? "")) {
    throw new Error("versionName must be a semantic release version");
  }
  if (!/^[1-9]\d*$/.test(values.versionCode ?? "")) {
    throw new Error("versionCode must be a positive decimal integer");
  }
  return { versionName: values.versionName, versionCode: Number(values.versionCode) };
}

export function validateReleaseTag(tag, release = readReleaseVersion()) {
  if (tag !== `v${release.versionName}`) {
    throw new Error(`tag ${tag} must exactly match v${release.versionName}`);
  }
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const release = validateReleaseTag(process.argv[2] ?? "", readReleaseVersion());
  console.log(`versionName=${release.versionName}`);
  console.log(`versionCode=${release.versionCode}`);
}
