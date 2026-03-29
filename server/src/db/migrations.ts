import { readFileSync } from "node:fs";
import path from "node:path";

import type { DatabaseClient } from "./client";

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
  const schemaFile = path.join(process.cwd(), "server", "src", "db", "schema.sql");
  const schema = readFileSync(schemaFile, "utf8");
  db.exec(schema);

  ensureColumn(db, "sessions", "source_kind", "TEXT NOT NULL DEFAULT 'native'");
  ensureColumn(db, "sessions", "source_rollout_path", "TEXT");
  ensureColumn(db, "sessions", "source_thread_id", "TEXT");
  ensureColumn(db, "sessions", "source_sync_cursor", "INTEGER");
  ensureColumn(db, "sessions", "source_last_synced_at", "TEXT");
  ensureColumn(db, "sessions", "source_rollout_has_open_turn", "INTEGER NOT NULL DEFAULT 0");

  // Older imports mapped external open turns to status=running; that is not local runner state.
  db.exec(
    `UPDATE sessions
     SET status = 'waiting_input'
     WHERE source_kind = 'imported_rollout'
       AND pid IS NULL
       AND status = 'running'`,
  );
}
