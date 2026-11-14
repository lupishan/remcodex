import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { DatabaseClient } from "./client";

function isPackageRoot(root: string): boolean {
  return existsSync(path.join(root, "package.json")) && existsSync(path.join(root, "web", "index.html"));
}

function resolvePackageRoot(startDir = __dirname): string {
  let current = path.resolve(startDir);

  while (true) {
    if (isPackageRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return process.cwd();
}

function resolveSchemaFile(): string {
  const packageRoot = resolvePackageRoot();
  const candidates = [
    path.join(packageRoot, "server", "src", "db", "schema.sql"),
    path.join(packageRoot, "dist", "server", "src", "db", "schema.sql"),
  ];

  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error(`Database schema file not found. Tried: ${candidates.join(", ")}`);
  }

  return resolved;
}

function ensureColumn(
  db: DatabaseClient,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function runMigrations(db: DatabaseClient): void {
  const schemaFile = resolveSchemaFile();
  const schema = readFileSync(schemaFile, "utf8");
  db.exec(schema);

  ensureColumn(db, "sessions", "source_kind", "TEXT NOT NULL DEFAULT 'native'");
  ensureColumn(db, "agent_profiles", "agent_environment", "TEXT");
  ensureColumn(db, "sessions", "parent_session_id", "TEXT");
  ensureColumn(db, "sessions", "agent_environment", "TEXT");
  ensureColumn(db, "sessions", "starting_prompt", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "sessions", "description", "TEXT");
  ensureColumn(db, "sessions", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "sessions", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "sessions", "source_rollout_path", "TEXT");
  ensureColumn(db, "sessions", "source_thread_id", "TEXT");
  ensureColumn(db, "sessions", "source_sync_cursor", "INTEGER");
  ensureColumn(db, "sessions", "source_last_synced_at", "TEXT");
  ensureColumn(db, "sessions", "source_rollout_has_open_turn", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "app_server_id", "TEXT");
  ensureColumn(db, "sessions", "app_server_endpoint", "TEXT");
  ensureColumn(db, "sessions", "app_server_pid", "INTEGER");
  ensureColumn(db, "peer_credentials", "last_seen_at", "TEXT NOT NULL DEFAULT ''");

  // Older imports mapped external open turns to status=running; that is not local runner state.
  db.exec(
    `UPDATE sessions
     SET status = 'waiting_input'
     WHERE source_kind = 'imported_rollout'
       AND pid IS NULL
       AND status = 'running'`,
  );
}
