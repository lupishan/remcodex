import { summarizeReplyEvent } from "./session-reply-diagnostics.js";

export function connectSessionSocket(sessionId, handlers) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/sessions/${sessionId}`);
  const connectionId = handlers.connectionId || `reply-ui:${sessionId}:socket`;
  let eventCount = 0;

  ws.addEventListener("open", () => {
    handlers.onLog?.({
      level: "info",
      message: "Session websocket opened",
      details: {
        sessionId,
        connectionId,
      },
    });
    handlers.onStateChange?.("open");
  });

  ws.addEventListener("close", (event) => {
    handlers.onLog?.({
      level: "info",
      message: "Session websocket closed",
      details: {
        sessionId,
        connectionId,
        eventCount,
        code: event.code,
        reasonLength: event.reason ? event.reason.length : 0,
      },
    });
    handlers.onStateChange?.("closed");
  });

  ws.addEventListener("error", () => {
    handlers.onLog?.({
      level: "error",
      message: "Session websocket error",
      details: {
        sessionId,
        connectionId,
        eventCount,
      },
    });
    handlers.onStateChange?.("error");
  });

  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      eventCount += 1;
      handlers.onEvent?.(payload);
      handlers.onLog?.({
        level: "debug",
        message: "Session websocket event ingested",
        details: {
          sessionId,
          connectionId,
          eventIndex: eventCount,
          ...summarizeReplyEvent(payload),
        },
      });
    } catch (error) {
      handlers.onLog?.({
        level: "warn",
        message: "Failed to parse websocket message",
        details: {
          sessionId,
          connectionId,
          error: error instanceof Error ? error.message : String(error),
          dataLength: typeof event.data === "string" ? event.data.length : null,
        },
      });
      handlers.onStateChange?.(error instanceof Error ? error.message : "parse_error");
    }
  });

  return {
    close() {
      ws.close();
    },
  };
}
