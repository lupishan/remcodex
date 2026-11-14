# Changelog

## Unreleased — upstream integration hardening

- Preserve approval/sandbox defaults for remote control; gate experimental TUI and cross-instance control.
- Authenticate browser, REST, and WebSocket access; bind localhost by default.
- Filter server credentials from workers and support peer administrator token rotation.
- Bound discovery, RPC, and proxy lifetimes; isolate remote thread events and preserve SSE framing.
- Reject cyclic session parents, respect agent environments, and compose profile prompts on the server once.
- Transcribe audio asynchronously and constrain optional Android navigation.


## 0.1.0-beta.13 — 2026-08-21

- Added capability-scoped peer communication with administrator grants, worker
  credentials, bounded envelopes, mailbox cursors, summaries, timelines, and
  audit records.
- Added isolated worker credential injection, disconnect-timeout dormancy, and
  runtime integration coverage.
- Added a versioned, bounded, non-triggering coordination digest contract with
  local durable delivery, administrator-authenticated MCP read/acknowledgement,
  idempotency, and scheduler retry behavior.

Merge, publication, and deployment are separate operational steps.
