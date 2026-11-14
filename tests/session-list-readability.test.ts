import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const styles = fs.readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");

test("session list titles use two-line wrapping instead of single-line truncation", () => {
  assert.match(styles, /\.workspace-session-item-title\s*\{[^}]*white-space:\s*normal;/s);
  assert.match(styles, /\.workspace-session-item-title\s*\{[^}]*-webkit-line-clamp:\s*2;/s);
  assert.match(styles, /\.session-tree-row \.record-title-row h3\s*\{[^}]*-webkit-line-clamp:\s*2;/s);
});
