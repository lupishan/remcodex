import type http from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { EventStore } from "../services/event-store";
import { SessionManager } from "../services/session-manager";

interface GatewayOptions {
  eventStore: EventStore;
  sessionManager: SessionManager;
}

interface SessionWebSocket extends WebSocket {
  isAlive?: boolean;
  sessionId?: string;
}

export function registerSessionGateway(
  server: http.Server,
  options: GatewayOptions,
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const matched = url.pathname.match(/^\/ws\/sessions\/([^/]+)$/);
    if (!matched) {
      socket.destroy();
      return;
    }

    const sessionId = matched[1];
    if (!options.sessionManager.hasSession(sessionId)) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const sessionSocket = ws as SessionWebSocket;
      sessionSocket.sessionId = sessionId;
      sessionSocket.isAlive = true;
      wss.emit("connection", sessionSocket, request);
    });
  });

  wss.on("connection", (ws) => {
    const sessionSocket = ws as SessionWebSocket;
    const sessionId = sessionSocket.sessionId;
    if (!sessionId) {
      ws.close();
      return;
    }

    const unsubscribe = options.eventStore.subscribe(sessionId, (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });

    const heartbeat = setInterval(() => {
      if (!sessionSocket.isAlive) {
        ws.terminate();
        return;
      }

      sessionSocket.isAlive = false;
      ws.ping();
    }, 30000);
    heartbeat.unref();

    ws.on("pong", () => {
      sessionSocket.isAlive = true;
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    ws.on("error", () => {
      clearInterval(heartbeat);
      unsubscribe();
      ws.close();
    });
  });
}
