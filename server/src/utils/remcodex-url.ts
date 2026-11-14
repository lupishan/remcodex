export function resolveRemCodexPublicBaseUrl(rawValue = process.env.REMCODEX_HOSTNAME ?? ""): string | null {
  const raw = rawValue.trim();
  if (!raw) {
    return null;
  }

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("REMCODEX_HOSTNAME must be a valid hostname or HTTP(S) URL.");
  }

  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new Error("REMCODEX_HOSTNAME must use http or https.");
  }

  return parsed.toString().replace(/\/$/, "");
}

export function buildRemCodexSessionUrl(sessionId: string, publicBaseUrl = resolveRemCodexPublicBaseUrl()): string {
  const sessionPath = `/#/sessions/${encodeURIComponent(sessionId)}`;
  return publicBaseUrl ? `${publicBaseUrl}${sessionPath}` : sessionPath;
}
