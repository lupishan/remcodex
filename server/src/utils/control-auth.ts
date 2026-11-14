import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Express } from "express";

const COOKIE = "remcodex_control";
const SESSION_MS = 12 * 60 * 60 * 1000;

export function isLoopbackHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Browser requests must originate at this host, including during WebSocket upgrade. */
export function hasTrustedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // Non-browser API clients authenticate separately.
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === request.headers.host;
  } catch { return false; }
}

export function createControlAuth(token: string | undefined) {
  const secret = token?.trim() || "";
  const sign = (value: string) => createHmac("sha256", secret).update(value).digest("base64url");
  const bearer = (request: IncomingMessage) => request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const authenticated = (request: IncomingMessage): boolean => {
    if (!hasTrustedOrigin(request)) return false;
    if (!secret) {
      try {
        const host = new URL(`http://${request.headers.host}`).hostname;
        const address = request.socket.remoteAddress || "";
        return isLoopbackHost(host) && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
      } catch { return false; }
    }
    if (equal(bearer(request), secret)) return true;
    const cookie = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
    const [id, expires, signature, extra] = cookie.split(".");
    return Boolean(id && expires && signature && !extra && Number(expires) > Date.now() && equal(signature, sign(`${id}.${expires}`)));
  };
  const mount = (app: Express) => {
    app.post("/auth/session", (request, response) => {
      if (!secret || !hasTrustedOrigin(request) || !equal(bearer(request), secret)) {
        response.status(401).json({ error: "Unauthorized" }); return;
      }
      const value = `${randomUUID()}.${Date.now() + SESSION_MS}`;
      response.cookie(COOKIE, `${value}.${sign(value)}`, { httpOnly: true, sameSite: "strict", secure: request.secure, maxAge: SESSION_MS, path: "/" });
      response.setHeader("Cache-Control", "no-store");
      response.status(204).end();
    });
    app.use((request, response, next) => {
      // MCP and peer endpoints have their own independently scoped bearer credentials.
      if (request.path === "/mcp" || request.path.startsWith("/api/peer/")) {
        if (!hasTrustedOrigin(request)) { response.status(403).json({ error: "Untrusted origin" }); return; }
        next(); return;
      }
      if (authenticated(request)) { next(); return; }
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "GET" && request.path === "/" && secret) {
        response.status(401).type("html").send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to RemCodex</title><style>body{font:18px system-ui;max-width:400px;margin:15vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0}p{line-height:1.6}</style><h1>Connect to RemCodex</h1><p>Enter the access token configured on your computer.</p><form><input type="password" aria-label="Access token" autocomplete="off" required><button>Connect</button><p role="alert"></p></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/auth/session',{method:'POST',headers:{Authorization:'Bearer '+document.querySelector('input').value}});if(r.ok)location.reload();else document.querySelector('[role=alert]').textContent='Access token was not accepted.'}catch{document.querySelector('[role=alert]').textContent='Could not connect. Please try again.'}};</script></html>`);
      } else response.status(401).json({ error: "Unauthorized" });
    });
  };
  return { authenticated, mount };
}
