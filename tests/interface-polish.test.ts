import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const styles = fs.readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");

test("interactive controls expose a consistent keyboard focus ring", () => {
  assert.match(
    styles,
    /:where\(button, input, select, textarea, a\):focus-visible\s*\{[^}]*outline:\s*3px solid rgba\(188, 90, 48, 0\.42\);[^}]*outline-offset:\s*3px;/s,
  );
});

test("specialized composer and toolbar controls retain visible keyboard focus", () => {
  assert.match(
    styles,
    /\.composer-meta-input:focus-visible,[\s\S]*?\.composer-action-fab:focus-visible\s*\{[^}]*outline:\s*3px solid rgba\(188, 90, 48, 0\.42\);[^}]*outline-offset:\s*3px;/s,
  );
});
