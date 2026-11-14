import crypto from "node:crypto";

import type { DatabaseClient } from "../db/client";
import { AppError } from "../utils/errors";
import type { CoordinationDigest } from "./peer-digests";
import { ORCHESTRATOR_DIGEST_VERSION, ORCHESTRATOR_RECIPIENT_ID, PEER_DIGEST_LIMITS } from "./peer-digests";

export const PEER_SCOPES = {
  adminGrant: "admin.peer.grant",
  adminRevoke: "admin.peer.revoke",
  adminAudit: "admin.peer.audit",
  adminDigest: "admin.peer.digest",
  workerMailbox: "worker.peer.mailbox",
  workerSummary: "worker.peer.summary",
  workerTimeline: "worker.peer.timeline",
  workerDigest: "worker.peer.digest",
} as const;

export type PeerScope = (typeof PEER_SCOPES)[keyof typeof PEER_SCOPES];
export const PEER_LIMITS = Object.freeze({
  maxPayloadBytes: 16 * 1024,
  maxMessagesPerRead: 100,
  maxTimelineEntries: 100,
  maxStoredMessagesPerGrant: 1_000,
  maxSummaryBytes: 8 * 1024,
  leaseMs: 15 * 60 * 1_000,
  disconnectTimeoutMs: 2 * 60 * 1_000,
});

type StoredCredential = {
  id: string;
  worker_id: string;
  session_id: string;
  scopes_json: string;
  status: "active" | "dormant";
  lease_expires_at: string;
  last_seen_at: string;
};

type Actor = StoredCredential & { scopes: Set<string> };

export interface PeerEnvelopeInput {
  recipientWorkerId: string;
  workPackageId: string;
  messageType: string;
  timestamp: string;
  idempotencyKey: string;
  payload: unknown;
}

export interface PeerEnvelope extends PeerEnvelopeInput {
  id: string;
  senderWorkerId: string;
  createdAt: string;
}

