import type { EventStore } from "./event-store";
import type {
  AssistantMessageDeltaEvent,
  CommandOutputDeltaEvent,
  PatchOutputDeltaEvent,
  ReasoningDeltaEvent,
  SessionEventPayload,
} from "../types/models";

const DEFAULT_TIMELINE_LIMIT = 200;
const MAX_TIMELINE_LIMIT = 400;

export interface SessionTimelinePage {
  items: SessionEventPayload[];
  nextCursor: number;
  beforeCursor: number;
  hasMoreBefore: boolean;
  lastSeq: number;
}

type TimelineOptions = {
  after?: number;
  before?: number;
  limit?: number;
};

function clampLimit(limit: number | undefined): number {
  const numeric = Number(limit || DEFAULT_TIMELINE_LIMIT);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_TIMELINE_LIMIT;
  }
  return Math.max(1, Math.min(Math.trunc(numeric), MAX_TIMELINE_LIMIT));
}

function normalizeCursor(value: number | undefined): number {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.trunc(numeric);
}

function cloneEvent<T extends SessionEventPayload>(event: T): T {
  return {
    ...event,
    payload:
      event.payload && typeof event.payload === "object"
        ? { ...(event.payload as Record<string, unknown>) }
        : event.payload,
  } as T;
}

function appendTextDelta(currentValue: string, nextValue: string): string {
  if (!nextValue) {
    return currentValue || "";
  }
  return `${currentValue || ""}${nextValue}`;
}

function compareEvents(left: SessionEventPayload, right: SessionEventPayload): number {
  if (left.seq !== right.seq) {
    return left.seq - right.seq;
  }
  return String(left.id || "").localeCompare(String(right.id || ""));
}

function upsertTimelineEvent(
  items: SessionEventPayload[],
  indexById: Map<string, SessionEventPayload>,
  nextEvent: SessionEventPayload,
): SessionEventPayload {
  const existing = indexById.get(nextEvent.id);
  if (existing) {
    Object.assign(existing, nextEvent);
    return existing;
  }

  const cloned = cloneEvent(nextEvent);
  items.push(cloned);
  indexById.set(cloned.id, cloned);
  return cloned;
}

function timelineAssistantDeltaId(event: SessionEventPayload): string {
  return `timeline:assistant:delta:${event.messageId || event.id}`;
}

function timelineReasoningDeltaId(event: SessionEventPayload): string {
  return `timeline:reasoning:delta:${event.messageId || event.id}`;
}

function timelineCommandOutputId(event: SessionEventPayload): string {
  return `timeline:command:output:${event.callId || event.id}:${event.stream || "stdout"}`;
}

function timelinePatchOutputId(event: SessionEventPayload): string {
  return `timeline:patch:output:${event.callId || event.id}`;
}

function aggregateSemanticTimeline(rawEvents: SessionEventPayload[]): SessionEventPayload[] {
  const items: SessionEventPayload[] = [];
  const indexById = new Map<string, SessionEventPayload>();

  rawEvents.forEach((event) => {
    switch (event.type) {
      case "message.assistant.delta": {
        const syntheticId = timelineAssistantDeltaId(event);
        const existing = indexById.get(syntheticId) as AssistantMessageDeltaEvent | undefined;
        upsertTimelineEvent(items, indexById, {
          ...cloneEvent(event),
          id: syntheticId,
          payload: {
            ...(event.payload || {}),
            textDelta: appendTextDelta(
              existing?.payload?.textDelta || "",
              String(event.payload?.textDelta || ""),
            ),
          },
        });
        break;
      }
      case "reasoning.delta": {
        const syntheticId = timelineReasoningDeltaId(event);
        const existing = indexById.get(syntheticId) as ReasoningDeltaEvent | undefined;
        const nextText = appendTextDelta(
          existing?.payload?.textDelta || "",
          String(event.payload?.textDelta || ""),
        );
        upsertTimelineEvent(items, indexById, {
          ...cloneEvent(event),
          id: syntheticId,
          payload: {
            ...(event.payload || {}),
            textDelta: nextText,
            summary:
              event.payload?.summary ||
              existing?.payload?.summary ||
              nextText ||
              null,
          },
        });
        break;
      }
      case "command.output.delta": {
        const syntheticId = timelineCommandOutputId(event);
        const existing = indexById.get(syntheticId) as CommandOutputDeltaEvent | undefined;
        upsertTimelineEvent(items, indexById, {
          ...cloneEvent(event),
          id: syntheticId,
          payload: {
            ...(event.payload || {}),
            textDelta: appendTextDelta(
              existing?.payload?.textDelta || "",
              String(event.payload?.textDelta || ""),
            ),
            stream: event.payload?.stream || event.stream || "stdout",
          },
        });
        break;
      }
      case "patch.output.delta": {
        const syntheticId = timelinePatchOutputId(event);
        const existing = indexById.get(syntheticId) as PatchOutputDeltaEvent | undefined;
        upsertTimelineEvent(items, indexById, {
          ...cloneEvent(event),
          id: syntheticId,
          payload: {
            ...(event.payload || {}),
            textDelta: appendTextDelta(
              existing?.payload?.textDelta || "",
              String(event.payload?.textDelta || ""),
            ),
          },
        });
        break;
      }
      default:
        upsertTimelineEvent(items, indexById, event);
        break;
    }
  });

  return items.sort(compareEvents);
}

function paginateTimelineItems(
  items: SessionEventPayload[],
  options: TimelineOptions,
  lastSeq: number,
): SessionTimelinePage {
  const limit = clampLimit(options.limit);
  const after = normalizeCursor(options.after);
  const before = normalizeCursor(options.before);

  if (before > 0) {
    const matches = items.filter((item) => item.seq < before);
    const hasMoreBefore = matches.length > limit;
    const pageItems = matches.slice(Math.max(0, matches.length - limit));
    return {
      items: pageItems,
      nextCursor: pageItems.at(-1)?.seq || after,
      beforeCursor: pageItems[0]?.seq || before,
      hasMoreBefore,
      lastSeq,
    };
  }

  if (after > 0) {
    const pageItems = items.filter((item) => item.seq > after).slice(0, limit);
    return {
      items: pageItems,
      nextCursor: pageItems.at(-1)?.seq || after,
      beforeCursor: pageItems[0]?.seq || 0,
      hasMoreBefore: pageItems.length > 0 ? pageItems[0].seq > 1 : items.length > 0,
      lastSeq,
    };
  }

  const hasMoreBefore = items.length > limit;
  const pageItems = items.slice(Math.max(0, items.length - limit));
  return {
    items: pageItems,
    nextCursor: pageItems.at(-1)?.seq || 0,
    beforeCursor: pageItems[0]?.seq || 0,
    hasMoreBefore,
    lastSeq,
  };
}

export class SessionTimelineService {
  constructor(private readonly eventStore: EventStore) {}

  list(sessionId: string, options: TimelineOptions = {}): SessionTimelinePage {
    const rawEvents = this.eventStore.listAll(sessionId);
    const lastSeq = rawEvents.at(-1)?.seq || 0;
    const aggregatedItems = aggregateSemanticTimeline(rawEvents);
    return paginateTimelineItems(aggregatedItems, options, lastSeq);
  }
}
