import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplySocketConnectionId,
  classifyReplyEvent,
  summarizeReplyEvent,
} from "../web/session-reply-diagnostics.js";

test("reply websocket connection IDs distinguish reconnect attempts", () => {
  assert.equal(
    buildReplySocketConnectionId("reply-ui:session-1:4", 1),
    "reply-ui:session-1:4:socket-1",
  );
  assert.notEqual(
    buildReplySocketConnectionId("reply-ui:session-1:4", 1),
    buildReplySocketConnectionId("reply-ui:session-1:4", 2),
  );
});

test("reply diagnostics preserve correlation identifiers without message content", () => {
  const summary = summarizeReplyEvent({
    id: "event-7",
    type: "message.assistant.delta",
    seq: 7,
    sessionId: "session-1",
    turnId: "turn-2",
    messageId: "message-3",
    phase: "final_answer",
    payload: { textDelta: "a sensitive assistant reply" },
  });

  assert.deepEqual(summary, {
    eventId: "event-7",
    eventType: "message.assistant.delta",
    seq: 7,
    turnId: "turn-2",
    messageId: "message-3",
    callId: null,
    phase: "final_answer",
  });
  assert.equal(JSON.stringify(summary).includes("sensitive"), false);
});

test("reply diagnostics classify in-order, duplicate, delayed, and replayed events", () => {
  const knownEventIds = new Set(["event-3"]);

  assert.equal(
    classifyReplyEvent({ id: "event-1", type: "turn.started", seq: 1 }, { lastSeq: 0 }).classification,
    "first",
  );
  assert.equal(
    classifyReplyEvent({ id: "event-4", type: "message.assistant.delta", seq: 4 }, { lastSeq: 3 }).classification,
    "in_order",
  );
  assert.equal(
    classifyReplyEvent({ id: "event-3", type: "message.assistant.delta", seq: 3 }, { knownEventIds, lastSeq: 4 }).classification,
    "duplicate",
  );
  assert.equal(
    classifyReplyEvent({ id: "event-2", type: "message.assistant.delta", seq: 2 }, { lastSeq: 4 }).classification,
    "delayed",
  );
  assert.equal(
    classifyReplyEvent({ id: "event-5", type: "message.assistant.end", seq: 4 }, { lastSeq: 4 }).classification,
    "same_sequence",
  );
});

test("reply diagnostics identify sequence gaps and malformed events", () => {
  assert.deepEqual(
    classifyReplyEvent(
      { id: "event-9", type: "message.assistant.end", seq: 9, turnId: "turn-1" },
      { lastSeq: 5 },
    ),
    {
      classification: "gap",
      missingFrom: 6,
      missingTo: 8,
      eventId: "event-9",
      eventType: "message.assistant.end",
      seq: 9,
      turnId: "turn-1",
      messageId: null,
      callId: null,
      phase: null,
    },
  );
  assert.equal(classifyReplyEvent({ type: "message.assistant.delta", seq: 10 }).classification, "missing_id");
  assert.equal(classifyReplyEvent({ id: "event-10", type: "message.assistant.delta" }).classification, "unsequenced");
});