export interface OrchestratorDigestDelivery {
  digestId: string;
  version: number;
  recipientId: string;
  status: "accepted" | "acknowledged";
  attempts: number;
  createdAt: string;
  acknowledgedAt: string | null;
  digest: CoordinationDigest;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class PeerCommunicationService {
  private lifecycleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseClient,
    private readonly clock: () => Date = () => new Date(),
    adminToken?: string,
  ) {
    if (adminToken?.trim()) {
      const token = adminToken.trim();
      this.db.prepare(`INSERT OR IGNORE INTO peer_credentials (id, worker_id, session_id, token_hash, scopes_json, lease_expires_at, last_seen_at) VALUES ('peer-admin', 'administrator', 'server', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, scopes_json = excluded.scopes_json, status = 'active', lease_expires_at = excluded.lease_expires_at, last_seen_at = excluded.last_seen_at, dormant_at = NULL`).run(
        hashToken(token),
        JSON.stringify([PEER_SCOPES.adminGrant, PEER_SCOPES.adminRevoke, PEER_SCOPES.adminAudit, PEER_SCOPES.adminDigest]),
        new Date(this.clock().getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
        this.clock().toISOString(),
      );
    } else {
      this.db.prepare("DELETE FROM peer_credentials WHERE id = 'peer-admin'").run();
    }
  }

  issueCredential(input: { workerId: string; sessionId: string; scopes: PeerScope[]; leaseMs?: number }): { credentialId: string; token: string } {
    if (!input.workerId.trim() || !input.sessionId.trim()) throw new AppError(400, "Worker and session identity are required.");
    const scopes = [...new Set(input.scopes)];
    if (!scopes.length || scopes.some((scope) => !Object.values(PEER_SCOPES).includes(scope))) {
      throw new AppError(400, "Credential scopes are invalid.");
    }
    const hasAdminScope = scopes.some((scope) => scope.startsWith("admin."));
    const hasWorkerScope = scopes.some((scope) => scope.startsWith("worker."));
    if (hasAdminScope && hasWorkerScope) {
      throw new AppError(400, "Administrator and worker scopes must use separate credentials.");
    }
    const token = `peer_${crypto.randomBytes(32).toString("base64url")}`;
    const credentialId = id("cred");
    const expires = new Date(this.clock().getTime() + (input.leaseMs ?? PEER_LIMITS.leaseMs)).toISOString();
    this.db.prepare(`INSERT INTO peer_credentials (id, worker_id, session_id, token_hash, scopes_json, lease_expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(credentialId, input.workerId, input.sessionId, hashToken(token), JSON.stringify(scopes), expires, this.clock().toISOString());
    this.audit("credential.issued", input.workerId, credentialId, { scopes, sessionId: input.sessionId });
    return { credentialId, token };
  }

  issueWorkerCredential(actor: Actor, input: { workerId: string; sessionId: string; scopes: PeerScope[]; leaseMs?: number }): { credentialId: string; token: string } {
    this.require(actor, PEER_SCOPES.adminGrant);
    const credential = this.issueCredential(input);
    this.audit("credential.issued_by_admin", actor.worker_id, credential.credentialId, { workerId: input.workerId, sessionId: input.sessionId });
    return credential;
  }

  authenticate(token: string): Actor {
    const row = this.db.prepare(`SELECT * FROM peer_credentials WHERE token_hash = ?`).get(hashToken(token)) as StoredCredential | undefined;
    if (!row || row.status !== "active") {
      throw new AppError(403, "Peer credential is inactive or expired.");
    }
    if (Date.parse(row.lease_expires_at) <= this.clock().getTime()) {
      this.db.prepare(`UPDATE peer_credentials SET status = 'dormant', dormant_at = ? WHERE id = ? AND status = 'active'`).run(now(), row.id);
      this.audit("credential.dormant", row.worker_id, row.id, { reason: "lease_expired" });
      throw new AppError(403, "Peer credential is inactive or expired.");
    }
    this.db.prepare(`UPDATE peer_credentials SET last_seen_at = ? WHERE id = ? AND status = 'active'`).run(this.clock().toISOString(), row.id);
    return { ...row, scopes: new Set(JSON.parse(row.scopes_json) as string[]) };
  }

  sweepDisconnectedCredentials(): number {
    const cutoff = this.clock().getTime() - PEER_LIMITS.disconnectTimeoutMs;
    const rows = this.db.prepare(`SELECT id, session_id FROM peer_credentials WHERE status = 'active' AND session_id != 'server' AND (last_seen_at = '' OR last_seen_at < ? OR lease_expires_at <= ?)`).all(new Date(cutoff).toISOString(), this.clock().toISOString()) as Array<{ id: string; session_id: string }>;
    for (const row of rows) this.dormantSession(row.session_id, "disconnect_timeout_or_lease_expiry");
    return rows.length;
  }

  startLifecycleMonitor(intervalMs = 30_000): void {
    if (this.lifecycleTimer) return;
    this.lifecycleTimer = setInterval(() => {
      this.sweepDisconnectedCredentials();
    }, intervalMs);
    this.lifecycleTimer.unref();
  }

  stopLifecycleMonitor(): void {
    if (!this.lifecycleTimer) return;
    clearInterval(this.lifecycleTimer);
    this.lifecycleTimer = null;
  }

  grant(actor: Actor, input: { sourceWorkerId: string; targetWorkerId: string; workPackageId: string; scope: PeerScope }): { grantId: string } {
    this.require(actor, PEER_SCOPES.adminGrant);
    if (!input.sourceWorkerId || !input.targetWorkerId || !input.workPackageId || !input.scope.startsWith("worker.")) {
      throw new AppError(400, "Directed grant identity, work package, and worker scope are required.");
    }
    const grantId = id("grant");
    this.db.prepare(`INSERT INTO peer_grants (id, source_worker_id, target_worker_id, work_package_id, scope) VALUES (?, ?, ?, ?, ?)`)
      .run(grantId, input.sourceWorkerId, input.targetWorkerId, input.workPackageId, input.scope);
    this.audit("grant.created", actor.worker_id, grantId, input);
    return { grantId };
  }

  revoke(actor: Actor, grantId: string): void {
    this.require(actor, PEER_SCOPES.adminRevoke);
    const result = this.db.prepare(`UPDATE peer_grants SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'`).run(now(), grantId) as { changes: number };
    if (!result.changes) throw new AppError(404, "Active peer grant not found.");
    this.audit("grant.revoked", actor.worker_id, grantId, {});
  }

  appendMessage(token: string, input: PeerEnvelopeInput): PeerEnvelope {
    const actor = this.authenticate(token);
    this.require(actor, PEER_SCOPES.workerMailbox);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(input.messageType) || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) {
      throw new AppError(400, "Message type or idempotency key is invalid.");
    }
    if (!Number.isFinite(Date.parse(input.timestamp)) || jsonBytes(input.payload) > PEER_LIMITS.maxPayloadBytes) {
      throw new AppError(400, "Message timestamp or payload is invalid or exceeds the configured bound.");
    }
    const grant = this.authorizedGrant(actor, input.recipientWorkerId, input.workPackageId, PEER_SCOPES.workerMailbox);
    const existing = this.db.prepare(`SELECT * FROM peer_messages WHERE grant_id = ? AND idempotency_key = ?`).get(grant.id, input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.payload_json !== JSON.stringify(input.payload)) throw new AppError(409, "Idempotency key was already used with another payload.");
      return this.deserializeMessage(existing);
    }
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM peer_messages WHERE grant_id = ?`).get(grant.id) as { count: number };
    if (count.count >= PEER_LIMITS.maxStoredMessagesPerGrant) throw new AppError(413, "Peer mailbox retention bound reached.");
    const messageId = id("msg");
    this.db.prepare(`INSERT INTO peer_messages (id, grant_id, sender_worker_id, recipient_worker_id, work_package_id, message_type, idempotency_key, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(messageId, grant.id, actor.worker_id, input.recipientWorkerId, input.workPackageId, input.messageType, input.idempotencyKey, JSON.stringify(input.payload));
    this.audit("message.appended", actor.worker_id, messageId, { grantId: grant.id, messageType: input.messageType });
    return { ...input, id: messageId, senderWorkerId: actor.worker_id, createdAt: now() };
  }

  readMailbox(token: string, grantId: string, limit: number = PEER_LIMITS.maxMessagesPerRead): { messages: PeerEnvelope[]; nextCursor: string | null } {
    const actor = this.authenticate(token);
    this.require(actor, PEER_SCOPES.workerMailbox);
    const grant = this.authorizedGrant(actor, undefined, undefined, PEER_SCOPES.workerMailbox, grantId, true);
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), PEER_LIMITS.maxMessagesPerRead);
    const cursor = this.db.prepare(`SELECT last_message_id FROM peer_read_cursors WHERE grant_id = ? AND worker_id = ?`).get(grant.id, actor.worker_id) as { last_message_id: string | null } | undefined;
    const lastMessageId = cursor?.last_message_id ?? null;
    const cursorMessage = lastMessageId
      ? this.db.prepare(`SELECT created_at FROM peer_messages WHERE id = ? AND grant_id = ?`).get(lastMessageId, grant.id) as { created_at: string } | undefined
      : undefined;
    const rows = cursorMessage
      ? this.db.prepare(`SELECT * FROM peer_messages WHERE grant_id = ? AND recipient_worker_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?`).all(grant.id, actor.worker_id, cursorMessage.created_at, cursorMessage.created_at, lastMessageId, safeLimit) as Array<Record<string, unknown>>
      : this.db.prepare(`SELECT * FROM peer_messages WHERE grant_id = ? AND recipient_worker_id = ? ORDER BY created_at, id LIMIT ?`).all(grant.id, actor.worker_id, safeLimit) as Array<Record<string, unknown>>;
    const messages = rows.map((row) => this.deserializeMessage(row));
    const nextCursor = messages.at(-1)?.id ?? null;
    if (nextCursor) this.db.prepare(`INSERT INTO peer_read_cursors (grant_id, worker_id, last_message_id) VALUES (?, ?, ?) ON CONFLICT(grant_id, worker_id) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(grant.id, actor.worker_id, nextCursor);
    this.audit("mailbox.read", actor.worker_id, grant.id, { count: messages.length, limit: safeLimit });
    return { messages, nextCursor };
  }

  publishSummary(token: string, grantId: string, summary: unknown): void {
    const actor = this.authenticate(token);
    this.require(actor, PEER_SCOPES.workerSummary);
    const grant = this.authorizedGrant(actor, undefined, undefined, PEER_SCOPES.workerSummary, grantId, true);
    if (jsonBytes(summary) > PEER_LIMITS.maxSummaryBytes) throw new AppError(413, "Summary exceeds the configured bound.");
    this.db.prepare(`INSERT INTO peer_summaries (grant_id, worker_id, summary_json) VALUES (?, ?, ?) ON CONFLICT(grant_id) DO UPDATE SET worker_id = excluded.worker_id, summary_json = excluded.summary_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(grant.id, actor.worker_id, JSON.stringify(summary));
    this.audit("summary.published", actor.worker_id, grant.id, {});
  }

