import { EventEmitter } from "node:events";

import type { DatabaseClient } from "../db/client";
import { createId } from "../utils/ids";
import type {
  CodexQuotaPayload,
  EventInsertInput,
  IoStream,
  SessionApprovalPayload,
  SessionApprovalResolvedPayload,
  SessionEventPayload,
  SessionEventRecord,
} from "../types/models";

export class EventStore {
  private readonly emitter = new EventEmitter();
  private readonly latestQuotaCache = new Map<string, CodexQuotaPayload>();

  constructor(private readonly db: DatabaseClient) {}

  append(sessionId: string, input: EventInsertInput): SessionEventPayload {
    const seq = this.nextSeq(sessionId);
    const id = input.id?.trim() || createId("evt");
    const timestamp = input.timestamp?.trim() || new Date().toISOString();
    const payloadJson = JSON.stringify(input.payload ?? {});
    const stream = this.normalizeStream(input.stream);

    this.db
      .prepare(
        `
          INSERT INTO session_events (
            id,
            session_id,
            turn_id,
            seq,
            event_type,
            message_id,
            call_id,
            request_id,
            phase,
            stream,
            payload_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        sessionId,
        input.turnId,
        seq,
        input.type,
        input.messageId,
        input.callId,
        input.requestId,
        input.phase,
        stream,
        payloadJson,
        timestamp,
      );

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            turn_id,
            seq,
            event_type,
            message_id,
            call_id,
            request_id,
            phase,
            stream,
            payload_json,
            created_at
          FROM session_events
          WHERE id = ?
        `,
      )
      .get(id) as SessionEventRecord;

    const event = this.toPayload(row);
    this.captureLatestQuota(sessionId, event);
    this.emitter.emit(this.channel(sessionId), event);
    return event;
  }

  list(
    sessionId: string,
    options: {
      after?: number;
      before?: number;
      limit?: number;
    } = {},
  ): {
    items: SessionEventPayload[];
    nextCursor: number;
    beforeCursor: number;
    hasMoreBefore: boolean;
  } {
    const safeLimit = Math.max(1, Math.min(options.limit ?? 200, 200));
    const after = Math.max(0, options.after ?? 0);
    const before = Math.max(0, options.before ?? 0);

    if (before > 0) {
      const rows = this.db
        .prepare(
          `
            SELECT
              id,
              session_id,
              turn_id,
              seq,
              event_type,
              message_id,
              call_id,
              request_id,
              phase,
              stream,
              payload_json,
              created_at
            FROM session_events
            WHERE session_id = ? AND seq < ?
            ORDER BY seq DESC
            LIMIT ?
          `,
        )
        .all(sessionId, before, safeLimit + 1) as SessionEventRecord[];

      const hasMoreBefore = rows.length > safeLimit;
      const pageRows = rows.slice(0, safeLimit).reverse();
      return {
        items: pageRows.map((row) => this.toPayload(row)),
        nextCursor: pageRows.length > 0 ? pageRows[pageRows.length - 1].seq : after,
        beforeCursor: pageRows.length > 0 ? pageRows[0].seq : before,
        hasMoreBefore,
      };
    }

    if (after > 0) {
      const rows = this.db
        .prepare(
          `
            SELECT
              id,
              session_id,
              turn_id,
              seq,
              event_type,
              message_id,
              call_id,
              request_id,
              phase,
              stream,
              payload_json,
              created_at
            FROM session_events
            WHERE session_id = ? AND seq > ?
            ORDER BY seq ASC
            LIMIT ?
          `,
        )
        .all(sessionId, after, safeLimit) as SessionEventRecord[];

      return {
        items: rows.map((row) => this.toPayload(row)),
        nextCursor: rows.length > 0 ? rows[rows.length - 1].seq : after,
        beforeCursor: rows.length > 0 ? rows[0].seq : 0,
        hasMoreBefore: rows.length > 0 ? rows[0].seq > 1 : false,
      };
    }

    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            turn_id,
            seq,
            event_type,
            message_id,
            call_id,
            request_id,
            phase,
            stream,
            payload_json,
            created_at
          FROM session_events
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?
        `,
      )
      .all(sessionId, safeLimit + 1) as SessionEventRecord[];

    const hasMoreBefore = rows.length > safeLimit;
    const pageRows = rows.slice(0, safeLimit).reverse();
    return {
      items: pageRows.map((row) => this.toPayload(row)),
      nextCursor: pageRows.length > 0 ? pageRows[pageRows.length - 1].seq : after,
      beforeCursor: pageRows.length > 0 ? pageRows[0].seq : 0,
      hasMoreBefore,
    };
  }

  listAll(sessionId: string): SessionEventPayload[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            turn_id,
            seq,
            event_type,
            message_id,
            call_id,
            request_id,
            phase,
            stream,
            payload_json,
            created_at
          FROM session_events
          WHERE session_id = ?
          ORDER BY seq ASC
        `,
      )
      .all(sessionId) as SessionEventRecord[];

