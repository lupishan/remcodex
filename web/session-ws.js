export function connectSessionSocket(sessionId, handlers) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/sessions/${sessionId}`);

  ws.addEventListener("open", () => {
    handlers.onStateChange?.("open");
  });

  ws.addEventListener("close", () => {
    handlers.onStateChange?.("closed");
  });

  ws.addEventListener("error", () => {
    handlers.onStateChange?.("error");
  });

  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      handlers.onEvent?.(payload);
    } catch (error) {
      handlers.onStateChange?.(error instanceof Error ? error.message : "parse_error");
    }
  });

  return {
    close() {
      ws.close();
    },
  };
}