  readSummary(token: string, grantId: string): unknown | null {
    const actor = this.authenticate(token);
    this.require(actor, PEER_SCOPES.workerSummary);
    const grant = this.authorizedGrant(actor, undefined, undefined, PEER_SCOPES.workerSummary, grantId, true);
    const row = this.db.prepare(`SELECT summary_json FROM peer_summaries WHERE grant_id = ?`).get(grant.id) as { summary_json: string } | undefined;
    this.audit("summary.read", actor.worker_id, grant.id, {});
    return row ? JSON.parse(row.summary_json) : null;
  }

  readTimeline(token: string, grantId: string, limit: number = PEER_LIMITS.maxTimelineEntries): PeerEnvelope[] {
    const actor = this.authenticate(token);
    this.require(actor, PEER_SCOPES.workerTimeline);
    const grant = this.authorizedGrant(actor, undefined, undefined, PEER_SCOPES.workerTimeline, grantId, true);
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), PEER_LIMITS.maxTimelineEntries);
    const rows = this.db.prepare(`SELECT * FROM peer_messages WHERE grant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(grant.id, safeLimit) as Array<Record<string, unknown>>;
    this.audit("timeline.read", actor.worker_id, grant.id, { limit: safeLimit });
    return rows.reverse().map((row) => this.deserializeMessage(row));
  }

  deliverOrchestratorDigest(digest: CoordinationDigest): OrchestratorDigestDelivery {
    if (digest.version !== ORCHESTRATOR_DIGEST_VERSION || digest.recipientId !== ORCHESTRATOR_RECIPIENT_ID) {
      throw new AppError(400, "Orchestrator digest contract is invalid.");
    }
    if (Buffer.byteLength(JSON.stringify(digest), "utf8") > PEER_DIGEST_LIMITS.maxBytes) {
      throw new AppError(413, "Orchestrator digest exceeds the configured bound.");
    }
    const existing = this.db.prepare(`SELECT * FROM peer_orchestrator_digests WHERE digest_id = ?`).get(digest.digestId) as Record<string, unknown> | undefined;
    if (existing) return this.deserializeDigestDelivery(existing);
    const timestamp = this.clock().toISOString();
    this.db.prepare(`INSERT INTO peer_orchestrator_digests (digest_id, version, recipient_id, payload_json, status, attempts, last_attempt_at) VALUES (?, ?, ?, ?, 'accepted', 1, ?)`).run(
      digest.digestId,
      digest.version,
      digest.recipientId,
      JSON.stringify(digest),
      timestamp,
    );
    this.audit("digest.accepted", null, digest.digestId, { recipientId: digest.recipientId, entryCount: digest.entries.length });
    return this.deserializeDigestDelivery(this.db.prepare(`SELECT * FROM peer_orchestrator_digests WHERE digest_id = ?`).get(digest.digestId) as Record<string, unknown>);
  }

  readOrchestratorDigests(token: string, limit = 100): OrchestratorDigestDelivery[] {
    const actor = this.authenticate(token);
    this.require(actor, PEER_SCOPES.adminDigest);
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const rows = this.db.prepare(`SELECT * FROM peer_orchestrator_digests WHERE status != 'acknowledged' ORDER BY created_at, digest_id LIMIT ?`).all(safeLimit) as Array<Record<string, unknown>>;
    this.audit("digest.read", actor.worker_id, null, { count: rows.length, limit: safeLimit });
    return rows.map((row) => this.deserializeDigestDelivery(row));
  }

  acknowledgeOrchestratorDigest(token: string, digestId: string): OrchestratorDigestDelivery {
    const actor = this.authenticate(token);
    this.require(actor, PEER_SCOPES.adminDigest);
    const timestamp = this.clock().toISOString();
    const result = this.db.prepare(`UPDATE peer_orchestrator_digests SET status = 'acknowledged', acknowledged_at = ? WHERE digest_id = ? AND status != 'acknowledged'`).run(timestamp, digestId) as { changes: number };
    const row = this.db.prepare(`SELECT * FROM peer_orchestrator_digests WHERE digest_id = ?`).get(digestId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "Orchestrator digest not found.");
    if (result.changes) this.audit("digest.acknowledged", actor.worker_id, digestId, {});
    return this.deserializeDigestDelivery(row);
  }

  dormantSession(sessionId: string, reason: string): void {
    const result = this.db.prepare(`UPDATE peer_credentials SET status = 'dormant', dormant_at = ? WHERE session_id = ? AND status = 'active'`).run(now(), sessionId) as { changes: number };
    if (result.changes) {
      const workers = this.db.prepare(`SELECT DISTINCT worker_id FROM peer_credentials WHERE session_id = ?`).all(sessionId) as Array<{ worker_id: string }>;
      for (const worker of workers) {
        this.db.prepare(`UPDATE peer_grants SET status = 'dormant' WHERE status = 'active' AND (source_worker_id = ? OR target_worker_id = ?)`).run(worker.worker_id, worker.worker_id);
      }
      this.audit("credential.dormant", null, sessionId, { reason });
      this.audit("grant.dormant", null, sessionId, { reason, workerCount: workers.length });
    }
  }

  reauthorize(actor: Actor, input: { workerId: string; sessionId: string; scopes: PeerScope[] }): { credentialId: string; token: string } {
    this.require(actor, PEER_SCOPES.adminGrant);
    const credential = this.issueCredential(input);
    this.audit("credential.reauthorized", actor.worker_id, credential.credentialId, { workerId: input.workerId, sessionId: input.sessionId });
    return credential;
  }

  private require(actor: Actor, scope: PeerScope): void {
    if (!actor.scopes.has(scope)) {
      this.audit("authorization.denied", actor.worker_id, null, { scope });
      throw new AppError(403, "Peer operation is not authorized.");
    }
  }

  private authorizedGrant(actor: Actor, recipientWorkerId: string | undefined, workPackageId: string | undefined, scope: PeerScope, grantId?: string, allowTarget = false): { id: string; source_worker_id: string; target_worker_id: string; work_package_id: string } {
    const row = this.db.prepare(`SELECT * FROM peer_grants WHERE id = ? AND status = 'active' AND scope = ?`).get(grantId ?? "", scope) as { id: string; source_worker_id: string; target_worker_id: string; work_package_id: string } | undefined;
    const candidate = row ?? (recipientWorkerId && workPackageId
      ? this.db.prepare(`SELECT * FROM peer_grants WHERE source_worker_id = ? AND target_worker_id = ? AND work_package_id = ? AND status = 'active' AND scope = ? ORDER BY created_at DESC LIMIT 1`).get(actor.worker_id, recipientWorkerId, workPackageId, scope) as typeof row | undefined
      : undefined);
    const actorMatches = candidate && (candidate.source_worker_id === actor.worker_id || (allowTarget && candidate.target_worker_id === actor.worker_id));
    if (!candidate || !actorMatches || (recipientWorkerId && candidate.target_worker_id !== recipientWorkerId) || (workPackageId && candidate.work_package_id !== workPackageId)) {
      this.audit("authorization.denied", actor.worker_id, grantId ?? null, { scope, recipientWorkerId, workPackageId });
      throw new AppError(403, "Peer grant is not authorized.");
    }
    return candidate;
  }

  private deserializeMessage(row: Record<string, unknown>): PeerEnvelope {
    return {
      id: String(row.id),
      senderWorkerId: String(row.sender_worker_id),
      recipientWorkerId: String(row.recipient_worker_id),
      workPackageId: String(row.work_package_id),
      messageType: String(row.message_type),
      timestamp: String(row.created_at),
      idempotencyKey: String(row.idempotency_key),
      payload: JSON.parse(String(row.payload_json)),
      createdAt: String(row.created_at),
    };
  }

  private deserializeDigestDelivery(row: Record<string, unknown>): OrchestratorDigestDelivery {
    return {
      digestId: String(row.digest_id),
      version: Number(row.version),
      recipientId: String(row.recipient_id),
      status: row.status === "acknowledged" ? "acknowledged" : "accepted",
      attempts: Number(row.attempts),
      createdAt: String(row.created_at),
      acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : null,
      digest: JSON.parse(String(row.payload_json)) as CoordinationDigest,
    };
  }

  private audit(eventType: string, actorWorkerId: string | null, subjectId: string | null, details: unknown): void {
    this.db.prepare(`INSERT INTO peer_audit_events (id, event_type, actor_worker_id, subject_id, details_json) VALUES (?, ?, ?, ?, ?)`).run(id("audit"), eventType, actorWorkerId, subjectId, JSON.stringify(details));
  }
}