    return rows.map((row) => this.toPayload(row));
  }

  latestQuota(sessionId: string): CodexQuotaPayload | null {
    const cached = this.latestQuotaCache.get(sessionId);
    if (cached) {
      return cached;
    }

    const rows = this.db
      .prepare(
        `
          SELECT payload_json
          FROM session_events
          WHERE session_id = ?
            AND event_type = 'token_count'
          ORDER BY seq DESC
        `,
      )
      .all(sessionId) as Array<{ payload_json: string | null }>;

    for (const row of rows) {
      const payload = this.tryParse<CodexQuotaPayload>(row.payload_json ?? null);
      if (payload && this.hasUsableQuota(payload)) {
        this.latestQuotaCache.set(sessionId, payload);
        return payload;
      }
    }

    return null;
  }

  latestPendingApproval(sessionId: string): SessionApprovalPayload | null {
    const rows = this.db
      .prepare(
        `
          SELECT event_type, request_id, payload_json, seq
          FROM session_events
          WHERE session_id = ?
            AND event_type IN ('approval.requested', 'approval.resolved')
          ORDER BY seq ASC
        `,
      )
      .all(sessionId) as Array<{
      event_type: "approval.requested" | "approval.resolved";
      request_id: string | null;
      payload_json: string | null;
      seq: number;
    }>;

    if (rows.length === 0) {
      return null;
    }

    const pending = new Map<string, SessionApprovalPayload>();
    for (const row of rows) {
      if (row.event_type === "approval.requested") {
        const payload = this.tryParse<SessionApprovalPayload>(row.payload_json);
        const requestId = row.request_id || payload?.requestId || "";
        if (requestId) {
          pending.set(requestId, {
            ...payload,
            requestId,
          } as SessionApprovalPayload);
        }
        continue;
      }

      const payload = this.tryParse<SessionApprovalResolvedPayload>(row.payload_json);
      const requestId = row.request_id || payload?.requestId || "";
      if (requestId) {
        pending.delete(requestId);
      }
    }

    const unresolved = [...pending.values()].sort((a, b) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
    );
    return unresolved[0] ?? null;
  }

  subscribe(
    sessionId: string,
    listener: (event: SessionEventPayload) => void,
  ): () => void {
    const channel = this.channel(sessionId);
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(
        `
          SELECT COALESCE(MAX(seq), 0) AS current_seq
          FROM session_events
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as { current_seq: number };

    return row.current_seq + 1;
  }

  private toPayload(row: SessionEventRecord): SessionEventPayload {
    return {
      id: row.id,
      sessionId: row.session_id,
      type: row.event_type,
      seq: row.seq,
      timestamp: row.created_at,
      turnId: row.turn_id,
      messageId: row.message_id,
      callId: row.call_id,
      requestId: row.request_id,
      phase: row.phase,
      stream: this.normalizeStream(row.stream),
      payload: this.tryParse<Record<string, unknown>>(row.payload_json) ?? {},
    } as SessionEventPayload;
  }

  private tryParse<T>(raw: string | null): T | null {
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private normalizeStream(stream: string | null | undefined): IoStream | null {
    switch (stream) {
      case "stdout":
      case "stderr":
        return stream;
      default:
        return null;
    }
  }

  private channel(sessionId: string): string {
    return `session:${sessionId}`;
  }

  private captureLatestQuota(sessionId: string, event: SessionEventPayload): void {
    if (event.type !== "token_count") {
      return;
    }

    const payload = event.payload as CodexQuotaPayload | undefined;
    if (payload && this.hasUsableQuota(payload)) {
      this.latestQuotaCache.set(sessionId, payload);
    }
  }

  private hasUsableQuota(payload: CodexQuotaPayload): boolean {
    const rateLimits =
      payload.rateLimits && typeof payload.rateLimits === "object"
        ? (payload.rateLimits as Record<string, unknown>)
        : {};
    const primary =
      rateLimits.primary && typeof rateLimits.primary === "object"
        ? (rateLimits.primary as Record<string, unknown>)
        : {};
    const secondary =
      rateLimits.secondary && typeof rateLimits.secondary === "object"
        ? (rateLimits.secondary as Record<string, unknown>)
        : {};

    return (
      this.readQuotaField(primary.used_percent) != null ||
      this.readQuotaField(primary.resets_at) != null ||
      this.readQuotaField(secondary.used_percent) != null ||
      this.readQuotaField(secondary.resets_at) != null
    );
  }

  private readQuotaField(input: unknown): number | null {
    if (typeof input === "number" && Number.isFinite(input)) {
      return input;
    }

    if (typeof input === "string" && input.trim()) {
      const parsed = Number.parseFloat(input);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }
}
