import type { Response } from "express";

import {
  remoteMcpUrl,
  resolveRemCodexRemoteInstance,
  type RemCodexRemoteInstance,
} from "../utils/remcodex-remote-instances";

type RemoteFetch = typeof fetch;

async function post(
  url: string,
  authorization: string,
  body: unknown,
  sessionId: string | null,
  fetchImpl: RemoteFetch,
): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
}

export async function proxyRemoteMcpCall(
  body: { id?: unknown; params?: { arguments?: Record<string, unknown> } },
  instances: RemCodexRemoteInstance[],
  callerResponse: Response,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: RemoteFetch = fetch,
): Promise<void> {
  const argumentsValue = body.params?.arguments ?? {};
  const instanceName = typeof argumentsValue.instanceName === "string" ? argumentsValue.instanceName : "";
  const { instance, authorization } = resolveRemCodexRemoteInstance(instanceName, instances, environment);
  const targetUrl = remoteMcpUrl(instance);
  const initialize = await post(
    targetUrl,
    authorization,
    {
      jsonrpc: "2.0",
      id: "remcodex-proxy-init",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "remcodex-proxy", version: "1" } },
    },
    null,
    fetchImpl,
  );
  if (!initialize.ok) throw new Error(`Remote instance initialization failed (${initialize.status}).`);
  const targetSessionId = initialize.headers.get("mcp-session-id");
  if (!targetSessionId) throw new Error("Remote instance did not return an MCP session.");

  await initialize.body?.cancel();
  try {
  const notification = await post(targetUrl, authorization, { jsonrpc: "2.0", method: "notifications/initialized" }, targetSessionId, fetchImpl);
  if (!notification.ok) throw new Error(`Remote instance notification failed (${notification.status}).`);
  await notification.body?.cancel();
  const forwardedArguments = { ...argumentsValue };
  delete forwardedArguments.instanceName;
  const remoteResponse = await post(
    targetUrl,
    authorization,
    { ...body, params: { ...(body.params ?? {}), arguments: forwardedArguments } },
    targetSessionId,
    fetchImpl,
  );
  const reader = remoteResponse.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) throw new Error("Remote MCP response exceeds 1 MiB.");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
  }
  const responseText = Buffer.concat(chunks).toString("utf8");
  callerResponse.status(remoteResponse.status);
  callerResponse.setHeader("content-type", remoteResponse.headers.get("content-type") ?? "application/json");
  callerResponse.send(responseText); // Preserve complete SSE frames and their declared media type.
  } finally {
    await fetchImpl(targetUrl, {
      method: "DELETE", headers: { authorization, "mcp-session-id": targetSessionId },
      redirect: "error", signal: AbortSignal.timeout(2000),
    }).then(result => result.body?.cancel()).catch(() => undefined);
  }
}
