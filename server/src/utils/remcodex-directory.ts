export interface RemCodexDirectoryInstance {
  name: string;
  url: string;
  description: string | null;
}

function normalizeInstance(value: unknown, index: number): RemCodexDirectoryInstance {
  if (!value || typeof value !== "object") {
    throw new Error(`Directory instance ${index + 1} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";

  if (!name || !url) {
    throw new Error(`Directory instance ${index + 1} must include name and url.`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Directory instance ${index + 1} has an invalid URL.`);
  }

  if (!(["http:", "https:"].includes(parsedUrl.protocol))) {
    throw new Error(`Directory instance ${index + 1} URL must use http or https.`);
  }

  return {
    name,
    url: parsedUrl.toString().replace(/\/$/, ""),
    description: description || null,
  };
}

export function parseRemCodexDirectoryInstances(rawValue = ""): RemCodexDirectoryInstance[] {
  const raw = rawValue.trim();
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("REMCODEX_DIRECTORY_INSTANCES must contain valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("REMCODEX_DIRECTORY_INSTANCES must be a JSON array.");
  }

  return parsed.map(normalizeInstance);
}
