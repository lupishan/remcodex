export interface RemCodexRemoteInstance {
  name: string;
  url: string;
  credentialRef: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CREDENTIAL_REF = /^[A-Z][A-Z0-9_]{0,127}$/;

function rejectPrivateHost(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (
    host.includes(":") || // IPv6 targets require a separately reviewed explicit trust policy.
    host === "localhost" ||
    host === "ip6-localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error("Remote instance URL must not target a loopback or private host.");
  }
}

function normalizeRemoteInstance(value: unknown, index: number): RemCodexRemoteInstance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Remote instance ${index + 1} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const credentialRef = typeof record.credentialRef === "string" ? record.credentialRef.trim() : "";
  if (!NAME.test(name)) {
    throw new Error(`Remote instance ${index + 1} has an invalid name.`);
  }
  if (!CREDENTIAL_REF.test(credentialRef)) {
    throw new Error(`Remote instance ${index + 1} requires an environment credentialRef.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Remote instance ${index + 1} has an invalid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Remote instance ${index + 1} URL must use https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Remote instance ${index + 1} URL must not contain credentials.`);
  }
  rejectPrivateHost(parsed.hostname);

  return {
    name,
    url: parsed.toString().replace(/\/$/, ""),
    credentialRef,
  };
}

export function parseRemCodexRemoteInstances(rawValue = ""): RemCodexRemoteInstance[] {
  const raw = rawValue.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("REMCODEX_REMOTE_INSTANCES must contain valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("REMCODEX_REMOTE_INSTANCES must be a JSON array.");
  }
  const instances = parsed.map(normalizeRemoteInstance);
  const names = new Set<string>();
  for (const instance of instances) {
    if (names.has(instance.name)) throw new Error(`Remote instance name is duplicated: ${instance.name}.`);
    names.add(instance.name);
  }
  return instances;
}

export function resolveRemCodexRemoteInstance(
  name: string,
  instances: RemCodexRemoteInstance[],
  environment: NodeJS.ProcessEnv = process.env,
): { instance: RemCodexRemoteInstance; authorization: string } {
  const instance = instances.find((candidate) => candidate.name === name.trim());
  if (!instance) throw new Error("Unknown remote instance.");
  const credential = environment[instance.credentialRef]?.trim() || "";
  if (!credential) throw new Error("Remote instance credential is unavailable.");
  return { instance, authorization: `Bearer ${credential}` };
}

export function remoteMcpUrl(instance: RemCodexRemoteInstance): string {
  return instance.url.endsWith("/mcp") ? instance.url : `${instance.url}/mcp`;
}
