import assert from "node:assert/strict";
import test from "node:test";

import { hasWarmWorkspaceCache, shouldRefreshVisibleDetail } from "../web/utils/refresh-coordinator.js";

test("visibility refreshes are throttled without suppressing a later resume", () => {
  assert.equal(shouldRefreshVisibleDetail(2_000, 1_500, 900), false);
  assert.equal(shouldRefreshVisibleDetail(2_401, 1_500, 900), true);
});

test("workspace cache is warm when prior collection data can render immediately", () => {
  assert.equal(hasWarmWorkspaceCache([{ sessionId: "s1" }], []), true);
  assert.equal(hasWarmWorkspaceCache([], []), false);
  assert.equal(hasWarmWorkspaceCache(null, []), false);
});
