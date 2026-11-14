import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../server/src/db/client";
import { runMigrations } from "../server/src/db/migrations";
import { PEER_LIMITS, PEER_SCOPES, PeerCommunicationService } from "../server/src/services/peer-communication";
import { buildCoordinationDigest, PEER_DIGEST_LIMITS, PeerDigestScheduler, resolveOrchestratorDigestDeliveryMode } from "../server/src/services/peer-digests";

function setup(clock?: () => Date): PeerCommunicationService {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return new PeerCommunicationService(db, clock);
}

test("peer authorization is deny-by-default and grants are directed to a work package", () => {
  const peer = setup();
  assert.throws(
    () => peer.issueCredential({ workerId: "mixed", sessionId: "mixed-session", scopes: [PEER_SCOPES.adminGrant, PEER_SCOPES.workerMailbox] }),
    /separate credentials/,
  );
  const admin = peer.authenticate(peer.issueCredential({ workerId: "admin", sessionId: "admin-session", scopes: [PEER_SCOPES.adminGrant, PEER_SCOPES.adminRevoke] }).token);
  const worker = peer.issueCredential({ workerId: "worker-a", sessionId: "worker-session", scopes: [PEER_SCOPES.workerMailbox, PEER_SCOPES.workerSummary, PEER_SCOPES.workerTimeline] });
  const target = peer.issueCredential({ workerId: "worker-b", sessionId: "target-session", scopes: [PEER_SCOPES.workerMailbox, PEER_SCOPES.workerSummary, PEER_SCOPES.workerTimeline] });
  const grant = peer.grant(admin, { sourceWorkerId: "worker-a", targetWorkerId: "worker-b", workPackageId: "wp-1", scope: PEER_SCOPES.workerMailbox });
  assert.throws(() => peer.appendMessage(target.token, { recipientWorkerId: "worker-a", workPackageId: "wp-1", messageType: "note", timestamp: new Date().toISOString(), idempotencyKey: "target-0001", payload: {} }), /not authorized/);
  assert.throws(() => peer.appendMessage(worker.token, { recipientWorkerId: "worker-b", workPackageId: "wp-2", messageType: "note", timestamp: new Date().toISOString(), idempotencyKey: "wrong-work", payload: {} }), /not authorized/);
  assert.equal(grant.grantId.startsWith("grant_"), true);
});

test("peer envelopes use server identity, bounded payloads, idempotency, cursors, and timelines", () => {
  const peer = setup();
  const admin = peer.authenticate(peer.issueCredential({ workerId: "admin", sessionId: "admin-session", scopes: [PEER_SCOPES.adminGrant] }).token);
  const source = peer.issueCredential({ workerId: "source", sessionId: "source-session", scopes: [PEER_SCOPES.workerMailbox, PEER_SCOPES.workerTimeline, PEER_SCOPES.workerSummary] });
  const target = peer.issueCredential({ workerId: "target", sessionId: "target-session", scopes: [PEER_SCOPES.workerMailbox, PEER_SCOPES.workerTimeline, PEER_SCOPES.workerSummary] });
  const grant = peer.grant(admin, { sourceWorkerId: "source", targetWorkerId: "target", workPackageId: "wp-1", scope: PEER_SCOPES.workerMailbox });
  const timelineGrant = peer.grant(admin, { sourceWorkerId: "source", targetWorkerId: "target", workPackageId: "wp-1", scope: PEER_SCOPES.workerTimeline });
  const message = { recipientWorkerId: "target", workPackageId: "wp-1", messageType: "milestone", timestamp: new Date().toISOString(), idempotencyKey: "message-0001", payload: { value: "safe" } };
  const first = peer.appendMessage(source.token, message);
  const duplicate = peer.appendMessage(source.token, message);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.senderWorkerId, "source");
  const mailbox = peer.readMailbox(target.token, grant.grantId, PEER_LIMITS.maxMessagesPerRead + 50);
  assert.equal(mailbox.messages.length, 1);
  assert.equal(mailbox.nextCursor, first.id);
  assert.equal(peer.readMailbox(target.token, grant.grantId).messages.length, 0);
  assert.deepEqual(peer.readTimeline(source.token, timelineGrant.grantId, 100), []);
  assert.throws(() => peer.appendMessage(source.token, { ...message, idempotencyKey: "message-0002", payload: "x".repeat(PEER_LIMITS.maxPayloadBytes) }), /bound/);
});

