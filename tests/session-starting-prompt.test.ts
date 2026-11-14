import assert from "node:assert/strict";
import test from "node:test";

import { renderComposerStartingPromptBanner } from "../web/components/composer.js";
import { composeMessageContentWithStartingPrompt } from "../web/utils/session-starting-prompt.js";

test("starting prompt banner truncates visually while preserving the full prompt on hover", () => {
  const startingPrompt = "Inspect the current session state and preserve this complete prompt.";
  const rendered = renderComposerStartingPromptBanner({ startingPrompt });

  assert.match(rendered, /class="composer-starting-prompt-banner-text"/);
  assert.match(rendered, new RegExp(`title="${startingPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(rendered, new RegExp(startingPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("starting prompt is prepended to the first submitted message", () => {
  assert.equal(
    composeMessageContentWithStartingPrompt(
      "Inspect the current session state.",
      "Use RemCodex to keep the workspace in view.",
    ),
    "Use RemCodex to keep the workspace in view.\n\nInspect the current session state.",
  );
});

test("starting prompt is ignored when no prompt is configured", () => {
  assert.equal(
    composeMessageContentWithStartingPrompt("Inspect the current session state.", ""),
    "Inspect the current session state.",
  );
});
