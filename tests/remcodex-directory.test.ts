import assert from "node:assert/strict";
import test from "node:test";

import { parseRemCodexDirectoryInstances } from "../server/src/utils/remcodex-directory";

test("parses and normalizes configured RemCodex directory instances", () => {
  assert.deepEqual(
    parseRemCodexDirectoryInstances(
      JSON.stringify([
        { name: "Home", url: "https://remcodex.example/", description: "Primary workspace" },
        { name: "Lab", url: "http://lab.example" },
      ]),
    ),
    [
      { name: "Home", url: "https://remcodex.example", description: "Primary workspace" },
      { name: "Lab", url: "http://lab.example", description: null },
    ],
  );
});

test("rejects malformed directory instance configuration", () => {
  assert.throws(
    () => parseRemCodexDirectoryInstances(JSON.stringify([{ name: "Home", url: "ftp://example.com" }])),
    /must use http or https/,
  );
  assert.throws(
    () => parseRemCodexDirectoryInstances("not-json"),
    /must contain valid JSON/,
  );
});
