CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  codex_thread_id TEXT,
  source_kind TEXT NOT NULL DEFAULT 'native',
  source_rollout_path TEXT,
  source_thread_id TEXT,
  source_sync_cursor INTEGER,
  source_last_synced_at TEXT,
  source_rollout_has_open_turn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  message_id TEXT,
  call_id TEXT,
  request_id TEXT,
  phase TEXT,
  stream TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session_seq ON session_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_events_type_seq ON session_events(session_id, event_type, seq);
CREATE INDEX IF NOT EXISTS idx_session_events_message_id ON session_events(session_id, message_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_events_call_id ON session_events(session_id, call_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_events_request_id ON session_events(session_id, request_id, seq);
