CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  starting_prompt TEXT NOT NULL,
  default_directory TEXT NOT NULL,
  agent_environment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  codex_thread_id TEXT,
  parent_session_id TEXT,
  agent_environment TEXT,
  starting_prompt TEXT NOT NULL DEFAULT '',
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_kind TEXT NOT NULL DEFAULT 'native',
  source_rollout_path TEXT,
  source_thread_id TEXT,
  source_sync_cursor INTEGER,
  source_last_synced_at TEXT,
  source_rollout_has_open_turn INTEGER NOT NULL DEFAULT 0,
  app_server_id TEXT,
  app_server_endpoint TEXT,
  app_server_pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
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

CREATE TABLE IF NOT EXISTS peer_credentials (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  lease_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dormant_at TEXT
);

CREATE TABLE IF NOT EXISTS peer_grants (
  id TEXT PRIMARY KEY,
  source_worker_id TEXT NOT NULL,
  target_worker_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS peer_messages (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  sender_worker_id TEXT NOT NULL,
  recipient_worker_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (grant_id, idempotency_key),
  FOREIGN KEY (grant_id) REFERENCES peer_grants(id)
);

CREATE TABLE IF NOT EXISTS peer_read_cursors (
  grant_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  last_message_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (grant_id, worker_id),
  FOREIGN KEY (grant_id) REFERENCES peer_grants(id)
);

CREATE TABLE IF NOT EXISTS peer_summaries (
  grant_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (grant_id) REFERENCES peer_grants(id)
);

CREATE TABLE IF NOT EXISTS peer_audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_worker_id TEXT,
  subject_id TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS peer_orchestrator_digests (
  digest_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  recipient_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  attempts INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_peer_messages_grant_created ON peer_messages(grant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_peer_audit_created ON peer_audit_events(created_at, id);
CREATE INDEX IF NOT EXISTS idx_peer_orchestrator_digests_status ON peer_orchestrator_digests(status, created_at);
