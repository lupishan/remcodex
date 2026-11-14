import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRemCodexSessionUrl,
  resolveRemCodexPublicBaseUrl,
} from "../server/src/utils/remcodex-url";

test("normalizes a configured RemCodex hostname or public URL", () => {
  assert.equal(resolveRemCodexPublicBaseUrl("remcodex.example/"), "https://remcodex.example");
  assert.equal(resolveRemCodexPublicBaseUrl("https://remcodex.example/app/"), "https://remcodex.example/app");
  assert.equal(resolveRemCodexPublicBaseUrl(""), null);
});

test("uses the public hostname for session links and keeps relative fallback", () => {
  assert.equal(
    buildRemCodexSessionUrl("session/one", "https://remcodex.example"),
    "https://remcodex.example/#/sessions/session%2Fone",
  );
  assert.equal(buildRemCodexSessionUrl("session-one", null), "/#/sessions/session-one");
});

test("rejects unsupported public hostname protocols", () => {
  assert.throws(
    () => resolveRemCodexPublicBaseUrl("ftp://remcodex.example"),
    /must use http or https/,
  );
});
