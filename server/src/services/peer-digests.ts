import { randomUUID } from "node:crypto";

export const PEER_DIGEST_LIMITS = Object.freeze({
  maxBytes: 4 * 1024,
  cadenceMs: 5 * 60 * 1_000,
});

export const ORCHESTRATOR_DIGEST_VERSION = 1;
export const ORCHESTRATOR_RECIPIENT_ID = "local-orchestrator";

export function resolveOrchestratorDigestDeliveryMode(value?: string): "internal" {
  const mode = value?.trim() || "internal";
  if (mode !== "internal") {
    throw new Error(`Unsupported Orchestrator digest delivery mode: ${mode}`);
  }
  return "internal";
}

export type CoordinationDigestKind = "milestone" | "blocker" | "completion" | "delivery_failure" | "authorization_failure";

export interface CoordinationDigestEntry {
  kind: CoordinationDigestKind;
  workPackageId: string;
  summary: string;
  occurredAt: string;
}

export interface CoordinationDigest {
  version: typeof ORCHESTRATOR_DIGEST_VERSION;
  digestId: string;
  recipient: "orchestrator";
  recipientId: typeof ORCHESTRATOR_RECIPIENT_ID;
  generatedAt: string;
  entries: CoordinationDigestEntry[];
}

export function buildCoordinationDigest(
  entries: CoordinationDigestEntry[],
  generatedAt = new Date().toISOString(),
  maxBytes = PEER_DIGEST_LIMITS.maxBytes,
): CoordinationDigest {
  const bounded: CoordinationDigestEntry[] = [];
  for (const entry of entries) {
    if (!entry.workPackageId || !entry.summary || !Number.isFinite(Date.parse(entry.occurredAt))) continue;
    const candidate = { ...entry, summary: entry.summary.slice(0, 512) };
    const next: CoordinationDigest = { version: ORCHESTRATOR_DIGEST_VERSION, digestId: "size-check", recipient: "orchestrator", recipientId: ORCHESTRATOR_RECIPIENT_ID, generatedAt, entries: [...bounded, candidate] };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) break;
    bounded.push(candidate);
  }
  return { version: ORCHESTRATOR_DIGEST_VERSION, digestId: randomUUID(), recipient: "orchestrator", recipientId: ORCHESTRATOR_RECIPIENT_ID, generatedAt, entries: bounded };
}

export class PeerDigestScheduler {
  private pending: CoordinationDigestEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    private readonly deliver: (digest: CoordinationDigest) => Promise<void>,
    private readonly cadenceMs = PEER_DIGEST_LIMITS.cadenceMs,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.cadenceMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(entry: CoordinationDigestEntry): void {
    this.pending.push(entry);
  }

  async flush(): Promise<CoordinationDigest | null> {
    if (!this.pending.length || this.flushing) return null;
    this.flushing = true;
    const digest = buildCoordinationDigest(this.pending, this.clock().toISOString());
    try {
      await this.deliver(digest);
      this.pending = this.pending.slice(digest.entries.length);
      return digest;
    } finally {
      this.flushing = false;
    }
  }
}