test("peer summaries and lifecycle dormancy are audited", () => {
  const peer = setup();
  const admin = peer.authenticate(peer.issueCredential({ workerId: "admin", sessionId: "admin-session", scopes: [PEER_SCOPES.adminGrant] }).token);
  const source = peer.issueCredential({ workerId: "source", sessionId: "source-session", scopes: [PEER_SCOPES.workerSummary, PEER_SCOPES.workerTimeline] });
  const target = peer.issueCredential({ workerId: "target", sessionId: "target-session", scopes: [PEER_SCOPES.workerSummary, PEER_SCOPES.workerTimeline] });
  const grant = peer.grant(admin, { sourceWorkerId: "source", targetWorkerId: "target", workPackageId: "wp-1", scope: PEER_SCOPES.workerSummary });
  peer.publishSummary(source.token, grant.grantId, { milestone: "done", blockers: [] });
  assert.deepEqual(peer.readSummary(target.token, grant.grantId), { milestone: "done", blockers: [] });
  peer.dormantSession("source-session", "completed");
  assert.throws(() => peer.publishSummary(source.token, grant.grantId, {}), /inactive or expired/);
});

test("disconnect timeout dormants inactive credentials and grants", () => {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const peer = setup(() => current);
  const admin = peer.authenticate(peer.issueCredential({ workerId: "admin", sessionId: "admin-session", scopes: [PEER_SCOPES.adminGrant] }).token);
  const worker = peer.issueCredential({ workerId: "worker", sessionId: "worker-session", scopes: [PEER_SCOPES.workerMailbox] });
  const target = peer.issueCredential({ workerId: "target", sessionId: "target-session", scopes: [PEER_SCOPES.workerMailbox] });
  const grant = peer.grant(admin, { sourceWorkerId: "worker", targetWorkerId: "target", workPackageId: "wp-timeout", scope: PEER_SCOPES.workerMailbox });

  assert.equal(peer.sweepDisconnectedCredentials(), 0);
  current = new Date(current.getTime() + PEER_LIMITS.disconnectTimeoutMs + 1);
  assert.equal(peer.sweepDisconnectedCredentials(), 3);
  assert.throws(() => peer.authenticate(worker.token), /inactive or expired/);
  assert.throws(() => peer.authenticate(target.token), /inactive or expired/);
  assert.throws(() => peer.readMailbox(target.token, grant.grantId), /inactive or expired/);
});

test("terminal dormancy requires administrator reauthorization and a new grant", () => {
  const peer = setup();
  const admin = peer.authenticate(peer.issueCredential({ workerId: "admin", sessionId: "admin-session", scopes: [PEER_SCOPES.adminGrant] }).token);
  const source = peer.issueCredential({ workerId: "source", sessionId: "source-session", scopes: [PEER_SCOPES.workerMailbox] });
  const target = peer.issueCredential({ workerId: "target", sessionId: "target-session", scopes: [PEER_SCOPES.workerMailbox] });
  const grant = peer.grant(admin, { sourceWorkerId: "source", targetWorkerId: "target", workPackageId: "wp-1", scope: PEER_SCOPES.workerMailbox });
  peer.dormantSession("source-session", "completed");
  assert.throws(() => peer.appendMessage(source.token, { recipientWorkerId: "target", workPackageId: "wp-1", messageType: "note", timestamp: new Date().toISOString(), idempotencyKey: "terminal-1", payload: {} }), /inactive or expired/);
  const replacement = peer.reauthorize(admin, { workerId: "source", sessionId: "new-session", scopes: [PEER_SCOPES.workerMailbox] });
  assert.throws(() => peer.appendMessage(replacement.token, { recipientWorkerId: "target", workPackageId: "wp-1", messageType: "note", timestamp: new Date().toISOString(), idempotencyKey: "terminal-2", payload: {} }), /not authorized/);
  assert.equal(grant.grantId.startsWith("grant_"), true);
  assert.equal(target.token.startsWith("peer_"), true);
});

