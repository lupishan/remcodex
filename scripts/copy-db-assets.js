const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(repoRoot, "server", "src", "db", "schema.sql");
const targetPath = path.join(repoRoot, "dist", "server", "src", "db", "schema.sql");

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.copyFileSync(sourcePath, targetPath);

console.log(`[build] copied ${path.relative(repoRoot, sourcePath)} -> ${path.relative(repoRoot, targetPath)}`);
