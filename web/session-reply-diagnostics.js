function normalizeIdentifier(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function buildReplySocketConnectionId(correlationId, attempt) {
  const correlation = normalizeIdentifier(correlationId) || "reply-ui:unknown";
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  return `${correlation}:socket-${normalizedAttempt}`;
}

export function summarizeReplyEvent(event) {
  if (!event || typeof event !== "object") {
    return {
      eventId: null,
      eventType: null,
      seq: null,
      turnId: null,
      messageId: null,
      callId: null,
      phase: null,
    };
  }

  return {
    eventId: normalizeIdentifier(event.id),
    eventType: normalizeIdentifier(event.type),
    seq: Number.isFinite(Number(event.seq)) ? Number(event.seq) : null,
    turnId: normalizeIdentifier(event.turnId || event.turn_id),
    messageId: normalizeIdentifier(event.messageId || event.message_id),
    callId: normalizeIdentifier(event.callId || event.call_id),
    phase: normalizeIdentifier(event.phase),
  };
}

export function classifyReplyEvent(event, { knownEventIds = new Set(), lastSeq = 0 } = {}) {
  const summary = summarizeReplyEvent(event);
  if (!summary.eventId) {
    return { classification: "missing_id", ...summary };
  }
  if (knownEventIds.has(summary.eventId)) {
    return { classification: "duplicate", ...summary };
  }
  if (summary.seq == null || summary.seq <= 0) {
    return { classification: "unsequenced", ...summary };
  }
  if (summary.seq < lastSeq) {
    return { classification: "delayed", ...summary };
  }
  if (summary.seq === lastSeq && lastSeq > 0) {
    return { classification: "same_sequence", ...summary };
  }
  if (lastSeq > 0 && summary.seq > lastSeq + 1) {
    return {
      classification: "gap",
      missingFrom: lastSeq + 1,
      missingTo: summary.seq - 1,
      ...summary,
    };
  }
  return { classification: lastSeq > 0 ? "in_order" : "first", ...summary };
}