test("coordination digests are Orchestrator-directed, non-triggering, and bounded", () => {
  const digest = buildCoordinationDigest([
    { kind: "milestone", workPackageId: "wp-1", summary: "completed", occurredAt: new Date().toISOString() },
    { kind: "blocker", workPackageId: "wp-2", summary: "x".repeat(2000), occurredAt: new Date().toISOString() },
  ]);
  assert.equal(digest.recipient, "orchestrator");
  assert.equal(Buffer.byteLength(JSON.stringify(digest), "utf8") <= PEER_DIGEST_LIMITS.maxBytes, true);
  assert.equal(JSON.stringify(digest).includes("tool"), false);
});

test("coordination digest scheduler batches entries on the configured cadence seam", async () => {
  const delivered: any[] = [];
  const scheduler = new PeerDigestScheduler(async (digest) => { delivered.push(digest); }, 60_000, () => new Date("2026-01-01T00:00:00Z"));
  scheduler.enqueue({ kind: "completion", workPackageId: "wp-1", summary: "done", occurredAt: "2026-01-01T00:00:00Z" });
  assert.equal(await scheduler.flush() !== null, true);
  assert.equal(delivered[0].recipient, "orchestrator");
  assert.equal(await scheduler.flush(), null);
  scheduler.stop();
});

test("internal Orchestrator digest delivery is versioned, idempotent, and administrator-acknowledged", () => {
  const peer = setup();
  const admin = peer.issueCredential({ workerId: "orchestrator", sessionId: "orchestrator-session", scopes: [PEER_SCOPES.adminDigest] });
  const worker = peer.issueCredential({ workerId: "worker", sessionId: "worker-session", scopes: [PEER_SCOPES.workerDigest] });
  const digest = buildCoordinationDigest([{ kind: "milestone", workPackageId: "wp-1", summary: "safe summary", occurredAt: new Date().toISOString() }]);

  const accepted = peer.deliverOrchestratorDigest(digest);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.digest.digestId, digest.digestId);
  assert.deepEqual(peer.deliverOrchestratorDigest(digest), accepted);
  assert.equal(peer.readOrchestratorDigests(admin.token).length, 1);
  assert.throws(() => peer.readOrchestratorDigests(worker.token), /not authorized/);
  const acknowledged = peer.acknowledgeOrchestratorDigest(admin.token, digest.digestId);
  assert.equal(acknowledged.status, "acknowledged");
  assert.equal(peer.readOrchestratorDigests(admin.token).length, 0);
  assert.equal(peer.acknowledgeOrchestratorDigest(admin.token, digest.digestId).status, "acknowledged");
});

test("digest delivery mode is internal by default and rejects unconfigured transports", () => {
  assert.equal(resolveOrchestratorDigestDeliveryMode(), "internal");
  assert.equal(resolveOrchestratorDigestDeliveryMode("internal"), "internal");
  assert.throws(() => resolveOrchestratorDigestDeliveryMode("https"), /Unsupported/);
});

test("digest scheduler retains entries for the next cadence after delivery failure", async () => {
  let attempts = 0;
  const scheduler = new PeerDigestScheduler(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary delivery failure");
  });
  scheduler.enqueue({ kind: "delivery_failure", workPackageId: "wp-retry", summary: "retryable", occurredAt: new Date().toISOString() });
  await assert.rejects(() => scheduler.flush(), /temporary delivery failure/);
  assert.equal(await scheduler.flush() !== null, true);
  assert.equal(attempts, 2);
  scheduler.stop();
});
