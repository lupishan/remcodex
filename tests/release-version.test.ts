import test from "node:test";
import assert from "node:assert/strict";
import { readReleaseVersion, validateReleaseTag } from "../mobile/scripts/release-version.mjs";

test("release version contract is valid and matches the release tag", () => {
  const release = readReleaseVersion();
  assert.deepEqual(release, { versionName: "0.1.0", versionCode: 1 });
  assert.deepEqual(validateReleaseTag("v0.1.0", release), release);
});

test("release tag validation rejects mismatches", () => {
  assert.throws(() => validateReleaseTag("v0.1.1"), /must exactly match/);
});
