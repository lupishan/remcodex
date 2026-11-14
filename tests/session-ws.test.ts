import assert from "node:assert/strict";
import test from "node:test";

import { connectSessionSocket } from "../web/session-ws.js";
import { buildReplySocketConnectionId } from "../web/session-reply-diagnostics.js";

type Listener = (event: Record<string, unknown>) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly url: string;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  emit(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }

  close() {
    this.emit("close", { code: 1000, reason: "client-close-secret" });
  }
}

test("session websocket diagnostics cover lifecycle, ingestion, parsing, and reconnect correlation", () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  const logs: Array<Record<string, unknown>> = [];
  const received: unknown[] = [];
  const states: string[] = [];

  (globalThis as { window: unknown }).window = {
    location: { protocol: "https:", host: "remcodex.example" },
  };
  (globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket;
  MockWebSocket.instances = [];

  try {
    const firstConnectionId = buildReplySocketConnectionId("reply-ui:session-1:7", 1);
    connectSessionSocket("session-1", {
      connectionId: firstConnectionId,
      onLog(entry: Record<string, unknown>) {
        logs.push(entry);
      },
      onEvent(event: unknown) {
        received.push(event);
      },
      onStateChange(state: string) {
        states.push(state);
      },
    });

    const firstSocket = MockWebSocket.instances[0];
    assert.equal(firstSocket.url, "wss://remcodex.example/ws/sessions/session-1");
    firstSocket.emit("open");
    firstSocket.emit("message", {
      data: JSON.stringify({
        id: "event-1",
        type: "message.assistant.delta",
        seq: 11,
        turnId: "turn-1",
        messageId: "message-1",
        payload: { textDelta: "private reply body", token: "private-token" },
      }),
    });
    firstSocket.emit("message", { data: "not-json private-token" });
    firstSocket.emit("error");
    firstSocket.emit("close", { code: 1006, reason: "private-close-reason" });

    const firstIngested = logs.find((entry) => entry.message === "Session websocket event ingested");
    assert.deepEqual(firstIngested, {
      level: "debug",
      message: "Session websocket event ingested",
      details: {
        sessionId: "session-1",
        connectionId: firstConnectionId,
        eventIndex: 1,
        eventId: "event-1",
        eventType: "message.assistant.delta",
        seq: 11,
        turnId: "turn-1",
        messageId: "message-1",
        callId: null,
        phase: null,
      },
    });
    assert.equal(received.length, 1);
    const parseFailure = logs.find((entry) => entry.message === "Failed to parse websocket message");
    const parseError = (parseFailure?.details as Record<string, unknown>)?.error;
    assert.equal(typeof parseError, "string");
    assert.deepEqual(states, ["open", parseError, "error", "closed"]);

    const closed = logs.find((entry) => entry.message === "Session websocket closed");
    assert.deepEqual(closed?.details, {
      sessionId: "session-1",
      connectionId: firstConnectionId,
      eventCount: 1,
      code: 1006,
      reasonLength: "private-close-reason".length,
    });
    assert.deepEqual(parseFailure?.details, {
      sessionId: "session-1",
      connectionId: firstConnectionId,
      error: parseError,
      dataLength: "not-json private-token".length,
    });
    assert.equal(JSON.stringify(logs).includes("private reply body"), false);
    assert.equal(JSON.stringify(logs).includes("private-token"), false);
    assert.equal(JSON.stringify(logs).includes("private-close-reason"), false);

    const secondConnectionId = buildReplySocketConnectionId("reply-ui:session-1:7", 2);
    connectSessionSocket("session-1", {
      connectionId: secondConnectionId,
      onLog(entry: Record<string, unknown>) {
        logs.push(entry);
      },
    });
    MockWebSocket.instances[1].emit("open");
    const opened = logs.filter((entry) => entry.message === "Session websocket opened");
    assert.deepEqual(
      opened.map((entry) => (entry.details as Record<string, unknown>).connectionId),
      [firstConnectionId, secondConnectionId],
    );
    assert.notEqual(firstConnectionId, secondConnectionId);
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = previousWindow;
    }
    if (previousWebSocket === undefined) {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
    } else {
      (globalThis as { WebSocket: unknown }).WebSocket = previousWebSocket;
    }
  }
});
