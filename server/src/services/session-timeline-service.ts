import type { EventStore } from "./event-store";
import type { SessionEventPayload } from "../types/models";

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

export class SessionTimelineService {
  constructor(private readonly eventStore: EventStore) {}

  list(sessionId: string, options: TimelineOptions = {}): SessionTimelinePage {
    const page = this.eventStore.list(sessionId, options);
    return {
      ...page,
      // The initial detail load only needs the latest observed seq so resume sync
      // can continue from the newest page we fetched.
      lastSeq: page.nextCursor || Math.max(0, Number(options.after || 0)),
    };
  }
}
