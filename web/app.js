import {
  browseProjectDirectories,
  createProject,
  importCodexSession,
  createSession,
  getCodexHosts,
  getImportableCodexSessions,
  getCodexQuota,
  getCodexUiOptions,
  getCodexStatus,
  getHealth,
  getProjects,
  getSession,
  getSessionEvents,
  getSessionTimelineEvents,
  getSessions,
  resolveSessionApproval,
  retrySessionApproval,
  sendMessage,
  stopSession,
  syncImportedSession,
} from "./api.js";
import {
  CLIENT_FALLBACK_CODEX_UI_OPTIONS,
  adjustComposerHeight,
  bindComposerInputControls,
  buildCodexLaunchPayload,
  loadCodexLaunchPrefs,
  normalizeCodexLaunchAgainstUi,
  renderComposerInput,
} from "./components/composer.js";
import { renderSessionTopBar } from "./components/session-workbench.js";
import {
  normalizeRawSessionEvent,
  normalizeRawSessionEvents,
} from "./session-event-adapter.js";
import { renderRichText as renderMessageRichText } from "./message-rich-text.js";
import {
  formatInlineList,
  getCurrentLocale,
  getIntlLocale,
  listSupportedLocales,
  setCurrentLocale,
  t,
} from "./i18n/index.js";
import {
  buildTimelineView,
  createEmptyTimelineState,
  reduceTimeline,
  reduceTimelineBatch,
} from "./session-timeline-reducer.js";
import { renderTimeline, renderTimelineList } from "./session-timeline-renderer.js";
import { connectSessionSocket } from "./session-ws.js";

const app = document.querySelector("#app");
const SESSION_VIEW_STORAGE_KEY = "remote-agent-console.sessions.view";
const CODEX_QUOTA_CACHE_PREFIX = "remote-agent-console.codexQuota:";
const WORKSPACE_UI_STORAGE_KEY = "remote-agent-console.workspace.ui";
const SLOW_COMMAND_SECONDS = 5;
const LONG_RUNNING_COMMAND_SECONDS = 10;
const COMMAND_PREVIEW_HEAD_LINES = 3;
const COMMAND_PREVIEW_TAIL_LINES = 2;
const COMMAND_PREVIEW_MATCH_CONTEXT_LINES = 1;
const COMMAND_RUNNING_PREVIEW_LINES = 3;
const COMMAND_COLLAPSED_SUMMARY_MAX = 120;
const COMMAND_EXPANDED_OUTPUT_MAX_LINES = 80;
const INITIAL_DETAIL_EVENT_PAGE_LIMIT = 200;
const INITIAL_DETAIL_MIN_TURNS = 4;
const INITIAL_DETAIL_MAX_PAGES = 5;
const DETAIL_RENDER_BATCH_MS = 0;
let lastToastMessage = "";
let lastToastAt = 0;
const GENERIC_SESSION_TITLES = new Set([
  "未命名会话",
  "新会话",
  "Untitled session",
  "New session",
]);
const DEFAULT_SESSIONS_VIEW = {
  keyword: "",
  status: "all",
  projectId: "all",
  thread: "all",
  sort: "activity_desc",
  page: 1,
  pageSize: 8,
};
const DEFAULT_DETAIL_VIEW = {
  filter: "all",
  severity: "all",
  search: "",
  autoScroll: true,
  rawStdoutBuckets: {},
};

function renderAppChrome({
  variant,
  title,
  subtitle,
  backHref,
  bodyHtml,
  routeClass = "",
}) {
  const nav = `<nav class="app-top-nav" aria-label="${escapeHtml(t("nav.sessions"))}">
    <a href="#/projects" class="app-nav-link">${escapeHtml(t("nav.projects"))}</a>
    <a href="#/sessions" class="app-nav-link">${escapeHtml(t("nav.sessions"))}</a>
  </nav>`;

  if (variant === "marketing") {
    return `
      <div class="route-stack">
        <header class="hero app-hero-marketing">
          <div>
            <p class="eyebrow">RemCodex</p>
            <h1>${escapeHtml(t("marketing.headline"))}</h1>
            <p class="hero-copy">
              ${escapeHtml(t("marketing.copy"))}
            </p>
          </div>
          ${nav}
        </header>
        ${bodyHtml}
      </div>
    `;
  }

  const titles =
    title || subtitle
      ? `<div class="app-header-titles">
          ${title ? `<h1 class="app-header-title">${escapeHtml(title)}</h1>` : ""}
          ${subtitle ? `<p class="app-header-sub">${escapeHtml(subtitle)}</p>` : ""}
        </div>`
      : "";

  return `
    <div class="route-stack route-stack--compact ${escapeHtml(routeClass)}">
      <header class="app-header-compact">
        ${
          backHref
            ? `<a href="${escapeHtml(backHref)}" class="app-back-link">${escapeHtml(t("generic.back"))}</a>`
            : ""
        }
        <div class="app-header-compact-main">
          ${titles}
          ${nav}
        </div>
      </header>
      ${bodyHtml}
    </div>
  `;
}

function isMobileWorkspaceViewport() {
  return window.matchMedia("(max-width: 759px)").matches;
}

function readWorkspaceUiState() {
  try {
    const raw = window.localStorage?.getItem(WORKSPACE_UI_STORAGE_KEY);
    if (!raw) {
      return { sidebarCollapsed: false };
    }
    const parsed = JSON.parse(raw);
    return {
      sidebarCollapsed: Boolean(parsed?.sidebarCollapsed),
    };
  } catch {
    return { sidebarCollapsed: false };
  }
}

function writeWorkspaceUiState() {
  try {
    window.localStorage?.setItem(
      WORKSPACE_UI_STORAGE_KEY,
      JSON.stringify({
        sidebarCollapsed: Boolean(state.workspace.sidebarCollapsed),
      }),
    );
  } catch {
    /* ignore */
  }
}

function getCurrentPageHost() {
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  return typeof hostname === "string" ? hostname.trim() : "";
}

function applyDocumentLocale() {
  const locale = getCurrentLocale();
  document.documentElement.lang = locale;
  document.title = t("app.name");
}

function syncWorkspaceShellState() {
  const shell = document.querySelector(".workspace-shell");
  if (shell instanceof HTMLElement) {
    shell.classList.toggle("workspace-shell-collapsed", state.workspace.sidebarCollapsed);
  }

  const toggleButton = document.querySelector("#workspace-sidebar-toggle");
  if (toggleButton instanceof HTMLButtonElement) {
    toggleButton.setAttribute("aria-expanded", state.workspace.sidebarCollapsed ? "false" : "true");
    toggleButton.setAttribute(
      "aria-label",
      state.workspace.sidebarCollapsed ? t("workspace.openSidebar") : t("workspace.closeSidebar"),
    );
  }

  const overlay = document.querySelector("#workspace-sidebar-overlay");
  if (overlay instanceof HTMLElement) {
    overlay.classList.toggle("workspace-sidebar-overlay-visible", !state.workspace.sidebarCollapsed);
  }
}

function renderWorkspaceShell({ sidebarHtml = "", mainHtml = "" }) {
  return `
    <div class="workspace-shell ${state.workspace.sidebarCollapsed ? "workspace-shell-collapsed" : ""}">
      <div
        id="workspace-sidebar-overlay"
        class="workspace-sidebar-overlay ${state.workspace.sidebarCollapsed ? "" : "workspace-sidebar-overlay-visible"}"
      ></div>
      <aside id="workspace-sidebar" class="workspace-sidebar">
        ${sidebarHtml}
      </aside>
      <section class="workspace-main-frame">
        <div class="workspace-main-header">
          <button
            id="workspace-sidebar-toggle"
            type="button"
            class="workspace-sidebar-fab"
            aria-label="${escapeHtml(state.workspace.sidebarCollapsed ? t("workspace.openSidebar") : t("workspace.closeSidebar"))}"
            aria-expanded="${state.workspace.sidebarCollapsed ? "false" : "true"}"
            aria-controls="workspace-sidebar"
          >
            ☰
          </button>
        </div>
        <section id="workspace-main-slot" class="workspace-main-slot">
          ${mainHtml}
        </section>
      </section>
      <div id="workspace-modal-slot">
        ${renderWorkspaceModalSlot()}
      </div>
    </div>
  `;
}

function groupConversationTurns(items) {
  const turns = [];
  let current = null;

  const pushTurn = () => {
    if (current && (current.user || current.body.length > 0)) {
      turns.push(current);
    }
    current = null;
  };

  for (const item of items) {
    if (item.type === "user") {
      pushTurn();
      current = { user: item, body: [] };
    } else {
      if (!current) {
        current = { user: null, body: [] };
      }
      current.body.push(item);
    }
  }

  pushTurn();
  return turns;
}

function getTaskContainerElementId(taskKey) {
  return `task-${sanitizeDomIdSegment(taskKey || "unknown")}`;
}

// LEGACY: old task-block detail helpers are intentionally retained only as
// fallback utilities for side panels / incremental cleanup. The main session
// detail render path must stay on:
// rawEvents -> normalize -> reduce timeline -> buildTimelineView -> renderTimeline
// Do not reconnect these helpers to renderSessionDetail().
function groupEventTurns(events) {
  const turns = [];
  let current = null;

  const pushTurn = () => {
    if (current?.userEvent) {
      turns.push(current);
    }
    current = null;
  };

  events.forEach((event) => {
    if (event.type === "message.user") {
      pushTurn();
      current = { userEvent: event, events: [] };
      return;
    }

    if (!current) {
      return;
    }

    current.events.push(event);
  });

  pushTurn();
  return turns;
}

function buildTaskBlocks(events, options = {}) {
  const turns = groupEventTurns(events);
  const tasks = [];
  const lastUserTurnIndex = turns.reduce(
    (lastIndex, turn, index) => (turn.userEvent ? index : lastIndex),
    -1,
  );

  turns.forEach((turn, index) => {
    if (!turn.userEvent) {
      return;
    }

    if (!taskTurnMatchesOptions(turn, options)) {
      return;
    }

    tasks.push(
      buildTaskBlock(turn, {
        index: tasks.length,
        isLastTask: index === lastUserTurnIndex,
        sessionStatus: options.sessionStatus || "idle",
      }),
    );
  });

  return tasks;
}

function countUserTurns(events) {
  return events.reduce((count, event) => {
    const normalized = normalizeRawSessionEvent(event);
    return normalized?.kind === "user_message" ? count + 1 : count;
  }, 0);
}

function getLatestUserTaskKey(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "message.user" && event.id) {
      return `task:${event.id}`;
    }
  }

  return "";
}

async function loadInitialSessionEvents(sessionId) {
  const firstPage = await getSessionTimelineEvents(sessionId, {
    limit: INITIAL_DETAIL_EVENT_PAGE_LIMIT,
  });
  let items = Array.isArray(firstPage.items) ? [...firstPage.items] : [];
  let beforeCursor = firstPage.beforeCursor || 0;
  let hasMoreBefore = Boolean(firstPage.hasMoreBefore);
  let pagesLoaded = 1;

  while (
    hasMoreBefore &&
    beforeCursor > 1 &&
    countUserTurns(items) < INITIAL_DETAIL_MIN_TURNS &&
    pagesLoaded < INITIAL_DETAIL_MAX_PAGES
  ) {
    const nextPage = await getSessionTimelineEvents(sessionId, {
      before: beforeCursor,
      limit: INITIAL_DETAIL_EVENT_PAGE_LIMIT,
    });

    if (!Array.isArray(nextPage.items) || nextPage.items.length === 0) {
      hasMoreBefore = false;
      break;
    }

    items = [...nextPage.items, ...items];
    beforeCursor = nextPage.beforeCursor || beforeCursor;
    hasMoreBefore = Boolean(nextPage.hasMoreBefore);
    pagesLoaded += 1;
  }

  return {
    items,
    nextCursor: firstPage.nextCursor || 0,
    beforeCursor,
    hasMoreBefore,
    lastSeq: firstPage.lastSeq || firstPage.nextCursor || 0,
  };
}

function buildTimelineStateFromRawEvents(rawEvents) {
  const timelineState = createEmptyTimelineState();
  reduceTimelineBatch(timelineState, normalizeRawSessionEvents(rawEvents));
  return timelineState;
}

function replaceDetailTimelineRawEvents(rawEvents) {
  state.detail.rawEvents = [...rawEvents].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  state.detail.timelineState = buildTimelineStateFromRawEvents(state.detail.rawEvents);
  state.detail.timelineItems = buildTimelineView(state.detail.timelineState);
  maybeClearOptimisticSendFromTimeline();
}

function clearOptimisticSend(options = {}) {
  const optimistic = state.detail.optimisticSend;
  if (!optimistic) {
    return;
  }

  const {
    restoreDraft = null,
    restoreSession = false,
    restoreTitle = false,
  } = options;

  state.detail.optimisticSend = null;

  if (restoreSession && state.detail.session) {
    state.detail.session.status = optimistic.previousStatus || "waiting_input";
    state.detail.session.liveBusy = Boolean(optimistic.previousLiveBusy);
    state.detail.session.updatedAt = optimistic.previousUpdatedAt || state.detail.session.updatedAt;
  }

  if (restoreTitle && optimistic.titleWasUpdated && state.detail.session) {
    state.detail.session.title = optimistic.previousTitle || "";
    state.sessions.items = state.sessions.items.map((item) =>
      item.sessionId === optimistic.sessionId ? { ...item, title: optimistic.previousTitle || "" } : item,
    );
  }

  if (typeof restoreDraft === "string") {
    state.detail.draft = restoreDraft;
    const composerTextarea = document.querySelector('textarea[name="content"]');
    if (composerTextarea instanceof HTMLTextAreaElement) {
      composerTextarea.value = restoreDraft;
      adjustComposerHeight(composerTextarea);
      window.requestAnimationFrame(() => adjustComposerHeight(composerTextarea));
      composerTextarea.focus();
    }
  }
}

function maybeClearOptimisticSendFromTimeline() {
  const optimistic = state.detail.optimisticSend;
  if (!optimistic?.confirmed) {
    return;
  }

  if (!state.detail.session?.liveBusy) {
    state.detail.optimisticSend = null;
    return;
  }

  const turnId = optimistic.turnId;
  if (!turnId) {
    return;
  }

  const hasFollowupItem = state.detail.timelineItems.some(
    (item) => item.turnId === turnId && item.type !== "user",
  );
  const turn = state.detail.timelineState?.turnsById?.[turnId] || null;

  if (
    hasFollowupItem ||
    turn?.status === "running" ||
    turn?.status === "completed" ||
    turn?.status === "failed" ||
    turn?.status === "aborted"
  ) {
    state.detail.optimisticSend = null;
  }
}

function getDisplayTimelineItems() {
  const optimistic = state.detail.optimisticSend;
  const items = state.detail.timelineItems.filter(
    (item) => !(item.synthetic && item.type === "reasoning" && item.status === "thinking"),
  );
  const session = state.detail.session;
  if (!optimistic) {
    if (!isSessionLiveBusy(session)) {
      return items;
    }

    const activeTurn = getActiveTimelineTurn(session);
    const lastSeq = Number(items[items.length - 1]?.seq || 0);
    const lastTimestamp =
      activeTurn?.startedAt ||
      session?.updatedAt ||
      items[items.length - 1]?.timestamp ||
      new Date().toISOString();
    const placeholderTurnId =
      activeTurn?.id ||
      items[items.length - 1]?.turnId ||
      `turn:thinking:${session?.sessionId || "detail"}`;

    return [
      ...items,
      {
        id: `thinking:${placeholderTurnId}`,
        type: "reasoning",
        turnId: placeholderTurnId,
        seq: lastSeq + 0.001,
        timestamp: lastTimestamp,
        status: "thinking",
        summary: t("timeline.thinking"),
        text: "",
        synthetic: true,
      },
    ];
  }

  const displayItems = [...items];
  const optimisticTurnId = optimistic.turnId || optimistic.tempTurnId;
  const optimisticTimestamp = optimistic.createdAt || new Date().toISOString();
  const latestUser = [...displayItems].reverse().find((item) => item.type === "user") || null;
  const hasRealUser = displayItems.some(
    (item) =>
      item.type === "user" &&
      ((optimistic.turnId && item.turnId === optimistic.turnId) ||
        (!optimistic.turnId &&
          latestUser &&
          item.id === latestUser.id &&
          item.text === optimistic.text)),
  );

  if (!hasRealUser) {
    const lastSeq = Number(displayItems[displayItems.length - 1]?.seq || 0);
    displayItems.push({
      id: optimistic.userItemId,
      type: "user",
      turnId: optimisticTurnId,
      seq: lastSeq + 0.001,
      timestamp: optimisticTimestamp,
      role: "user",
      text: optimistic.text,
      optimistic: true,
    });
  }

  const shouldShowThinking = Boolean(optimistic) || isSessionLiveBusy(session);
  if (shouldShowThinking) {
    const activeTurn = getActiveTimelineTurn(session);
    const lastSeq = Number(displayItems[displayItems.length - 1]?.seq || 0);
    const placeholderTurnId =
      activeTurn?.id ||
      optimisticTurnId ||
      displayItems[displayItems.length - 1]?.turnId ||
      `turn:thinking:${session?.sessionId || "detail"}`;
    displayItems.push({
      id: optimistic.thinkingItemId || `thinking:${placeholderTurnId}`,
      type: "reasoning",
      turnId: placeholderTurnId,
      seq: lastSeq + 0.001,
      timestamp:
        activeTurn?.startedAt ||
        session?.updatedAt ||
        optimisticTimestamp,
      status: "thinking",
      summary: t("timeline.thinking"),
      text: "",
      synthetic: true,
      optimistic: Boolean(optimistic),
    });
  }

  return displayItems;
}

function getPendingApprovalFromTimelineState(timelineState) {
  if (!timelineState || !timelineState.approvalsByRequestId) {
    return null;
  }
  const sessionId = String(state.detail.session?.sessionId || state.workspace.activeSessionId || "").trim();

  const pendingApproval = Object.values(timelineState.approvalsByRequestId)
    .filter(
      (item) =>
        item?.status === "pending" &&
        !isApprovalDismissed(sessionId, item?.requestId) &&
        !isApprovalSuppressed(sessionId, item?.requestId),
    )
    .sort((left, right) => Number(right?.seq || 0) - Number(left?.seq || 0))[0];

  if (!pendingApproval) {
    return null;
  }

  return {
    requestId: pendingApproval.requestId,
    callId: pendingApproval.callId || null,
    title: localizeApprovalTitle(pendingApproval.title),
    reason: pendingApproval.reason || "",
    command: pendingApproval.command || "",
    cwd: pendingApproval.cwd || "",
    resumable: pendingApproval.resumable !== false,
  };
}

function resolveDetailPendingApproval(session, timelineState) {
  const timelinePending = getPendingApprovalFromTimelineState(timelineState);
  const sessionPending = session?.pendingApproval || null;
  const liveBusy = session?.liveBusy === true;
  const sessionId = String(session?.sessionId || "").trim();
  const canResolve = liveBusy && sessionPending?.resumable !== false;

  if (!timelinePending) {
    return sessionPending &&
      !isApprovalDismissed(sessionId, sessionPending.requestId, sessionPending.callId) &&
      !isApprovalSuppressed(sessionId, sessionPending.requestId, sessionPending.callId)
      ? sessionPending
      : null;
  }

  return {
    ...timelinePending,
    ...(sessionPending && sessionPending.requestId === timelinePending.requestId ? sessionPending : {}),
    resumable: canResolve,
  };
}

function isApprovalSuppressed(sessionId, requestId, callId = "") {
  const suppressedSessionId = String(state.detail.resolvingApprovalSessionId || "").trim();
  const suppressedRequestId = String(state.detail.resolvingApprovalRequestId || "").trim();
  const suppressedCallId = String(state.detail.resolvingApprovalCallId || "").trim();
  const nextSessionId = String(sessionId || "").trim();
  const nextRequestId = String(requestId || "").trim();
  const nextCallId = String(callId || "").trim();

  if (!suppressedSessionId || !suppressedRequestId || !nextSessionId || !nextRequestId) {
    return false;
  }
  if (suppressedSessionId !== nextSessionId || suppressedRequestId !== nextRequestId) {
    return false;
  }
  if (suppressedCallId && nextCallId) {
    return suppressedCallId === nextCallId;
  }
  return true;
}

function getApprovalDismissalKey(sessionId, requestId) {
  return `${String(sessionId || "").trim()}:${String(requestId || "").trim()}`;
}

function isApprovalDismissed(sessionId, requestId) {
  const key = getApprovalDismissalKey(sessionId, requestId);
  if (!key || key === ":") {
    return false;
  }
  return Boolean(state.detail.dismissedApprovalKeys?.[key]);
}

function dismissApproval(sessionId, requestId) {
  const key = getApprovalDismissalKey(sessionId, requestId);
  if (!key || key === ":") {
    return;
  }
  state.detail.dismissedApprovalKeys = {
    ...(state.detail.dismissedApprovalKeys || {}),
    [key]: true,
  };
}

function isTerminalApprovalError(error) {
  const message = messageOf(error);
  return (
    message === "Approval request not found." ||
    message === "Approval request can no longer be resumed."
  );
}

function clearResolvingApprovalState() {
  state.detail.resolvingApprovalRequestId = "";
  state.detail.resolvingApprovalSessionId = "";
  state.detail.resolvingApprovalCallId = "";
}

function syncDetailPendingApproval(session = state.detail.session, timelineState = state.detail.timelineState) {
  state.detail.pendingApproval = resolveDetailPendingApproval(session, timelineState);

  const suppressedSessionId = String(state.detail.resolvingApprovalSessionId || "").trim();
  const suppressedRequestId = String(state.detail.resolvingApprovalRequestId || "").trim();
  if (!suppressedSessionId || !suppressedRequestId) {
    return state.detail.pendingApproval;
  }

  const sessionPending = session?.pendingApproval || null;
  const timelinePending = timelineState?.approvalsByRequestId
    ? Object.values(timelineState.approvalsByRequestId).some(
        (item) =>
          item?.status === "pending" &&
          !isApprovalDismissed(session?.sessionId, item?.requestId) &&
          isApprovalSuppressed(session?.sessionId, item?.requestId),
      )
    : false;
  const detailPending =
    state.detail.pendingApproval &&
    isApprovalSuppressed(
      session?.sessionId,
      state.detail.pendingApproval.requestId,
      state.detail.pendingApproval.callId,
    );
  const sessionStillPending =
    sessionPending &&
    !isApprovalDismissed(session?.sessionId, sessionPending.requestId, sessionPending.callId) &&
    isApprovalSuppressed(session?.sessionId, sessionPending.requestId, sessionPending.callId);

  if (!timelinePending && !detailPending && !sessionStillPending) {
    clearResolvingApprovalState();
  }

  return state.detail.pendingApproval;
}

function mergeDetailTimelineRawEvents(nextRawEvents) {
  if (!Array.isArray(nextRawEvents) || nextRawEvents.length === 0) {
    return;
  }

  const activeSessionId = getActiveDetailSessionId();
  if (!activeSessionId) {
    return;
  }

  const filteredRawEvents = nextRawEvents.filter((rawEvent) => {
    const eventSessionId = String(rawEvent?.sessionId || rawEvent?.session_id || "").trim();
    return !eventSessionId || eventSessionId === activeSessionId;
  });

  if (filteredRawEvents.length === 0) {
    return;
  }

  const existingIds = new Set(state.detail.rawEvents.map((event) => event.id));
  const currentMaxSeq = state.detail.rawEvents.reduce(
    (maxSeq, event) => Math.max(maxSeq, Number(event?.seq || 0)),
    0,
  );
  const appended = [];
  let canApplyIncrementally = true;

  filteredRawEvents.forEach((rawEvent) => {
    if (!rawEvent?.id || existingIds.has(rawEvent.id)) {
      return;
    }

    existingIds.add(rawEvent.id);
    appended.push(rawEvent);
    if (Number(rawEvent.seq || 0) < currentMaxSeq) {
      canApplyIncrementally = false;
    }
  });

  if (appended.length === 0) {
    return;
  }

  state.detail.rawEvents = [...state.detail.rawEvents, ...appended].sort(
    (a, b) => (a.seq || 0) - (b.seq || 0),
  );

  if (!canApplyIncrementally) {
    state.detail.timelineState = buildTimelineStateFromRawEvents(state.detail.rawEvents);
    state.detail.timelineItems = buildTimelineView(state.detail.timelineState);
    maybeClearOptimisticSendFromTimeline();
    syncDetailPendingApproval(state.detail.session, state.detail.timelineState);
    return;
  }

  const normalizedAppended = normalizeRawSessionEvents(appended);
  reduceTimelineBatch(state.detail.timelineState, normalizedAppended);
  state.detail.timelineItems = buildTimelineView(state.detail.timelineState);
  maybeClearOptimisticSendFromTimeline();
  syncDetailPendingApproval(state.detail.session, state.detail.timelineState);
}

function getActiveDetailSessionId() {
  return String(state.workspace.activeSessionId || state.detail.session?.sessionId || "").trim();
}

function isActiveDetailSession(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  return Boolean(normalizedSessionId) && getActiveDetailSessionId() === normalizedSessionId;
}

async function catchUpSessionEvents(sessionId, afterSeq) {
  const normalizedSessionId = String(sessionId || "").trim();
  let nextAfter = Number(afterSeq || 0);
  if (!normalizedSessionId || !nextAfter || !isActiveDetailSession(normalizedSessionId)) {
    return;
  }

  for (let page = 0; page < 10; page += 1) {
    if (!isActiveDetailSession(normalizedSessionId)) {
      return;
    }

    const payload = await getSessionEvents(normalizedSessionId, {
      after: nextAfter,
      limit: 200,
    });
    if (!isActiveDetailSession(normalizedSessionId)) {
      return;
    }

    const items = Array.isArray(payload?.items)
      ? payload.items.filter((item) => {
          const eventSessionId = String(item?.sessionId || item?.session_id || "").trim();
          return !eventSessionId || eventSessionId === normalizedSessionId;
        })
      : [];
    if (items.length === 0) {
      return;
    }

    trackUnseenEvents(items);
    mergeDetailTimelineRawEvents(items);
    nextAfter = Number(payload?.nextCursor || nextAfter);
    state.detail.cursor = Math.max(state.detail.cursor, nextAfter);

    if (items.length < 200) {
      return;
    }
  }
}

function patchTimelineListDom(list, items, options = {}) {
  if (!list) {
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = renderTimelineList(items, options).trim();
  const nextList = template.content.firstElementChild;
  if (!nextList) {
    list.innerHTML = "";
    return;
  }

  const currentChildren = Array.from(list.children);
  const nextChildren = Array.from(nextList.children);
  let diffIndex = 0;

  while (diffIndex < currentChildren.length && diffIndex < nextChildren.length) {
    const currentNode = currentChildren[diffIndex];
    const nextNode = nextChildren[diffIndex];
    const currentId = currentNode.getAttribute("data-timeline-id") || "";
    const nextId = nextNode.getAttribute("data-timeline-id") || "";

    if (currentId !== nextId) {
      break;
    }

    if (currentNode.outerHTML !== nextNode.outerHTML) {
      if (!patchTimelineRowDom(currentNode, nextNode)) {
        break;
      }
    }

    diffIndex += 1;
  }

  for (let index = currentChildren.length - 1; index >= diffIndex; index -= 1) {
    currentChildren[index].remove();
  }

  for (let index = diffIndex; index < nextChildren.length; index += 1) {
    list.appendChild(nextChildren[index].cloneNode(true));
  }
}

function patchTimelineRowDom(currentNode, nextNode) {
  if (!currentNode || !nextNode) {
    return false;
  }

  const patchInner = (selector) => {
    const currentInner = currentNode.querySelector(selector);
    const nextInner = nextNode.querySelector(selector);
    if (!currentInner || !nextInner) {
      return false;
    }
    if (currentInner.innerHTML !== nextInner.innerHTML) {
      currentInner.innerHTML = nextInner.innerHTML;
    }
    return true;
  };

  if (
    currentNode.classList.contains("timeline-row-final") ||
    currentNode.classList.contains("timeline-row-commentary") ||
    currentNode.classList.contains("timeline-row-user")
  ) {
    currentNode.replaceWith(nextNode.cloneNode(true));
    return true;
  }

  if (currentNode.classList.contains("timeline-row-reasoning")) {
    currentNode.replaceWith(nextNode.cloneNode(true));
    return true;
  }

  if (
    currentNode.classList.contains("timeline-row-command") ||
    currentNode.classList.contains("timeline-row-patch")
  ) {
    const currentCard = currentNode.querySelector(".timeline-card");
    const nextCard = nextNode.querySelector(".timeline-card");
    const currentInline = currentNode.querySelector(".timeline-inline-step");
    const nextInline = nextNode.querySelector(".timeline-inline-step");
    const currentDetails = currentNode.querySelector("details");
    const nextDetails = nextNode.querySelector("details");
    const currentTitle = currentNode.querySelector(".timeline-card-title");
    const nextTitle = nextNode.querySelector(".timeline-card-title");
    const currentMeta = currentNode.querySelector(".timeline-card-meta");
    const nextMeta = nextNode.querySelector(".timeline-card-meta");
    const currentBody = currentNode.querySelector(".timeline-card-body");
    const nextBody = nextNode.querySelector(".timeline-card-body");

    if (currentInline || nextInline) {
      if (!currentInline || !nextInline) {
        currentNode.replaceWith(nextNode.cloneNode(true));
        return true;
      }

      const currentRow = currentInline.querySelector(".task-step-row");
      const nextRow = nextInline.querySelector(".task-step-row");
      const currentLabel = currentInline.querySelector(".task-step-label");
      const nextLabel = nextInline.querySelector(".task-step-label");
      const currentStepMeta = currentInline.querySelector(".task-step-meta");
      const nextStepMeta = nextInline.querySelector(".task-step-meta");
      const currentInlineDetail = currentInline.querySelector(
        ".assistant-command-item-inline-detail, .timeline-inline-detail-row",
      );
      const nextInlineDetail = nextInline.querySelector(
        ".assistant-command-item-inline-detail, .timeline-inline-detail-row",
      );

      if (!currentRow || !nextRow || !currentLabel || !nextLabel) {
        currentNode.replaceWith(nextNode.cloneNode(true));
        return true;
      }

      currentNode.className = nextNode.className;
      currentInline.className = nextInline.className;
      currentRow.className = nextRow.className;
      currentLabel.textContent = nextLabel.textContent || "";

      if (currentStepMeta && nextStepMeta) {
        currentStepMeta.textContent = nextStepMeta.textContent || "";
      } else if (!currentStepMeta && nextStepMeta) {
        currentRow.insertAdjacentHTML("beforeend", nextStepMeta.outerHTML);
      } else if (currentStepMeta && !nextStepMeta) {
        currentStepMeta.remove();
      }

      if (currentInlineDetail && nextInlineDetail) {
        if (currentInlineDetail.tagName === "DETAILS" && nextInlineDetail.tagName === "DETAILS") {
          currentInlineDetail.open = nextInlineDetail.open;
        }
        if (currentInlineDetail.innerHTML !== nextInlineDetail.innerHTML) {
          currentInlineDetail.innerHTML = nextInlineDetail.innerHTML;
        }
      } else if (!currentInlineDetail && nextInlineDetail) {
        currentInline.insertAdjacentHTML("beforeend", nextInlineDetail.outerHTML);
      } else if (currentInlineDetail && !nextInlineDetail) {
        currentInlineDetail.remove();
      }

      return true;
    }

    if (
      !currentCard ||
      !nextCard ||
      !currentDetails ||
      !nextDetails ||
      !currentTitle ||
      !nextTitle ||
      !currentMeta ||
      !nextMeta ||
      !currentBody ||
      !nextBody
    ) {
      return false;
    }

    currentCard.className = nextCard.className;
    currentDetails.open = nextDetails.open;
    currentTitle.textContent = nextTitle.textContent || "";
    currentMeta.textContent = nextMeta.textContent || "";
    if (currentBody.innerHTML !== nextBody.innerHTML) {
      currentBody.innerHTML = nextBody.innerHTML;
    }
    return true;
  }

  return false;
}

function patchTopBarDom(slot, nextHtml) {
  if (!slot) {
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = nextHtml.trim();
  const nextRoot = template.content.firstElementChild;
  const currentRoot = slot.firstElementChild;

  if (!nextRoot) {
    slot.innerHTML = "";
    return;
  }

  if (!currentRoot || currentRoot.tagName !== nextRoot.tagName) {
    slot.innerHTML = nextHtml;
    return;
  }

  const selectors = [
    ".session-topbar-mobile-center",
    ".session-topbar-main",
    ".session-topbar-meta",
  ];

  selectors.forEach((selector) => {
    const currentNode = currentRoot.querySelector(selector);
    const nextNode = nextRoot.querySelector(selector);
    if (!currentNode || !nextNode) {
      return;
    }
    if (currentNode.innerHTML !== nextNode.innerHTML) {
      currentNode.innerHTML = nextNode.innerHTML;
    }
  });
}

function taskTurnMatchesOptions(turn, options = {}) {
  const allEvents = [turn.userEvent, ...turn.events].filter(Boolean);
  if (allEvents.length === 0) {
    return false;
  }

  return allEvents.some((event) => matchesEventOptions(event, options));
}

function buildTaskBlock(turn, context = {}) {
  const taskKey = `task:${turn.userEvent.id || context.index}`;
  const executionEvents = [...turn.events];
  const commandRanges = listCommandGroupRanges(executionEvents);
  const consumedIndexes = new Set();
  commandRanges.forEach(({ start, end }) => {
    for (let index = start; index <= end; index += 1) {
      consumedIndexes.add(index);
    }
  });

  const commandGroups = commandRanges.map((range) => range.group);
  const assistantEvents = executionEvents.filter(
    (event) => event.type === "cli.chunk" && event.stream === "assistant",
  );
  const statusEvents = executionEvents.filter((event) => event.type === "session.status");
  const noticeEvents = executionEvents.filter(
    (event) =>
      event.type === "system.notice" &&
      !isTranscriptMetaSkip(event) &&
      !isCommandStartNotice(event) &&
      !isCommandEndNotice(event),
  );
  const exitEvents = executionEvents.filter((event) => event.type === "cli.exit");
  const orphanStdoutEvents = executionEvents.filter(
    (event, index) =>
      event.type === "cli.chunk" &&
      event.stream === "stdout" &&
      !consumedIndexes.has(index),
  );
  const orphanStderrEvents = executionEvents.filter(
    (event, index) =>
      event.type === "cli.chunk" &&
      event.stream === "stderr" &&
      !consumedIndexes.has(index),
  );
  const finalText = assistantEvents
    .map((event) => event.content || "")
    .join("")
    .trim();
  const fallbackText = !finalText
    ? orphanStdoutEvents
        .map((event) => event.content || "")
        .join("\n")
        .trim()
    : "";
  const executionStatus = deriveTaskExecutionStatus({
    statusEvents,
    commandGroups,
    finalText: finalText || fallbackText,
    exitEvents,
    sessionStatus: context.sessionStatus,
    isLastTask: Boolean(context.isLastTask),
  });
  const steps = buildTaskSteps({
    commandGroups,
    statusEvents,
    noticeEvents,
    finalText: finalText || fallbackText,
    sessionStatus: context.sessionStatus,
    isLastTask: Boolean(context.isLastTask),
  });
  const assistantMessage = buildAssistantMessage({
    finalText,
    fallbackText,
    executionStatus,
    noticeEvents,
    steps,
  });

  return {
    key: taskKey,
    index: context.index || 0,
    user: {
      event: turn.userEvent,
      text: turn.userEvent.content || "",
    },
    executionEvents,
    commandGroups,
    statusEvents,
    noticeEvents,
    exitEvents,
    orphanStdoutEvents,
    orphanStderrEvents,
    finalText,
    assistantText: assistantMessage.mainText,
    assistantMessage,
    executionStatus,
    steps,
    startedAt: turn.userEvent.ts || 0,
  };
}

function buildAssistantMessage({
  finalText,
  fallbackText,
  executionStatus,
  noticeEvents,
  steps,
}) {
  return {
    mainText: finalText || "",
    stateLabel: getTaskExecutionLineLabelFromStatus(executionStatus.id),
    detailText: "",
    hasNaturalResponse: Boolean(finalText),
  };
}

function deriveTaskExecutionStatus({
  statusEvents,
  commandGroups,
  finalText,
  exitEvents = [],
  sessionStatus,
  isLastTask,
}) {
  const lastStatus = statusEvents.at(-1)?.status;
  let status = lastStatus || "";

  if (
    !status &&
    isLastTask &&
    sessionStatus &&
    ["waiting_input", "completed", "failed", "idle"].includes(sessionStatus)
  ) {
    status = sessionStatus;
  }

  if (!status && commandGroups.some((group) => !group.endEvent)) {
    status = isLastTask ? sessionStatus || "running" : "running";
  }

  if (!status && finalText) {
    status = "completed";
  }

  if (!status) {
    const exitCode = exitEvents.at(-1)?.exitCode;
    if (typeof exitCode === "number") {
      status = exitCode === 0 ? "completed" : "failed";
    }
  }

  if (!status && isLastTask && sessionStatus && sessionStatus !== "idle") {
    status = sessionStatus;
  }

  if (!status) {
    status = "idle";
  }

  return {
    id: status,
    label: sessionStatusLabel(status),
    className: statusClass(status),
  };
}

function buildTaskSteps({
  commandGroups,
  statusEvents,
  noticeEvents,
  finalText,
  sessionStatus,
  isLastTask,
}) {
  const steps = [];

  commandGroups.forEach((group) => {
    const exitCode = getCommandExitCode(group.endEvent);
    const timing = describeCommandTiming(group);
    const preview = describeCommandPreview(group);
    const presentation = describeCommandPresentation(group, preview);
    const baseLabel = shortenText(group.command || t("inspect.commandUnknown"), 60);
    const assumeFinishedFromSession =
      !group.endEvent && Boolean(isLastTask) && !isSessionBusy(sessionStatus);
    const commandStillRunning = !group.endEvent && !assumeFinishedFromSession;

    let label = t("task.commandExecuted", { label: baseLabel });
    if (commandStillRunning) {
      label = t("task.commandRunning", { label: baseLabel });
    } else if (exitCode && exitCode !== "0") {
      label = t("task.commandFailed", { label: baseLabel });
    }

    const meta = [];
    if (group.outputCount > 0) {
      meta.push(t("command.outputCount", { count: group.outputCount }));
    }
    if (group.stderrCount > 0) {
      meta.push(t("command.stderrCount", { count: group.stderrCount }));
    }
    if (timing) {
      meta.push(timing.label);
    }

    steps.push({
      kind: "command",
      groupId: group.id,
      group,
      label,
      meta: meta.join(" · "),
      status: commandStillRunning ? presentation.status : exitCode && exitCode !== "0" ? "error" : "success",
      previewLines: presentation.previewLines,
      collapsedSummary: presentation.collapsedSummary,
      detailSummary: presentation.detailSummary,
      defaultExpanded: commandStillRunning || (exitCode && exitCode !== "0"),
    });
  });

  noticeEvents
    .filter((event) => event.level === "error" || event.level === "warning")
    .slice(0, 2)
    .forEach((event) => {
      steps.push({
        kind: event.level === "error" ? "error" : "warning",
        label: shortenText(event.content || t("inspect.systemNotice"), 88),
        meta: "",
        status: event.level === "error" ? "error" : "warning",
        previewLines: [],
        collapsedSummary: shortenText(event.content || t("inspect.systemNotice"), 120),
        detailSummary: event.content || "",
        defaultExpanded: event.level === "error",
      });
    });

  if (steps.length === 0 && statusEvents.length > 0) {
    const lastStatus = statusEvents.at(-1);
    const statusLabel = getTaskExecutionLineLabelFromStatus(lastStatus.status);
    steps.push({
      kind: "status",
      label: statusLabel,
      meta: "",
      status: lastStatus.status || "idle",
      previewLines: [],
      collapsedSummary: statusLabel,
      detailSummary: statusLabel,
      defaultExpanded: false,
    });
  }

  return dedupeTaskSteps(steps).slice(0, 6);
}

function getTaskExecutionLineLabelFromStatus(status) {
  if (status === "failed") {
    return t("session.status.failed");
  }

  if (status === "starting" || status === "running" || status === "stopping") {
    return t("task.processing");
  }

  if (status === "waiting_input" || status === "completed" || status === "idle") {
    return t("session.status.completed");
  }

  return sessionStatusLabel(status || "idle");
}

function dedupeTaskSteps(steps) {
  const out = [];
  const seen = new Set();

  steps.forEach((step) => {
    const key = `${step.kind}:${step.label}:${step.meta}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    out.push(step);
  });

  return out;
}

const state = {
  route: "",
  ws: null,
  socketState: "closed",
  ui: {
    locale: getCurrentLocale(),
  },
  workspace: {
    sidebarCollapsed: readWorkspaceUiState().sidebarCollapsed,
    localeMenuOpen: false,
    activeSessionId: "",
    createDialog: {
      open: false,
      mode: "pick-project",
      submitting: false,
      selectedProjectId: "",
      projectName: "",
      projectPath: "",
      browserLoading: false,
      browserCurrentPath: "",
      browserParentPath: "",
      browserItems: [],
      error: "",
    },
    importDialog: {
      open: false,
      loading: false,
      submitting: false,
      items: [],
      query: "",
      selectedRolloutPath: "",
      error: "",
    },
  },
  sessions: {
    items: [],
    projects: [],
    ...DEFAULT_SESSIONS_VIEW,
  },
  detail: {
    session: null,
    rawEvents: [],
    timelineState: createEmptyTimelineState(),
    timelineItems: [],
    optimisticSend: null,
    cursor: 0,
    beforeCursor: 0,
    historyHasMore: false,
    historyLoading: false,
    draft: "",
    unseenCount: 0,
    searchMatchIndex: 0,
    activeSearchResultKey: "",
    commandGroups: {},
    rawStdoutBuckets: {},
    codexLaunch: null,
    codexUiOptions: null,
    codexStatus: null,
    codexQuota: null,
    pendingApproval: null,
    dismissedApprovalKeys: {},
    resolvingApprovalRequestId: "",
    resolvingApprovalSessionId: "",
    resolvingApprovalCallId: "",
    taskDetails: {},
    remoteHosts: [],
    activeRemoteHost: "",
    activeTaskStartedAt: 0,
    liveExecutionTaskKey: "",
    liveClockId: 0,
    liveResumeTimerId: 0,
    importedSyncTimerId: 0,
    composerEnvironmentMenuOpen: false,
    slashMenuOpen: false,
    slashCommands: [],
    slashCommandsLoading: false,
    slashQuery: "",
    slashActiveIndex: 0,
    slashExecuting: false,
    inspectDrawerOpen: false,
    inspectSelectionKey: "",
    renderTimerId: 0,
    loadRequestId: 0,
    resumeSyncInFlight: false,
    lastResumeSyncAt: 0,
    ...DEFAULT_DETAIL_VIEW,
  },
};

applyDocumentLocale();
window.addEventListener("hashchange", renderRoute);
window.addEventListener("load", renderRoute);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void resumeActiveSessionDetail("visibility");
  }
});
window.addEventListener("focus", () => {
  void resumeActiveSessionDetail("focus");
});
window.addEventListener("pageshow", () => {
  void resumeActiveSessionDetail("pageshow");
});

function renderRoute() {
  state.detail.loadRequestId = Number(state.detail.loadRequestId || 0) + 1;
  cleanupSocket();
  cleanupDetailClock();
  cleanupLiveResumeSync();
  cleanupImportedSessionSync();
  disconnectConversationLayoutObserver();
  if (state.detail.renderTimerId) {
    window.clearTimeout(state.detail.renderTimerId);
    state.detail.renderTimerId = 0;
  }

  const hash = window.location.hash || "#/sessions";
  const route = parseHashRoute(hash);
  state.route = hash;

  const matched = route.path.match(/^#\/sessions\/([^/]+)$/);
  hydrateSessionsViewState("");
  if (matched) {
    hydrateSessionDetailViewState(route.query);
  } else {
    state.detail = {
      ...state.detail,
      ...DEFAULT_DETAIL_VIEW,
      optimisticSend: null,
    };
  }

  renderWorkspacePage(matched?.[1] || "");
}

function getWorkspaceFilteredSessions() {
  const projectMap = new Map(state.sessions.projects.map((project) => [project.projectId, project]));
  const filtered = state.sessions.items.filter((session) =>
    matchesSessionFilters(session, projectMap.get(session.projectId), state.sessions),
  );
  return sortSessions(filtered, state.sessions.sort);
}

function resolveWorkspaceSessionId(routeSessionId) {
  const availableIds = new Set(state.sessions.items.map((session) => session.sessionId));
  if (routeSessionId && availableIds.has(routeSessionId)) {
    return routeSessionId;
  }

  if (state.workspace.activeSessionId && availableIds.has(state.workspace.activeSessionId)) {
    return state.workspace.activeSessionId;
  }

  return getWorkspaceFilteredSessions()[0]?.sessionId || state.sessions.items[0]?.sessionId || "";
}

function renderWorkspaceEmptyState() {
  return `
    <section class="workspace-empty-state">
      <p class="workspace-empty-eyebrow">${escapeHtml(t("workspace.empty.eyebrow"))}</p>
      <h2>${escapeHtml(t("workspace.empty.title"))}</h2>
      <p>${escapeHtml(t("workspace.empty.subtitle"))}</p>
      <div class="workspace-empty-actions">
        <button id="workspace-empty-create-session" type="button" class="primary-button">${escapeHtml(t("workspace.empty.newSession"))}</button>
        <button id="workspace-empty-import-session" type="button" class="secondary-button">${escapeHtml(t("workspace.empty.importCodex"))}</button>
      </div>
    </section>
  `;
}

function deriveProjectNameFromPath(pathValue) {
  const normalized = String(pathValue || "").trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function joinProjectPath(basePath, projectName) {
  const normalizedBase = String(basePath || "").trim().replace(/[\\/]+$/, "");
  const normalizedName = String(projectName || "").trim().replace(/^[\\/]+/, "");
  if (!normalizedBase) {
    return normalizedName;
  }
  if (!normalizedName) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedName}`;
}

function normalizeProjectPathForComparison(pathValue) {
  return String(pathValue || "").trim().replace(/[\\/]+$/, "");
}

function findExistingProjectByPath(pathValue) {
  const normalizedTargetPath = normalizeProjectPathForComparison(pathValue);
  if (!normalizedTargetPath) {
    return null;
  }

  return (
    state.sessions.projects.find(
      (project) => normalizeProjectPathForComparison(project.path) === normalizedTargetPath,
    ) || null
  );
}

function getDefaultWorkspaceProjectBrowsePath() {
  return normalizeProjectPathForComparison(
    state.detail.session?.projectPath || state.sessions.projects[0]?.path || "",
  );
}

function shouldAutotitleSession(session) {
  const title = String(session?.title || "").trim();
  return !title || GENERIC_SESSION_TITLES.has(title);
}

function deriveSessionTitleFromMessage(message) {
  const normalized = String(message || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return t("workspace.session.untitled");
  }
  if (normalized.length <= 28) {
    return normalized;
  }
  return `${normalized.slice(0, 27)}…`;
}

function renderWorkspaceCreateSessionDialog() {
  const dialogState = state.workspace.createDialog;
  if (!dialogState.open) {
    return "";
  }

  const projects = Array.isArray(state.sessions.projects) ? state.sessions.projects : [];
  const selectedProject =
    projects.find((project) => project.projectId === dialogState.selectedProjectId) || projects[0] || null;

  if (dialogState.mode === "pick-project") {
    return `
      <div class="workspace-modal-overlay"></div>
      <section class="workspace-dialog" aria-label="${escapeHtml(t("workspace.empty.newSession"))}">
        <div class="workspace-dialog-head">
          <div>
            <p class="workspace-dialog-eyebrow">${escapeHtml(t("workspace.create.eyebrow"))}</p>
            <h2 class="workspace-dialog-title">${escapeHtml(t("workspace.create.pickProjectTitle"))}</h2>
          </div>
          <button id="workspace-create-dialog-close" type="button" class="secondary-button">${escapeHtml(t("workspace.create.close"))}</button>
        </div>
        <div class="workspace-dialog-body">
          ${
            projects.length === 0
              ? `<div class="workspace-dialog-empty">${escapeHtml(t("workspace.create.noProjects"))}</div>`
              : `
                <div class="workspace-dialog-list">
                  ${projects
                    .map((project) => {
                      const active = project.projectId === selectedProject?.projectId;
                      return `
                        <button
                          type="button"
                          class="workspace-dialog-item ${active ? "workspace-dialog-item-active" : ""}"
                          data-select-project="${project.projectId}"
                        >
                          <div class="workspace-dialog-item-head">
                            <span class="workspace-dialog-item-title">${escapeHtml(project.name || t("workspace.project.untitled"))}</span>
                          </div>
                          <div class="workspace-dialog-item-subtle">${escapeHtml(shortenText(project.path || "", 100))}</div>
                        </button>
                      `;
                    })
                    .join("")}
                </div>
              `
          }
        </div>
        <div class="workspace-dialog-foot workspace-dialog-foot-split">
          <div class="workspace-dialog-secondary-actions">
            <button id="workspace-open-project-directory" type="button" class="secondary-button">${escapeHtml(t("workspace.create.chooseDirectory"))}</button>
          </div>
          <button
            id="workspace-create-session-submit"
            type="button"
            class="primary-button"
            ${selectedProject && !dialogState.submitting ? "" : "disabled"}
          >
            ${escapeHtml(dialogState.submitting ? t("workspace.create.processing") : t("workspace.create.startSession"))}
          </button>
        </div>
      </section>
    `;
  }

  const title = t("workspace.create.directoryTitle");
  const primaryLabel = dialogState.submitting ? t("workspace.create.processing") : t("workspace.create.startSession");
  const browserItems = Array.isArray(dialogState.browserItems) ? dialogState.browserItems : [];
  const browserPathValue = dialogState.browserCurrentPath || dialogState.projectPath || "";
  const canBrowseUp = Boolean(browserPathValue);

  return `
    <div class="workspace-modal-overlay"></div>
    <section class="workspace-dialog" aria-label="${escapeHtml(title)}">
      <div class="workspace-dialog-head">
        <div>
          <p class="workspace-dialog-eyebrow">${escapeHtml(t("generic.project"))}</p>
          <h2 class="workspace-dialog-title">${escapeHtml(title)}</h2>
        </div>
        <button id="workspace-create-dialog-close" type="button" class="secondary-button">${escapeHtml(t("workspace.create.close"))}</button>
      </div>
      <div class="workspace-dialog-form">
        <label class="workspace-dialog-field">
          <span>${escapeHtml(t("workspace.create.projectName"))}</span>
          <input
            id="workspace-project-name"
            class="workspace-dialog-input"
            value="${escapeHtml(dialogState.projectName)}"
            placeholder="${escapeHtml(t("workspace.create.projectNamePlaceholder"))}"
          />
        </label>
        <div class="workspace-dialog-help">
          ${escapeHtml(t("workspace.create.projectHelp"))}
        </div>
        <div class="workspace-dialog-field">
          <span>${escapeHtml(t("workspace.create.currentDirectory"))}</span>
          <div class="workspace-directory-browser">
            <div class="workspace-directory-browser-bar">
              <input
                id="workspace-project-browser-path"
                class="workspace-dialog-input workspace-directory-browser-path-input"
                value="${escapeHtml(browserPathValue)}"
                placeholder="${escapeHtml(t("workspace.create.pathPlaceholder"))}"
              />
              <div class="workspace-directory-browser-actions">
                ${
                  canBrowseUp
                    ? `<button id="workspace-project-browse-up" type="button" class="secondary-button">${escapeHtml(t("workspace.create.upOneLevel"))}</button>`
                    : ""
                }
              </div>
            </div>
            ${
              dialogState.browserLoading
                ? `<div class="workspace-dialog-empty">${escapeHtml(t("workspace.create.loadingDirectories"))}</div>`
                : browserItems.length
                  ? `
                    <div class="workspace-dialog-list workspace-directory-browser-list">
                      ${browserItems
                        .map((item) => {
                          const active = item.path === dialogState.projectPath;
                          return `
                            <button
                              type="button"
                              class="workspace-dialog-item ${active ? "workspace-dialog-item-active" : ""}"
                              data-browse-path="${escapeHtml(item.path)}"
                            >
                              <div class="workspace-dialog-item-head">
                                <span class="workspace-dialog-item-title">${escapeHtml(item.name || item.path)}</span>
                              </div>
                              <div class="workspace-dialog-item-subtle">${escapeHtml(shortenText(item.path || "", 100))}</div>
                            </button>
                          `;
                        })
                        .join("")}
                    </div>
                  `
                  : `<div class="workspace-dialog-empty">${escapeHtml(t("workspace.create.noChildDirectories"))}</div>`
            }
          </div>
        </div>
        ${dialogState.error ? `<div class="workspace-dialog-error">${escapeHtml(dialogState.error)}</div>` : ""}
      </div>
      <div class="workspace-dialog-foot workspace-dialog-foot-split">
        <button id="workspace-create-dialog-back" type="button" class="secondary-button">${escapeHtml(t("workspace.create.backToProjects"))}</button>
        <button id="workspace-project-submit" type="button" class="primary-button">${escapeHtml(primaryLabel)}</button>
      </div>
    </section>
  `;
}

function getWorkspaceImportDialogItems() {
  const query = String(state.workspace.importDialog.query || "").trim().toLowerCase();
  const items = Array.isArray(state.workspace.importDialog.items) ? state.workspace.importDialog.items : [];
  if (!query) {
    return items;
  }

  return items.filter((item) => {
    const haystack = [
      item.title,
      item.codexSessionId,
      item.cwd,
      item.rolloutPath,
      item.importedSessionId,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function getSelectedWorkspaceImportItem() {
  const items = Array.isArray(state.workspace.importDialog.items) ? state.workspace.importDialog.items : [];
  const selectedPath = String(state.workspace.importDialog.selectedRolloutPath || "");
  return items.find((item) => item.rolloutPath === selectedPath) || null;
}

function renderWorkspaceImportDialog() {
  const dialogState = state.workspace.importDialog;
  if (!dialogState.open) {
    return "";
  }

  const visibleItems = getWorkspaceImportDialogItems();
  const selected =
    visibleItems.find((item) => item.rolloutPath === dialogState.selectedRolloutPath) ||
    visibleItems[0] ||
    null;
  const primaryLabel = selected?.importedSessionId ? t("workspace.import.syncLatest") : t("workspace.import.importSession");

  return `
    <div class="workspace-import-dialog-overlay"></div>
    <section class="workspace-import-dialog" aria-label="${escapeHtml(t("workspace.import.title"))}">
      <div class="workspace-import-dialog-head">
        <div>
          <p class="workspace-import-dialog-eyebrow">${escapeHtml(t("workspace.import.eyebrow"))}</p>
          <h2 class="workspace-import-dialog-title">${escapeHtml(t("workspace.import.title"))}</h2>
        </div>
        <button id="workspace-import-dialog-close" type="button" class="secondary-button">${escapeHtml(t("workspace.create.close"))}</button>
      </div>
      <div class="workspace-import-dialog-toolbar">
        <input
          id="workspace-import-dialog-search"
          class="workspace-import-dialog-search"
          placeholder="${escapeHtml(t("workspace.import.searchPlaceholder"))}"
          value="${escapeHtml(dialogState.query)}"
        />
      </div>
      <div class="workspace-import-dialog-body">
        ${
          dialogState.loading
            ? `<div class="workspace-import-dialog-empty">${escapeHtml(t("workspace.import.loading"))}</div>`
            : dialogState.error
              ? `<div class="workspace-import-dialog-empty">${escapeHtml(dialogState.error)}</div>`
              : visibleItems.length === 0
                ? `<div class="workspace-import-dialog-empty">${escapeHtml(t("workspace.import.empty"))}</div>`
                : `
                  <div class="workspace-import-dialog-list">
                    ${visibleItems
                      .map((item) => {
                        const selectedItem = selected?.rolloutPath === item.rolloutPath;
                        const importedLabel = item.importedSessionId ? t("workspace.import.imported") : t("workspace.import.available");
                        const updatedLabel = item.updatedAt ? formatElapsedSinceIso(item.updatedAt) : "--";
                        return `
                          <button
                            type="button"
                            class="workspace-import-dialog-item ${selectedItem ? "workspace-import-dialog-item-active" : ""}"
                            data-import-rollout="${escapeHtml(item.rolloutPath)}"
                          >
                            <div class="workspace-import-dialog-item-head">
                              <span class="workspace-import-dialog-item-title">${escapeHtml(item.title || item.codexSessionId || t("workspace.session.untitled"))}</span>
                              <span class="pill ${item.importedSessionId ? "pill-neutral" : "pill-success"}">${escapeHtml(importedLabel)}</span>
                            </div>
                            <div class="workspace-import-dialog-item-meta">
                              <span>${escapeHtml(shortenText(item.cwd || item.rolloutPath, 72))}</span>
                              <span>${escapeHtml(updatedLabel)}</span>
                            </div>
                            <div class="workspace-import-dialog-item-subtle">${escapeHtml(shortenText(item.codexSessionId || item.rolloutPath, 90))}</div>
                          </button>
                        `;
                      })
                      .join("")}
                  </div>
                `
        }
      </div>
      <div class="workspace-import-dialog-foot">
        <div class="workspace-import-dialog-foot-note">
          ${
            selected
              ? selected.importedSessionId
                ? escapeHtml(t("workspace.import.syncToExisting", { sessionId: selected.importedSessionId }))
                : escapeHtml(t("workspace.import.importSelected", { title: selected.title || selected.codexSessionId || t("workspace.session.untitled") }))
              : escapeHtml(t("workspace.import.chooseSession"))
          }
        </div>
        <button
          id="workspace-import-dialog-submit"
          type="button"
          class="primary-button"
          ${selected && !dialogState.loading && !dialogState.submitting ? "" : "disabled"}
        >
          ${escapeHtml(dialogState.submitting ? t("workspace.create.processing") : primaryLabel)}
        </button>
      </div>
    </section>
  `;
}

function renderWorkspaceModalSlot() {
  return `${renderWorkspaceCreateSessionDialog()}${renderWorkspaceImportDialog()}`;
}

function renderWorkspaceSidebar(selectedSessionId = "") {
  const projectMap = new Map(state.sessions.projects.map((project) => [project.projectId, project]));
  const filteredSessions = getWorkspaceFilteredSessions();
  const localeOptions = listSupportedLocales();

  return `
    <div class="workspace-sidebar-shell">
      <div class="workspace-sidebar-head">
        <div class="workspace-sidebar-brand">
          <p class="workspace-sidebar-eyebrow">RemCodex</p>
        </div>
        <div class="workspace-sidebar-head-actions">
          <div class="workspace-sidebar-locale">
            <button
              id="workspace-locale-toggle"
              type="button"
              class="workspace-sidebar-locale-btn"
              aria-label="${escapeHtml(t("workspace.language.select"))}"
              title="${escapeHtml(t("workspace.language.select"))}"
              aria-expanded="${state.workspace.localeMenuOpen ? "true" : "false"}"
              aria-haspopup="menu"
            >
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <circle cx="12" cy="12" r="8"></circle>
                <path d="M4 12h16"></path>
                <path d="M12 4c2.4 2.2 3.8 5 3.8 8s-1.4 5.8-3.8 8c-2.4-2.2-3.8-5-3.8-8s1.4-5.8 3.8-8z"></path>
              </svg>
            </button>
            ${
              state.workspace.localeMenuOpen
                ? `
                  <div id="workspace-locale-menu" class="workspace-sidebar-locale-menu" role="menu" aria-label="${escapeHtml(t("workspace.language.select"))}">
                    ${localeOptions
                      .map(
                        (option) => `
                          <button
                            type="button"
                            class="workspace-sidebar-locale-option ${getCurrentLocale() === option.id ? "workspace-sidebar-locale-option-active" : ""}"
                            data-workspace-locale="${escapeHtml(option.id)}"
                            role="menuitemradio"
                            aria-checked="${getCurrentLocale() === option.id ? "true" : "false"}"
                          >
                            ${escapeHtml(option.label)}
                          </button>
                        `,
                      )
                      .join("")}
                  </div>
                `
                : ""
            }
          </div>
          <button id="workspace-import-session" type="button" class="workspace-sidebar-import-btn" title="${escapeHtml(t("workspace.sidebar.import"))}" aria-label="${escapeHtml(t("workspace.sidebar.import"))}">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M12 4v10"></path>
              <path d="M8 10l4 4 4-4"></path>
              <path d="M4 18v2h16v-2"></path>
            </svg>
          </button>
          <button id="workspace-sidebar-close" type="button" class="workspace-sidebar-close" aria-label="${escapeHtml(t("workspace.closeSidebar"))}">
            ☰
          </button>
        </div>
      </div>

      <div class="workspace-sidebar-actions">
        <button id="workspace-create-session" type="button" class="primary-button">${escapeHtml(t("workspace.sidebar.newSession"))}</button>
      </div>

      <div class="workspace-session-list" id="workspace-session-list">
        ${
          filteredSessions.length > 0
            ? filteredSessions
                .map((session) => {
                  const project = projectMap.get(session.projectId);
                  const displayStatus = getSessionDisplayStatus(session);
                  const showStatusPill = ["starting", "running", "stopping", "failed"].includes(displayStatus);
                  const selected = session.sessionId === selectedSessionId;
                  return `
                    <button
                      type="button"
                      class="workspace-session-item ${selected ? "workspace-session-item-active" : ""}"
                      data-open-session="${session.sessionId}"
                    >
                      <div class="workspace-session-item-head">
                        <span class="workspace-session-item-title">${escapeHtml(session.title || t("workspace.session.untitled"))}</span>
                        ${showStatusPill ? `<span class="pill ${statusClass(displayStatus)}">${escapeHtml(sessionStatusLabel(displayStatus))}</span>` : ""}
                      </div>
                      <div class="workspace-session-item-meta">
                        <span>${escapeHtml(project?.name || session.projectId)}</span>
                      </div>
                      ${
                        session.lastAssistantContent
                          ? `<div class="workspace-session-item-preview">${escapeHtml(shortenText(session.lastAssistantContent, 90))}</div>`
                          : session.lastCommand
                            ? `<div class="workspace-session-item-preview">${escapeHtml(shortenText(session.lastCommand, 90))}</div>`
                            : ""
                      }
                    </button>
                  `;
                })
                .join("")
            : `<div class="workspace-session-empty">${escapeHtml(t("workspace.sidebar.empty"))}</div>`
        }
      </div>
    </div>
  `;
}

function patchWorkspaceSidebar(selectedSessionId = "") {
  const slot = document.querySelector("#workspace-sidebar");
  if (!(slot instanceof HTMLElement)) {
    return;
  }

  slot.innerHTML = renderWorkspaceSidebar(selectedSessionId);
  bindWorkspaceSidebarControls(selectedSessionId);
}

function patchWorkspaceModalSlot() {
  const slot = document.querySelector("#workspace-modal-slot");
  if (!(slot instanceof HTMLElement)) {
    return;
  }

  slot.innerHTML = renderWorkspaceModalSlot();
  bindWorkspaceCreateDialogControls();
  bindWorkspaceImportDialogControls();
}

function isComposerTextareaFocused() {
  const activeElement = document.activeElement;
  return (
    activeElement instanceof HTMLTextAreaElement &&
    activeElement.name === "content" &&
    Boolean(activeElement.closest("#session-composer-slot"))
  );
}

function closeWorkspaceCreateDialog() {
  state.workspace.createDialog.open = false;
  state.workspace.createDialog.mode = "pick-project";
  state.workspace.createDialog.submitting = false;
  state.workspace.createDialog.selectedProjectId = "";
  state.workspace.createDialog.projectName = "";
  state.workspace.createDialog.projectPath = "";
  state.workspace.createDialog.browserLoading = false;
  state.workspace.createDialog.browserCurrentPath = "";
  state.workspace.createDialog.browserParentPath = "";
  state.workspace.createDialog.browserItems = [];
  state.workspace.createDialog.error = "";
  patchWorkspaceModalSlot();
}

function openWorkspaceCreateSessionDialog() {
  const projects = Array.isArray(state.sessions.projects) ? state.sessions.projects : [];
  const preferredProjectId =
    state.detail.session?.projectId && projects.some((project) => project.projectId === state.detail.session.projectId)
      ? state.detail.session.projectId
      : projects[0]?.projectId || "";
  state.workspace.createDialog.open = true;
  state.workspace.createDialog.mode = "pick-project";
  state.workspace.createDialog.submitting = false;
  state.workspace.createDialog.selectedProjectId = preferredProjectId;
  state.workspace.createDialog.projectName = "";
  state.workspace.createDialog.projectPath = "";
  state.workspace.createDialog.browserLoading = false;
  state.workspace.createDialog.browserCurrentPath = "";
  state.workspace.createDialog.browserParentPath = "";
  state.workspace.createDialog.browserItems = [];
  state.workspace.createDialog.error = "";
  patchWorkspaceModalSlot();
}

async function submitWorkspaceCreateSession() {
  const projectId = String(state.workspace.createDialog.selectedProjectId || "").trim();
  if (!projectId) {
    return;
  }

  state.workspace.createDialog.submitting = true;
  patchWorkspaceModalSlot();

  try {
    const session = await createSession({ projectId });
    closeWorkspaceCreateDialog();
    window.location.hash = buildSessionDetailHash(
      session.sessionId,
      state.detail.filter,
      state.detail.severity,
      state.detail.search,
      state.detail.autoScroll,
    );
  } catch (error) {
    state.workspace.createDialog.submitting = false;
    state.workspace.createDialog.error = messageOf(error);
    patchWorkspaceModalSlot();
  }
}

async function submitWorkspaceProjectDialog() {
  const pathValue = String(state.workspace.createDialog.projectPath || "").trim();
  const requestedProjectName = String(state.workspace.createDialog.projectName || "").trim();
  const createInSelectedDirectory = Boolean(requestedProjectName);
  const nameValue = createInSelectedDirectory ? requestedProjectName : deriveProjectNameFromPath(pathValue);

  if (!pathValue) {
    state.workspace.createDialog.error = t("workspace.create.pathRequired");
    patchWorkspaceModalSlot();
    return;
  }

  state.workspace.createDialog.submitting = true;
  state.workspace.createDialog.error = "";
  patchWorkspaceModalSlot();

  try {
    const targetPath = createInSelectedDirectory ? joinProjectPath(pathValue, nameValue) : pathValue;
    const project =
      findExistingProjectByPath(targetPath) ||
      (await createProject({
        name: nameValue,
        path: targetPath,
        createMissing: createInSelectedDirectory,
      }));
    const session = await createSession({ projectId: project.projectId });
    closeWorkspaceCreateDialog();
    window.location.hash = buildSessionDetailHash(
      session.sessionId,
      state.detail.filter,
      state.detail.severity,
      state.detail.search,
      state.detail.autoScroll,
    );
  } catch (error) {
    state.workspace.createDialog.submitting = false;
    state.workspace.createDialog.error = messageOf(error);
    patchWorkspaceModalSlot();
  }
}

async function loadWorkspaceProjectBrowser(pathValue = "") {
  state.workspace.createDialog.browserLoading = true;
  state.workspace.createDialog.error = "";
  patchWorkspaceModalSlot();

  try {
    const result = await browseProjectDirectories(pathValue);
    state.workspace.createDialog.browserCurrentPath = String(result?.currentPath || "");
    state.workspace.createDialog.projectPath = String(result?.currentPath || "");
    state.workspace.createDialog.browserParentPath = String(result?.parentPath || "");
    state.workspace.createDialog.browserItems = Array.isArray(result?.items) ? result.items : [];
    state.workspace.createDialog.browserLoading = false;
  } catch (error) {
    state.workspace.createDialog.browserLoading = false;
    state.workspace.createDialog.error = messageOf(error);
  }

  patchWorkspaceModalSlot();
}

function openWorkspaceProjectCreateMode(mode) {
  state.workspace.createDialog.mode = mode;
  state.workspace.createDialog.projectName = "";
  state.workspace.createDialog.projectPath = "";
  state.workspace.createDialog.browserLoading = false;
  state.workspace.createDialog.browserCurrentPath = "";
  state.workspace.createDialog.browserParentPath = "";
  state.workspace.createDialog.browserItems = [];
  state.workspace.createDialog.error = "";
  patchWorkspaceModalSlot();
  void loadWorkspaceProjectBrowser(getDefaultWorkspaceProjectBrowsePath());
}

function closeWorkspaceImportDialog() {
  state.workspace.importDialog.open = false;
  state.workspace.importDialog.loading = false;
  state.workspace.importDialog.submitting = false;
  state.workspace.importDialog.query = "";
  state.workspace.importDialog.selectedRolloutPath = "";
  state.workspace.importDialog.error = "";
  patchWorkspaceModalSlot();
}

async function openWorkspaceImportDialog() {
  state.workspace.importDialog.open = true;
  state.workspace.importDialog.loading = true;
  state.workspace.importDialog.submitting = false;
  state.workspace.importDialog.query = "";
  state.workspace.importDialog.selectedRolloutPath = "";
  state.workspace.importDialog.error = "";
  patchWorkspaceModalSlot();

  try {
    const importable = await getImportableCodexSessions();
    const items = Array.isArray(importable?.items) ? importable.items : [];
    state.workspace.importDialog.items = items;
    state.workspace.importDialog.loading = false;
    state.workspace.importDialog.selectedRolloutPath = items[0]?.rolloutPath || "";
  } catch (error) {
    state.workspace.importDialog.loading = false;
    state.workspace.importDialog.error = messageOf(error);
  }

  patchWorkspaceModalSlot();
}

async function submitWorkspaceImportDialog() {
  const selected = getSelectedWorkspaceImportItem();
  if (!selected) {
    return;
  }

  state.workspace.importDialog.submitting = true;
  patchWorkspaceModalSlot();

  try {
    let sessionId = selected.importedSessionId || "";
    if (sessionId) {
      await syncImportedSession(sessionId);
    } else {
      const result = await importCodexSession({ rolloutPath: selected.rolloutPath });
      sessionId = String(result?.sessionId || "").trim();
    }

    closeWorkspaceImportDialog();

    if (sessionId) {
      if (state.workspace.activeSessionId === sessionId) {
        await renderSessionDetailPage(sessionId);
        patchWorkspaceSidebar(sessionId);
      } else {
        window.location.hash = buildSessionDetailHash(
          sessionId,
          state.detail.filter,
          state.detail.severity,
          state.detail.search,
          state.detail.autoScroll,
        );
      }
    }
  } catch (error) {
    state.workspace.importDialog.submitting = false;
    state.workspace.importDialog.error = messageOf(error);
    patchWorkspaceModalSlot();
  }
}

function bindWorkspaceImportDialogControls() {
  const overlay = document.querySelector(".workspace-import-dialog-overlay");
  if (overlay instanceof HTMLElement) {
    overlay.onclick = () => {
      closeWorkspaceImportDialog();
    };
  }

  const closeButton = document.querySelector("#workspace-import-dialog-close");
  if (closeButton instanceof HTMLButtonElement) {
    closeButton.onclick = () => {
      closeWorkspaceImportDialog();
    };
  }

  const searchInput = document.querySelector("#workspace-import-dialog-search");
  if (searchInput instanceof HTMLInputElement) {
    searchInput.oninput = (event) => {
      state.workspace.importDialog.query = event.currentTarget.value;
      const visibleItems = getWorkspaceImportDialogItems();
      if (!visibleItems.some((item) => item.rolloutPath === state.workspace.importDialog.selectedRolloutPath)) {
        state.workspace.importDialog.selectedRolloutPath = visibleItems[0]?.rolloutPath || "";
      }
      patchWorkspaceModalSlot();
    };
  }

  document.querySelectorAll("[data-import-rollout]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.onclick = () => {
      state.workspace.importDialog.selectedRolloutPath = button.getAttribute("data-import-rollout") || "";
      patchWorkspaceModalSlot();
    };
  });

  const submitButton = document.querySelector("#workspace-import-dialog-submit");
  if (submitButton instanceof HTMLButtonElement) {
    submitButton.onclick = async () => {
      await submitWorkspaceImportDialog();
    };
  }
}

function bindWorkspaceCreateDialogControls() {
  const overlay = document.querySelector(".workspace-modal-overlay");
  if (overlay instanceof HTMLElement) {
    overlay.onclick = () => {
      closeWorkspaceCreateDialog();
    };
  }

  const closeButton = document.querySelector("#workspace-create-dialog-close");
  if (closeButton instanceof HTMLButtonElement) {
    closeButton.onclick = () => {
      closeWorkspaceCreateDialog();
    };
  }

  const backButton = document.querySelector("#workspace-create-dialog-back");
  if (backButton instanceof HTMLButtonElement) {
    backButton.onclick = () => {
      state.workspace.createDialog.mode = "pick-project";
      state.workspace.createDialog.projectName = "";
      state.workspace.createDialog.projectPath = "";
      state.workspace.createDialog.browserLoading = false;
      state.workspace.createDialog.browserCurrentPath = "";
      state.workspace.createDialog.browserParentPath = "";
      state.workspace.createDialog.browserItems = [];
      state.workspace.createDialog.error = "";
      patchWorkspaceModalSlot();
    };
  }

  const createProjectButton = document.querySelector("#workspace-open-project-directory");
  if (createProjectButton instanceof HTMLButtonElement) {
    createProjectButton.onclick = () => {
      openWorkspaceProjectCreateMode("project-directory");
    };
  }

  const nameInput = document.querySelector("#workspace-project-name");
  if (nameInput instanceof HTMLInputElement) {
    nameInput.oninput = (event) => {
      state.workspace.createDialog.projectName = event.currentTarget.value;
    };
  }

  const pathInput = document.querySelector("#workspace-project-browser-path");
  if (pathInput instanceof HTMLInputElement) {
    pathInput.oninput = (event) => {
      const value = event.currentTarget.value;
      state.workspace.createDialog.browserCurrentPath = value;
      state.workspace.createDialog.projectPath = value;
    };
    pathInput.onkeydown = async (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      const nextPath = String(pathInput.value || "").trim();
      if (!nextPath) {
        return;
      }
      await loadWorkspaceProjectBrowser(nextPath);
    };
  }

  const browseUpButton = document.querySelector("#workspace-project-browse-up");
  if (browseUpButton instanceof HTMLButtonElement) {
    browseUpButton.onclick = async () => {
      const nextPath =
        String(state.workspace.createDialog.browserParentPath || "").trim() ||
        "";
      await loadWorkspaceProjectBrowser(nextPath);
    };
  }

  document.querySelectorAll("[data-browse-path]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    };
    button.onclick = async () => {
      const nextPath = button.getAttribute("data-browse-path") || "";
      await loadWorkspaceProjectBrowser(nextPath);
    };
  });

  document.querySelectorAll("[data-select-project]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.onclick = () => {
      state.workspace.createDialog.selectedProjectId = button.getAttribute("data-select-project") || "";
      patchWorkspaceModalSlot();
    };
  });

  const submitSessionButton = document.querySelector("#workspace-create-session-submit");
  if (submitSessionButton instanceof HTMLButtonElement) {
    submitSessionButton.onclick = async () => {
      await submitWorkspaceCreateSession();
    };
  }

  const submitProjectButton = document.querySelector("#workspace-project-submit");
  if (submitProjectButton instanceof HTMLButtonElement) {
    submitProjectButton.onclick = async () => {
      await submitWorkspaceProjectDialog();
    };
  }
}

function bindWorkspaceSidebarControls(selectedSessionId = "") {
  const toggleButton = document.querySelector("#workspace-sidebar-toggle");
  if (toggleButton instanceof HTMLButtonElement) {
    toggleButton.onclick = () => {
      state.workspace.sidebarCollapsed = !state.workspace.sidebarCollapsed;
      state.workspace.localeMenuOpen = false;
      writeWorkspaceUiState();
      syncWorkspaceShellState();
      patchWorkspaceSidebar(selectedSessionId);
    };
  }

  const overlay = document.querySelector("#workspace-sidebar-overlay");
  if (overlay instanceof HTMLElement) {
    overlay.onclick = () => {
      if (state.workspace.sidebarCollapsed) {
        return;
      }
      state.workspace.sidebarCollapsed = true;
      state.workspace.localeMenuOpen = false;
      writeWorkspaceUiState();
      syncWorkspaceShellState();
      patchWorkspaceSidebar(selectedSessionId);
    };
  }

  const closeButton = document.querySelector("#workspace-sidebar-close");
  if (closeButton instanceof HTMLButtonElement) {
    closeButton.onclick = () => {
      state.workspace.sidebarCollapsed = true;
      state.workspace.localeMenuOpen = false;
      writeWorkspaceUiState();
      syncWorkspaceShellState();
      patchWorkspaceSidebar(selectedSessionId);
    };
  }

  const localeToggle = document.querySelector("#workspace-locale-toggle");
  if (localeToggle instanceof HTMLButtonElement) {
    localeToggle.onclick = (event) => {
      event.stopPropagation();
      state.workspace.localeMenuOpen = !state.workspace.localeMenuOpen;
      patchWorkspaceSidebar(selectedSessionId);
    };
  }

  document.querySelectorAll("[data-workspace-locale]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.onclick = () => {
      const nextLocale = String(button.dataset.workspaceLocale || "").trim();
      if (!nextLocale) {
        return;
      }
      state.workspace.localeMenuOpen = false;
      state.ui.locale = setCurrentLocale(nextLocale);
      applyDocumentLocale();
      renderRoute();
    };
  });

  const createButton = document.querySelector("#workspace-create-session");
  if (createButton instanceof HTMLButtonElement) {
    createButton.onclick = async () => {
      state.workspace.localeMenuOpen = false;
      try {
        openWorkspaceCreateSessionDialog();
      } catch (error) {
        showToast(messageOf(error));
      }
    };
  }

  const importButton = document.querySelector("#workspace-import-session");
  if (importButton instanceof HTMLButtonElement) {
    importButton.onclick = async () => {
      state.workspace.localeMenuOpen = false;
      try {
        await handleImportCodexSession();
      } catch (error) {
        showToast(messageOf(error));
      }
    };
  }

  const emptyCreateButton = document.querySelector("#workspace-empty-create-session");
  if (emptyCreateButton instanceof HTMLButtonElement) {
    emptyCreateButton.onclick = async () => {
      try {
        openWorkspaceCreateSessionDialog();
      } catch (error) {
        showToast(messageOf(error));
      }
    };
  }

  const emptyImportButton = document.querySelector("#workspace-empty-import-session");
  if (emptyImportButton instanceof HTMLButtonElement) {
    emptyImportButton.onclick = async () => {
      try {
        await handleImportCodexSession();
      } catch (error) {
        showToast(messageOf(error));
      }
    };
  }

  const searchInput = document.querySelector("#workspace-session-search");
  if (searchInput instanceof HTMLInputElement) {
    searchInput.oninput = (event) => {
      state.sessions.keyword = event.currentTarget.value;
      patchWorkspaceSidebar(selectedSessionId);
    };
  }

  const statusSelect = document.querySelector("#workspace-session-status");
  if (statusSelect instanceof HTMLSelectElement) {
    statusSelect.onchange = (event) => {
      state.sessions.status = event.currentTarget.value;
      patchWorkspaceSidebar(selectedSessionId);
    };
  }

  const projectSelect = document.querySelector("#workspace-session-project");
  if (projectSelect instanceof HTMLSelectElement) {
    projectSelect.onchange = (event) => {
      state.sessions.projectId = event.currentTarget.value;
      patchWorkspaceSidebar(selectedSessionId);
    };
  }

  document.querySelectorAll("[data-open-session]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.onclick = () => {
      const sessionId = button.getAttribute("data-open-session");
      if (!sessionId || sessionId === selectedSessionId) {
        return;
      }
      if (isMobileWorkspaceViewport()) {
        state.workspace.sidebarCollapsed = true;
        writeWorkspaceUiState();
        syncWorkspaceShellState();
      }
      window.location.hash = buildSessionDetailHash(
        sessionId,
        state.detail.filter,
        state.detail.severity,
        state.detail.search,
        state.detail.autoScroll,
      );
    };
  });
}

async function renderWorkspacePage(routeSessionId) {
  if (isMobileWorkspaceViewport()) {
    state.workspace.sidebarCollapsed = true;
  }

  app.innerHTML = renderWorkspaceShell({
    sidebarHtml: renderWorkspaceSidebar(""),
    mainHtml: loadingCard(t("workspace.loading.session")),
  });
  syncWorkspaceShellState();
  bindWorkspaceCreateDialogControls();
  bindWorkspaceImportDialogControls();

  try {
    const [sessions, projects] = await Promise.all([getSessions(), getProjects()]);
    state.sessions.items = sessions.items;
    state.sessions.projects = projects.items;

    const selectedSessionId = resolveWorkspaceSessionId(routeSessionId);
    state.workspace.activeSessionId = selectedSessionId;

    patchWorkspaceSidebar(selectedSessionId);

    if (!selectedSessionId) {
      const mainSlot = document.querySelector("#workspace-main-slot");
      if (mainSlot) {
        mainSlot.innerHTML = renderWorkspaceEmptyState();
      }
      bindWorkspaceSidebarControls("");
      return;
    }

    if (routeSessionId !== selectedSessionId) {
      const nextHash = buildSessionDetailHash(
        selectedSessionId,
        state.detail.filter,
        state.detail.severity,
        state.detail.search,
        state.detail.autoScroll,
      );
      if (window.history && typeof window.history.replaceState === "function") {
        window.history.replaceState(null, "", nextHash);
        state.route = nextHash;
      } else {
        window.location.hash = nextHash;
        return;
      }
    }

    await renderSessionDetailPage(selectedSessionId);
    patchWorkspaceSidebar(selectedSessionId);
  } catch (error) {
    app.innerHTML = renderWorkspaceShell({
      sidebarHtml: renderWorkspaceSidebar(""),
      mainHtml: errorCard(messageOf(error)),
    });
    syncWorkspaceShellState();
    bindWorkspaceCreateDialogControls();
    bindWorkspaceImportDialogControls();
    bindWorkspaceSidebarControls("");
  }
}

async function renderProjectsPage() {
  app.innerHTML = renderAppChrome({
    variant: "marketing",
    bodyHtml: loadingCard(t("workspace.loading.projects")),
  });

  try {
    const [projects, health] = await Promise.all([getProjects(), getHealth()]);

    app.innerHTML = renderAppChrome({
      variant: "marketing",
      bodyHtml: `
      <section class="stack">
        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">${escapeHtml(t("projects.runtimeEyebrow"))}</p>
              <h2>${escapeHtml(t("projects.healthTitle"))}</h2>
            </div>
            <span class="pill pill-success">${escapeHtml(t("generic.online"))}</span>
          </div>
          <div class="meta-grid">
            <div>
              <span class="meta-label">${escapeHtml(t("projects.codexCommand"))}</span>
              <strong>${escapeHtml(health.codexCommand)}</strong>
            </div>
            <div>
              <span class="meta-label">${escapeHtml(t("projects.executionMode"))}</span>
              <strong>${escapeHtml(health.codexMode || "unknown")}</strong>
            </div>
            <div>
              <span class="meta-label">${escapeHtml(t("projects.projectRoots"))}</span>
              <strong>${escapeHtml((health.projectRoots || []).join(", "))}</strong>
            </div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">${escapeHtml(t("projects.registryEyebrow"))}</p>
              <h2>${escapeHtml(t("projects.addTitle"))}</h2>
            </div>
          </div>
          <form id="project-form" class="form-stack">
            <label>
              <span>${escapeHtml(t("projects.name"))}</span>
              <input name="name" placeholder="${escapeHtml(t("projects.namePlaceholder"))}" required />
            </label>
            <label>
              <span>${escapeHtml(t("projects.path"))}</span>
              <input name="path" placeholder="${escapeHtml(t("projects.pathPlaceholder"))}" required />
            </label>
            <button type="submit" class="primary-button">${escapeHtml(t("projects.register"))}</button>
          </form>
        </article>

        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Projects</p>
              <h2>${escapeHtml(t("projects.listTitle"))}</h2>
            </div>
            <span class="pill">${escapeHtml(t("projects.count", { count: projects.items.length }))}</span>
          </div>
          <div class="card-list">
            ${projects.items
              .map(
                (project) => `
                  <article class="record-card list-row-card">
                    <div class="record-title-row">
                      <h3>${escapeHtml(project.name)}</h3>
                      <button class="secondary-button" data-create-session="${project.projectId}">
                        ${escapeHtml(t("workspace.empty.newSession"))}
                      </button>
                    </div>
                    <p class="record-path">${escapeHtml(project.path)}</p>
                    <p class="record-meta">ID: ${escapeHtml(project.projectId)}</p>
                  </article>
                `,
              )
              .join("")}
          </div>
        </article>
      </section>
    `,
    });

    document.querySelector("#project-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);

      try {
        await createProject({
          name: String(form.get("name") || ""),
          path: String(form.get("path") || ""),
        });
        renderProjectsPage();
      } catch (error) {
        showToast(messageOf(error));
      }
    });

    document.querySelectorAll("[data-create-session]").forEach((button) => {
      button.addEventListener("click", async () => {
        const projectId = button.getAttribute("data-create-session");
        const title = window.prompt(
          t("projects.promptSessionTitle"),
          t("projects.promptSessionDefault"),
        );
        if (!projectId || !title) {
          return;
        }

        try {
          const session = await createSession({ projectId, title });
          window.location.hash = `#/sessions/${session.sessionId}`;
        } catch (error) {
          showToast(messageOf(error));
        }
      });
    });
  } catch (error) {
    app.innerHTML = renderAppChrome({
      variant: "marketing",
      bodyHtml: errorCard(messageOf(error)),
    });
  }
}

async function renderSessionsPage() {
  app.innerHTML = renderAppChrome({
    variant: "compact",
    title: t("nav.sessions"),
    subtitle: "",
    backHref: "#/projects",
    bodyHtml: loadingCard(t("workspace.loading.sessions")),
  });

  try {
    const [sessions, projects] = await Promise.all([getSessions(), getProjects()]);
    state.sessions.items = sessions.items;
    state.sessions.projects = projects.items;

    renderSessionsList();
  } catch (error) {
    app.innerHTML = renderAppChrome({
      variant: "compact",
      title: t("nav.sessions"),
      subtitle: "",
      backHref: "#/projects",
      bodyHtml: errorCard(messageOf(error)),
    });
  }
}

function promptImportableCodexSession(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const promptText = [
    t("workspace.import.promptHeader"),
    "",
    ...items.map((item, index) => {
      const title = item.title || item.codexSessionId || item.rolloutPath;
      const cwd = item.cwd ? ` · ${item.cwd}` : "";
      const imported = item.importedSessionId ? ` · ${t("workspace.import.imported")} ${item.importedSessionId}` : "";
      return `${index + 1}. ${title}${cwd}${imported}`;
    }),
  ].join("\n");

  const rawValue = window.prompt(promptText, "1");
  if (!rawValue) {
    return null;
  }

  const selectedIndex = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > items.length) {
    throw new Error(t("workspace.import.invalidPrompt"));
  }

  return items[selectedIndex - 1];
}

async function handleImportCodexSession() {
  if (document.querySelector("#workspace-modal-slot")) {
    await openWorkspaceImportDialog();
    return;
  }

  const importable = await getImportableCodexSessions();
  const items = Array.isArray(importable?.items) ? importable.items : [];
  if (items.length === 0) {
    showToast(t("workspace.import.noneAvailable"));
    return;
  }

  const selected = promptImportableCodexSession(items);
  if (!selected) {
    return;
  }

  const result = await importCodexSession({
    rolloutPath: selected.rolloutPath,
  });
  if (result?.sessionId) {
    window.location.hash = `#/sessions/${result.sessionId}`;
  }
}

function renderSessionsList() {
  const projectMap = new Map(state.sessions.projects.map((project) => [project.projectId, project]));
  const filteredSessions = state.sessions.items.filter((session) =>
    matchesSessionFilters(session, projectMap.get(session.projectId), state.sessions),
  );
  const statusOptions = getSessionStatusOptions(state.sessions.items);
  const projectOptions = getSessionProjectOptions(state.sessions.projects, state.sessions.items);
  const threadOptions = getThreadFilterOptions(state.sessions.items);
  const sortOptions = getSessionSortOptions();
  const activeFilters = countActiveSessionFilters(state.sessions);
  const sortedSessions = sortSessions(filteredSessions, state.sessions.sort);
  const totalPages = getPageCount(sortedSessions.length, state.sessions.pageSize);
  state.sessions.page = clampPage(state.sessions.page, totalPages);
  const pageStart = (state.sessions.page - 1) * state.sessions.pageSize;
  const pagedSessions = sortedSessions.slice(pageStart, pageStart + state.sessions.pageSize);
  const pageNumbers = getVisiblePageNumbers(state.sessions.page, totalPages);
  const pageEnd = sortedSessions.length
    ? Math.min(pageStart + state.sessions.pageSize, sortedSessions.length)
    : 0;
  persistSessionsViewState();

  app.innerHTML = renderAppChrome({
    variant: "compact",
    title: t("nav.sessions"),
    subtitle: `${state.sessions.items.length} ${t("nav.sessions")}`,
    backHref: "#/projects",
    bodyHtml: `
    <section class="stack sessions-page-stack">
      <article class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Sessions</p>
            <h2>${escapeHtml(t("sessions.filterListTitle"))}</h2>
          </div>
          <div class="panel-actions">
            <button id="import-codex-session" class="secondary-button">${escapeHtml(t("workspace.import.title"))}</button>
            <button id="refresh-sessions" class="secondary-button">${escapeHtml(t("generic.refresh"))}</button>
          </div>
        </div>

        <div class="session-toolbar">
          <div class="session-filter-grid">
            <label class="session-filter-field session-filter-field-wide">
              <span>${escapeHtml(t("generic.keyword"))}</span>
              <input
                id="session-search"
                value="${escapeHtml(state.sessions.keyword)}"
                placeholder="${escapeHtml(t("sessions.searchPlaceholder"))}"
              />
            </label>
            <label class="session-filter-field">
              <span>${escapeHtml(t("generic.status"))}</span>
              <select id="session-status">
                ${statusOptions
                  .map(
                    (option) => `
                      <option value="${escapeHtml(option.value)}" ${state.sessions.status === option.value ? "selected" : ""}>
                        ${escapeHtml(option.label)}
                      </option>
                    `,
                  )
                  .join("")}
              </select>
            </label>
            <label class="session-filter-field">
              <span>${escapeHtml(t("generic.project"))}</span>
              <select id="session-project">
                ${projectOptions
                  .map(
                    (option) => `
                      <option value="${escapeHtml(option.value)}" ${state.sessions.projectId === option.value ? "selected" : ""}>
                        ${escapeHtml(option.label)}
                      </option>
                    `,
                  )
                  .join("")}
              </select>
            </label>
            <label class="session-filter-field">
              <span>${escapeHtml(t("generic.sort"))}</span>
              <select id="session-sort">
                ${sortOptions
                  .map(
                    (option) => `
                      <option value="${escapeHtml(option.value)}" ${state.sessions.sort === option.value ? "selected" : ""}>
                        ${escapeHtml(option.label)}
                      </option>
                    `,
                  )
                  .join("")}
              </select>
            </label>
          </div>

          <div class="session-filter-row">
            <div class="event-filters">
              ${threadOptions
                .map(
                  (option) => `
                    <button
                      type="button"
                      class="filter-chip ${state.sessions.thread === option.value ? "filter-chip-active" : ""}"
                      data-thread-filter="${option.value}"
                    >
                      ${escapeHtml(option.label)} · ${escapeHtml(String(option.count))}
                    </button>
                  `,
                )
                .join("")}
            </div>
            <div class="session-filter-meta">
              <span>${escapeHtml(
                t("sessions.showing", {
                  visible: filteredSessions.length,
                  total: state.sessions.items.length,
                }),
              )}</span>
              ${
                activeFilters > 0
                  ? `<button id="clear-session-filters" type="button" class="secondary-button">${escapeHtml(t("sessions.clearFilters"))}</button>`
                  : ""
              }
            </div>
          </div>
        </div>

        <div class="card-list">
          ${
            pagedSessions.length > 0
              ? pagedSessions
                  .map((session) => {
                    const project = projectMap.get(session.projectId);
                    const displayStatus = getSessionDisplayStatus(session);
                    return `
                      <article class="record-card session-card list-row-card" data-open-session="${session.sessionId}">
                        <div class="record-title-row">
                          <h3>${escapeHtml(session.title || t("workspace.session.untitled"))}</h3>
                          <span class="pill ${statusClass(displayStatus)}">${escapeHtml(sessionStatusLabel(displayStatus))}</span>
                        </div>
                        <p class="record-meta">${escapeHtml(t("sessions.projectMeta", { value: project?.name || session.projectId }))}</p>
                        <p class="record-meta">${escapeHtml(t("sessions.lastEventMeta", { value: session.lastEventAt || t("generic.none") }))}</p>
                        <div class="summary-strip">
                          <span class="summary-chip">${escapeHtml(t("sessions.eventCount", { count: session.eventCount ?? 0 }))}</span>
                          ${
                            session.codexThreadId
                              ? `<span class="summary-chip">${escapeHtml(t("sessions.threadReady"))}</span>`
                              : `<span class="summary-chip">${escapeHtml(t("sessions.threadMissing"))}</span>`
                          }
                          ${
                            session.pendingApproval
                              ? `<span class="summary-chip summary-chip-warn">${escapeHtml(t("sessions.pendingApproval"))}</span>`
                              : ""
                          }
                        </div>
                        ${
                          session.pendingApproval?.reason
                            ? `<p class="record-summary"><strong>${escapeHtml(t("sessions.pendingApprovalTitle"))}</strong> ${escapeHtml(shortenText(session.pendingApproval.reason, 120))}</p>`
                            : session.pendingApproval?.command
                              ? `<p class="record-summary"><strong>${escapeHtml(t("sessions.pendingApprovalTitle"))}</strong> ${escapeHtml(shortenText(session.pendingApproval.command, 120))}</p>`
                              : ""
                        }
                        ${
                          session.lastCommand
                            ? `<p class="record-summary"><strong>${escapeHtml(t("sessions.lastCommandTitle"))}</strong> ${escapeHtml(shortenText(session.lastCommand, 120))}</p>`
                            : ""
                        }
                        ${
                          session.lastAssistantContent
                            ? `<p class="record-summary"><strong>${escapeHtml(t("sessions.lastReplyTitle"))}</strong> ${escapeHtml(shortenText(session.lastAssistantContent, 140))}</p>`
                            : ""
                        }
                      </article>
                    `;
                  })
                  .join("")
              : `<div class="session-empty">${escapeHtml(t("sessions.emptyFiltered"))}</div>`
          }
        </div>

        ${
          sortedSessions.length > 0
            ? `
              <div class="session-pagination">
                <div class="session-page-meta">
                  <span>${escapeHtml(
                    t("sessions.pageRange", {
                      start: pageStart + 1,
                      end: pageEnd,
                      total: sortedSessions.length,
                    }),
                  )}</span>
                  <span>${escapeHtml(
                    t("sessions.pageIndex", {
                      page: state.sessions.page,
                      total: totalPages,
                    }),
                  )}</span>
                </div>
                <div class="session-page-controls">
                  <button
                    id="page-prev"
                    type="button"
                    class="page-button"
                    ${state.sessions.page <= 1 ? "disabled" : ""}
                  >
                    ${escapeHtml(t("sessions.pagePrev"))}
                  </button>
                  ${pageNumbers
                    .map(
                      (pageNumber) => `
                        <button
                          type="button"
                          class="page-button ${state.sessions.page === pageNumber ? "page-button-active" : ""}"
                          data-page-number="${pageNumber}"
                        >
                          ${escapeHtml(String(pageNumber))}
                        </button>
                      `,
                    )
                    .join("")}
                  <button
                    id="page-next"
                    type="button"
                    class="page-button"
                    ${state.sessions.page >= totalPages ? "disabled" : ""}
                  >
                    ${escapeHtml(t("sessions.pageNext"))}
                  </button>
                </div>
              </div>
            `
            : ""
        }
      </article>
    </section>
  `,
  });

  document.querySelector("#refresh-sessions")?.addEventListener("click", () => {
    renderSessionsPage();
  });

  document.querySelector("#import-codex-session")?.addEventListener("click", async () => {
    try {
      await handleImportCodexSession();
    } catch (error) {
      showToast(messageOf(error));
    }
  });

  document.querySelector("#session-search")?.addEventListener("input", (event) => {
    const searchInput = event.currentTarget;
    const nextKeyword = searchInput.value;
    const caret = searchInput.selectionStart ?? nextKeyword.length;

    state.sessions.keyword = nextKeyword;
    state.sessions.page = 1;
    renderSessionsList();

    const restoredInput = document.querySelector("#session-search");
    if (restoredInput) {
      restoredInput.focus();
      restoredInput.setSelectionRange(caret, caret);
    }
  });

  document.querySelector("#session-status")?.addEventListener("change", (event) => {
    state.sessions.status = event.currentTarget.value;
    state.sessions.page = 1;
    renderSessionsList();
  });

  document.querySelector("#session-project")?.addEventListener("change", (event) => {
    state.sessions.projectId = event.currentTarget.value;
    state.sessions.page = 1;
    renderSessionsList();
  });

  document.querySelector("#session-sort")?.addEventListener("change", (event) => {
    state.sessions.sort = event.currentTarget.value;
    state.sessions.page = 1;
    renderSessionsList();
  });

  document.querySelectorAll("[data-thread-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextThreadFilter = button.getAttribute("data-thread-filter");
      if (!nextThreadFilter || nextThreadFilter === state.sessions.thread) {
        return;
      }

      state.sessions.thread = nextThreadFilter;
      state.sessions.page = 1;
      renderSessionsList();
    });
  });

  document.querySelector("#clear-session-filters")?.addEventListener("click", () => {
    state.sessions.keyword = "";
    state.sessions.status = "all";
    state.sessions.projectId = "all";
    state.sessions.thread = "all";
    state.sessions.page = 1;
    renderSessionsList();
  });

  document.querySelector("#page-prev")?.addEventListener("click", () => {
    if (state.sessions.page <= 1) {
      return;
    }

    state.sessions.page -= 1;
    renderSessionsList();
  });

  document.querySelector("#page-next")?.addEventListener("click", () => {
    if (state.sessions.page >= totalPages) {
      return;
    }

    state.sessions.page += 1;
    renderSessionsList();
  });

  document.querySelectorAll("[data-page-number]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextPage = Number.parseInt(button.getAttribute("data-page-number") || "", 10);
      if (Number.isNaN(nextPage) || nextPage === state.sessions.page) {
        return;
      }

      state.sessions.page = nextPage;
      renderSessionsList();
    });
  });

  document.querySelectorAll("[data-open-session]").forEach((card) => {
    card.addEventListener("click", () => {
      const sessionId = card.getAttribute("data-open-session");
      if (sessionId) {
        window.location.hash = `#/sessions/${sessionId}`;
      }
    });
  });
}

async function renderSessionDetailPage(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    return;
  }

  const previousSessionId = String(state.detail.session?.sessionId || "").trim();
  if (previousSessionId !== normalizedSessionId) {
    state.detail.dismissedApprovalKeys = {};
  }

  state.workspace.activeSessionId = normalizedSessionId;
  const loadRequestId = Number(state.detail.loadRequestId || 0) + 1;
  state.detail.loadRequestId = loadRequestId;
  const isStaleDetailLoad = () =>
    state.detail.loadRequestId !== loadRequestId || state.workspace.activeSessionId !== normalizedSessionId;
  const mainSlot = document.querySelector("#workspace-main-slot");
  if (mainSlot) {
    mainSlot.innerHTML = loadingCard(t("workspace.loading.session"));
  } else {
    app.innerHTML = renderWorkspaceShell({
      sidebarHtml: renderWorkspaceSidebar(normalizedSessionId),
      mainHtml: loadingCard(t("workspace.loading.session")),
    });
    syncWorkspaceShellState();
    bindWorkspaceCreateDialogControls();
    bindWorkspaceImportDialogControls();
    bindWorkspaceSidebarControls(normalizedSessionId);
  }

  try {
    await syncImportedSession(normalizedSessionId).catch(() => null);
    if (isStaleDetailLoad()) {
      return;
    }

    const [session, eventData, uiOptionsResult, hostsResult] = await Promise.all([
      getSession(normalizedSessionId),
      loadInitialSessionEvents(normalizedSessionId),
      getCodexUiOptions().catch(() => null),
      getCodexHosts().catch(() => null),
    ]);
    if (isStaleDetailLoad()) {
      return;
    }

    const uiOptions =
      uiOptionsResult &&
      Array.isArray(uiOptionsResult.models) &&
      uiOptionsResult.models.length > 0 &&
      Array.isArray(uiOptionsResult.reasoningLevels) &&
      uiOptionsResult.reasoningLevels.length > 0
        ? uiOptionsResult
        : CLIENT_FALLBACK_CODEX_UI_OPTIONS;
    const codexStatus = await getCodexStatus({
      sessionId: normalizedSessionId,
      threadId: session.codexThreadId || "",
      cwd: session.projectPath || "",
    }).catch(() => null);
    if (isStaleDetailLoad()) {
      return;
    }

    state.detail.session = session;
    replaceDetailTimelineRawEvents(eventData.items);
    syncDetailPendingApproval(session, state.detail.timelineState);
    state.detail.cursor = eventData.lastSeq || eventData.nextCursor || 0;
    state.detail.beforeCursor = eventData.beforeCursor || 0;
    state.detail.historyHasMore = Boolean(eventData.hasMoreBefore);
    state.detail.historyLoading = false;
    state.detail.draft = "";
    state.detail.unseenCount = 0;
    state.detail.searchMatchIndex = 0;
    state.detail.activeSearchResultKey = "";
    state.detail.commandGroups = {};
    state.detail.taskDetails = {};
    state.detail.rawStdoutBuckets = {};
    state.detail.codexUiOptions = uiOptions;
    state.detail.codexLaunch = normalizeCodexLaunchAgainstUi(loadCodexLaunchPrefs(), uiOptions);
    state.detail.remoteHosts =
      hostsResult && Array.isArray(hostsResult.hosts)
        ? hostsResult.hosts.filter((item) => typeof item === "string" && item.trim())
        : [];
    if (!state.detail.remoteHosts.length) {
      const currentHost = getCurrentPageHost();
      if (currentHost) {
        state.detail.remoteHosts = [currentHost];
      }
    }
    state.detail.activeRemoteHost =
      hostsResult && typeof hostsResult.activeHost === "string" && hostsResult.activeHost.trim()
        ? hostsResult.activeHost.trim()
        : (state.detail.remoteHosts[0] || getCurrentPageHost());
    state.detail.activeTaskStartedAt = 0;
    state.detail.liveExecutionTaskKey = "";
    state.detail.composerEnvironmentMenuOpen = false;
    state.detail.slashMenuOpen = false;
    state.detail.slashCommands = [];
    state.detail.slashCommandsLoading = false;
    state.detail.slashQuery = "";
    state.detail.slashActiveIndex = 0;
    state.detail.slashExecuting = false;
    state.detail.inspectDrawerOpen = false;
    state.detail.inspectSelectionKey = "";
    state.detail.optimisticSend = null;
    state.detail.codexQuota = readCachedCodexQuota(normalizedSessionId);
    state.detail.codexStatus = codexStatus;
    state.socketState = "connecting";

    const detailQuery = parseHashRoute(window.location.hash || "").query || "";
    const followParam = new URLSearchParams(detailQuery).get("follow");
    if (followParam !== "0" && followParam !== "false") {
      state.detail.autoScroll = true;
    }

    renderSessionDetail();
    if (isStaleDetailLoad()) {
      return;
    }

    attachSessionSocket(normalizedSessionId);
    void catchUpSessionEvents(normalizedSessionId, state.detail.cursor)
      .then(() => {
        if (!isStaleDetailLoad()) {
          scheduleSessionDetailRender();
        }
      })
      .catch(() => null);
    scheduleImportedSessionSync(normalizedSessionId);
  } catch (error) {
    if (isStaleDetailLoad()) {
      return;
    }

    const nextMainSlot = document.querySelector("#workspace-main-slot");
    if (nextMainSlot) {
      nextMainSlot.innerHTML = errorCard(messageOf(error));
    } else {
      app.innerHTML = renderWorkspaceShell({
        sidebarHtml: renderWorkspaceSidebar(normalizedSessionId),
        mainHtml: errorCard(messageOf(error)),
      });
      syncWorkspaceShellState();
      bindWorkspaceCreateDialogControls();
      bindWorkspaceImportDialogControls();
      bindWorkspaceSidebarControls(normalizedSessionId);
    }
  }
}

function renderSessionDetail() {
  const session = state.detail.session;
  if (!session) {
    const mainSlot = document.querySelector("#workspace-main-slot");
    if (mainSlot) {
      mainSlot.innerHTML = errorCard("Session not found.");
    } else {
      app.innerHTML = renderWorkspaceShell({
        sidebarHtml: renderWorkspaceSidebar(""),
        mainHtml: errorCard("Session not found."),
      });
      syncWorkspaceShellState();
      bindWorkspaceCreateDialogControls();
      bindWorkspaceImportDialogControls();
      bindWorkspaceSidebarControls("");
    }
    return;
  }

  if (state.workspace.activeSessionId !== session.sessionId) {
    state.workspace.activeSessionId = session.sessionId;
    patchWorkspaceSidebar(session.sessionId);
  }

  disconnectConversationLayoutObserver();

  const preservedScrollTop = captureEventListScrollTop();
  const preservedBottomOffset = captureAutoScrollBottomOffset();
  persistSessionDetailViewState(session.sessionId);

  const composerIsBusy = isSessionLiveBusy(session);
  const threadInfo = state.detail.codexStatus?.thread || null;
  const activeTurn = getActiveTimelineTurn(session) || getOptimisticActiveTurn(session);
  const displayTimelineItems = getDisplayTimelineItems();
  state.detail.activeTaskStartedAt = getTurnStartedAtUnixSeconds(activeTurn);

  if (!state.detail.codexLaunch) {
    state.detail.codexLaunch = normalizeCodexLaunchAgainstUi(
      loadCodexLaunchPrefs(),
      state.detail.codexUiOptions,
    );
  }

  if (!state.detail.codexUiOptions) {
    state.detail.codexUiOptions = CLIENT_FALLBACK_CODEX_UI_OPTIONS;
  }

  const activeElapsedValue = activeTurn
    ? formatElapsedSinceUnixSeconds(state.detail.activeTaskStartedAt)
    : "";

  const topBarHtml = renderSessionTopBar({
    title: session.title || t("workspace.session.untitled"),
    statusCode: getSessionDisplayStatus(session),
    statusLabel: sessionStatusLabel(getSessionDisplayStatus(session)),
    statusClass: statusClass(getSessionDisplayStatus(session)),
    activityBadges: getSessionActivityBadges(session, activeTurn),
    host: state.detail.activeRemoteHost || t("session.host.unsynced"),
    model: getSelectedModelLabel(
      state.detail.codexUiOptions,
      state.detail.codexLaunch,
      threadInfo,
    ),
    reasoning: getSelectedReasoningLabel(
      state.detail.codexUiOptions,
      state.detail.codexLaunch,
      threadInfo,
    ),
    sessionElapsedLabel: t("session.elapsed", { value: formatElapsedSinceIso(session.createdAt) }),
    activeElapsedLabel: activeElapsedValue,
    inspectOpen: state.detail.inspectDrawerOpen,
    showInspectAction: false,
    backHref: "",
  });

  const showUnseenBanner = shouldShowJumpToBottomButton();
  const transcriptOptions = {
    session,
    socketState: state.socketState,
    activeElapsedLabel: activeElapsedValue,
  };
  const transcriptHtml = `
    ${showUnseenBanner
      ? `
        <button id="event-unseen-banner" type="button" class="event-unseen-banner" aria-label="${escapeHtml(t("timeline.jumpToBottom"))}">
          ↓
        </button>
      `
      : ""}
    ${renderTimeline(displayTimelineItems, transcriptOptions)}
  `;

  const approvalBarHtml = renderPendingApprovalBar(state.detail);
  const composerInputHtml = renderComposerInput({
    session,
    detailState: state.detail,
    uiOptions: state.detail.codexUiOptions,
  });

  const workspaceMainSlot = document.querySelector("#workspace-main-slot");
  const shell = document.querySelector("#session-detail-shell");
  const shellMounted = shell?.dataset.sessionId === session.sessionId;

  if (!shellMounted) {
    const shellHtml = `
      <div id="session-detail-shell" class="session-detail-layout workspace-session-detail-layout" data-session-id="${escapeHtml(session.sessionId)}">
        <div id="session-topbar-slot"></div>
        <div class="session-workbench-shell">
          <article id="session-transcript-slot" class="panel conversation-panel session-transcript-panel"></article>
        </div>
        <form id="message-form" class="composer-form-chat" novalidate>
          <div class="composer-panel">
            <div id="session-approval-slot"></div>
            <div id="session-composer-slot"></div>
          </div>
        </form>
      </div>
    `;

    if (workspaceMainSlot) {
      workspaceMainSlot.innerHTML = shellHtml;
    } else {
      app.innerHTML = renderWorkspaceShell({
        sidebarHtml: renderWorkspaceSidebar(session.sessionId),
        mainHtml: shellHtml,
      });
      syncWorkspaceShellState();
      bindWorkspaceCreateDialogControls();
      bindWorkspaceImportDialogControls();
      bindWorkspaceSidebarControls(session.sessionId);
    }
  }

  const topBarSlot = document.querySelector("#session-topbar-slot");
  const transcriptSlot = document.querySelector("#session-transcript-slot");
  const approvalSlot = document.querySelector("#session-approval-slot");
  const composerSlot = document.querySelector("#session-composer-slot");

  if (topBarSlot && (!shellMounted || state.detail.lastTopBarHtml !== topBarHtml)) {
    if (!shellMounted) {
      topBarSlot.innerHTML = topBarHtml;
    } else {
      patchTopBarDom(topBarSlot, topBarHtml);
    }
    state.detail.lastTopBarHtml = topBarHtml;
  }
  if (transcriptSlot) {
    const existingBanner = transcriptSlot.querySelector("#event-unseen-banner");
    if (showUnseenBanner) {
      const bannerHtml = "↓";
      if (existingBanner) {
        existingBanner.textContent = bannerHtml;
      } else {
        transcriptSlot.insertAdjacentHTML(
          "afterbegin",
          `<button id="event-unseen-banner" type="button" class="event-unseen-banner" aria-label="${escapeHtml(t("timeline.jumpToBottom"))}">${bannerHtml}</button>`,
        );
      }
    } else {
      existingBanner?.remove();
    }

    const streamMain = transcriptSlot.querySelector(".session-stream-main");
    const existingList = transcriptSlot.querySelector("#event-list");
    if (!streamMain || !existingList) {
      transcriptSlot.innerHTML = transcriptHtml;
    } else {
      patchTimelineListDom(existingList, displayTimelineItems, transcriptOptions);
    }
  }
  if (approvalSlot && (!shellMounted || state.detail.lastApprovalBarHtml !== approvalBarHtml)) {
    approvalSlot.innerHTML = approvalBarHtml;
    state.detail.lastApprovalBarHtml = approvalBarHtml;
  }
  const composerFocused = isComposerTextareaFocused();
  if (
    composerSlot &&
    (!shellMounted || state.detail.lastComposerHtml !== composerInputHtml) &&
    (!shellMounted || !composerFocused)
  ) {
    composerSlot.innerHTML = composerInputHtml;
    state.detail.lastComposerHtml = composerInputHtml;
  }

  const composerTextarea = document.querySelector('textarea[name="content"]');
  const messageFormEl = document.querySelector("#message-form");
  const composerActionFab = document.querySelector("#composer-action");

  function syncComposerActionState() {
    if (!composerActionFab || !composerTextarea) {
      return;
    }

    if (composerIsBusy) {
      composerActionFab.disabled = false;
      return;
    }

    composerActionFab.disabled = !composerTextarea.value.trim();
  }

  async function sendComposerMessage() {
    const content = String(composerTextarea?.value || "").trim();
    if (!content) {
      return;
    }

    const optimisticTimestamp = new Date().toISOString();
    const optimisticSend = {
      sessionId: session.sessionId,
      tempTurnId: `optimistic-turn:${Date.now()}`,
      userItemId: `optimistic-user:${Date.now()}`,
      thinkingItemId: `optimistic-thinking:${Date.now()}`,
      text: content,
      createdAt: optimisticTimestamp,
      confirmed: false,
      turnId: null,
      previousStatus: state.detail.session?.status || "waiting_input",
      previousLiveBusy: Boolean(state.detail.session?.liveBusy),
      previousUpdatedAt: state.detail.session?.updatedAt || "",
      previousTitle: state.detail.session?.title || "",
      titleWasUpdated: false,
    };

    try {
      const codex = buildCodexLaunchPayload(
        state.detail.codexLaunch,
        state.detail.codexUiOptions,
      );
      const payload = codex ? { content, codex } : { content };
      if (state.detail.session && shouldAutotitleSession(state.detail.session)) {
        const nextTitle = deriveSessionTitleFromMessage(content);
        state.detail.session.title = nextTitle;
        state.sessions.items = state.sessions.items.map((item) =>
          item.sessionId === session.sessionId ? { ...item, title: nextTitle } : item,
        );
        optimisticSend.titleWasUpdated = true;
      }
      if (state.detail.session) {
        state.detail.session.status = "running";
        state.detail.session.liveBusy = true;
        state.detail.session.updatedAt = optimisticTimestamp;
      }
      state.detail.optimisticSend = optimisticSend;
      state.detail.draft = "";
      if (composerTextarea) {
        composerTextarea.value = "";
        adjustComposerHeight(composerTextarea);
        window.requestAnimationFrame(() => adjustComposerHeight(composerTextarea));
      }
      syncComposerActionState();
      scheduleSessionDetailRender();

      const result = await sendMessage(session.sessionId, payload);
      if (state.detail.optimisticSend?.userItemId === optimisticSend.userItemId) {
        state.detail.optimisticSend = {
          ...state.detail.optimisticSend,
          confirmed: true,
          turnId: result.turnId || state.detail.optimisticSend.turnId,
        };
      }
      mergeDetailTimelineRawEvents([
        {
          id: result.eventId,
          sessionId: session.sessionId,
          seq: Number(result.seq || state.detail.cursor + 1),
          timestamp: new Date().toISOString(),
          type: "message.user",
          turnId: result.turnId,
          payload: {
            text: content,
          },
        },
      ]);
      state.detail.cursor = Math.max(state.detail.cursor, Number(result.seq || 0));
      scheduleSessionDetailRender();
    } catch (error) {
      clearOptimisticSend({
        restoreDraft: content,
        restoreSession: true,
        restoreTitle: true,
      });
      syncComposerActionState();
      scheduleSessionDetailRender();
      void resumeActiveSessionDetail("send-error");
      showToast(messageOf(error));
    }
  }

  async function refreshBusySessionBeforeSend() {
    if (!isSessionLiveBusy(state.detail.session)) {
      return false;
    }

    await resumeActiveSessionDetail("pre-send");
    return isSessionLiveBusy(state.detail.session);
  }

  if (composerTextarea) {
    composerTextarea.oninput = (event) => {
      state.detail.draft = event.currentTarget.value;
      adjustComposerHeight(event.currentTarget);
      window.requestAnimationFrame(() => adjustComposerHeight(event.currentTarget));
      if (state.detail.slashMenuOpen) {
        closeSlashMenu();
      }
      syncComposerActionState();
    };
    composerTextarea.onblur = () => {
      scheduleSessionDetailRender();
    };
  }

  if (composerTextarea) {
    composerTextarea.onkeydown = async (event) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }

      event.preventDefault();
      if (await refreshBusySessionBeforeSend()) {
        return;
      }

      if (composerTextarea.value.trim()) {
        void sendComposerMessage();
      }
    };
  }

  if (composerActionFab) {
    composerActionFab.onclick = async () => {
      const stillBusy = await refreshBusySessionBeforeSend();
      if (stillBusy) {
        try {
          await stopSession(session.sessionId);
        } catch (error) {
          showToast(messageOf(error));
        }

        return;
      }

      await sendComposerMessage();
    };
  }

  if (messageFormEl) {
    messageFormEl.onsubmit = async (event) => {
      event.preventDefault();
      if (await refreshBusySessionBeforeSend()) {
        return;
      }

      void sendComposerMessage();
    };
  }

  adjustComposerHeight(composerTextarea);
  syncComposerActionState();
  bindComposerInputControls({
    detailState: state.detail,
    onRender: renderSessionDetail,
  });
  document
    .querySelectorAll('[data-codex-pref="modelId"], [data-codex-pref="reasoningId"]')
    .forEach((el) => {
      const previousOnChange = el.onchange;
      el.onchange = (event) => {
        previousOnChange?.call(el, event);
        renderSessionDetail();
      };
    });

  document.querySelector("#event-search")?.addEventListener("input", (event) => {
    const searchInput = event.currentTarget;
    const nextSearch = searchInput.value;
    const caret = searchInput.selectionStart ?? nextSearch.length;

    state.detail.search = nextSearch;
    state.detail.searchMatchIndex = 0;
    state.detail.activeSearchResultKey = "";
    renderSessionDetail();

    const restoredInput = document.querySelector("#event-search");
    if (restoredInput) {
      restoredInput.focus();
      restoredInput.setSelectionRange(caret, caret);
    }
  });

  document.querySelector("#event-search")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    stepSearchMatch(event.shiftKey ? -1 : 1);
  });

  document.querySelector("#clear-event-search")?.addEventListener("click", () => {
    state.detail.search = "";
    state.detail.searchMatchIndex = 0;
    state.detail.activeSearchResultKey = "";
    renderSessionDetail();
  });

  document.querySelector("#search-hit-prev")?.addEventListener("click", () => {
    stepSearchMatch(-1);
  });

  document.querySelector("#search-hit-next")?.addEventListener("click", () => {
    stepSearchMatch(1);
  });

  document.querySelector("#toggle-auto-scroll")?.addEventListener("click", () => {
    state.detail.autoScroll = !state.detail.autoScroll;
    if (state.detail.autoScroll) {
      state.detail.unseenCount = 0;
    }
    renderSessionDetail();
  });

  document.querySelector("#resume-auto-scroll")?.addEventListener("click", () => {
    resumeAutoScrollToBottom();
  });

  document.querySelector("#event-unseen-banner")?.addEventListener("click", () => {
    resumeAutoScrollToBottom();
  });


  document.querySelector("#refresh-events")?.addEventListener("click", async () => {
    try {
      const payload = await getSessionEvents(session.sessionId, {
        after: state.detail.cursor,
        limit: 200,
      });
      trackUnseenEvents(payload.items);
      mergeDetailTimelineRawEvents(payload.items);
      state.detail.cursor = payload.nextCursor || state.detail.cursor;
      renderSessionDetail();
    } catch (error) {
      showToast(messageOf(error));
    }
  });

  document.querySelectorAll("[data-task-step-toggle='1']").forEach((button) => {
    button.addEventListener("click", () => {
      const taskKey = button.dataset.taskKey || "";
      const stepKey = button.dataset.stepKey || "";
      if (!taskKey || !stepKey) {
        return;
      }

      const current = isTaskStepExpanded(taskKey, stepKey, false);
      setTaskStepExpanded(taskKey, stepKey, !current);
      renderSessionDetail();
    });
  });

  bindEventListAutoPause(session.sessionId);
  bindCopyButtons();
  bindPendingApprovalControls(session.sessionId);
  restoreEventListScrollTop(preservedScrollTop);
  restoreAutoScrollBottomOffset(preservedBottomOffset);
  ensureDetailClock();
  if (state.detail.autoScroll) {
    if (shellMounted) {
      scheduleAutoScrollAnchorRestore();
    } else {
      scheduleInitialScrollToBottom();
    }
    attachConversationLayoutScrollObserver();
  }

  scheduleLiveResumeSync(session.sessionId);
  syncSearchMatchNavigation();
}

function scheduleSessionDetailRender(options = {}) {
  if (!state.detail.session) {
    return;
  }

  const immediate = Boolean(options.immediate);
  if (state.detail.renderTimerId) {
    window.clearTimeout(state.detail.renderTimerId);
    state.detail.renderTimerId = 0;
  }

  if (immediate) {
    renderSessionDetail();
    return;
  }

  if (DETAIL_RENDER_BATCH_MS <= 0) {
    window.requestAnimationFrame(() => {
      state.detail.renderTimerId = 0;
      renderSessionDetail();
    });
    return;
  }

  state.detail.renderTimerId = window.setTimeout(() => {
    state.detail.renderTimerId = 0;
    renderSessionDetail();
  }, DETAIL_RENDER_BATCH_MS);
}

function attachSessionSocket(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    return;
  }

  cleanupSocket();
  const socket = connectSessionSocket(normalizedSessionId, {
    onStateChange(nextState) {
      if (state.ws !== socket || !isActiveDetailSession(normalizedSessionId)) {
        return;
      }

      state.socketState = nextState;
      if (state.detail.session) {
        scheduleSessionDetailRender();
      }
    },
    onEvent(event) {
      const eventSessionId = String(event?.sessionId || event?.session_id || "").trim();
      if (
        state.ws !== socket ||
        !isActiveDetailSession(normalizedSessionId) ||
        (eventSessionId && eventSessionId !== normalizedSessionId)
      ) {
        return;
      }

      if (state.detail.session) {
        state.detail.session.updatedAt = new Date().toISOString();
        if (event.type === "turn.started") {
          state.detail.session.status = "running";
          state.detail.session.liveBusy = true;
        } else if (event.type === "turn.completed") {
          state.detail.session.status = "waiting_input";
          state.detail.session.liveBusy = false;
        } else if (event.type === "turn.aborted") {
          state.detail.session.status = "failed";
          state.detail.session.liveBusy = false;
        } else if (event.type === "error") {
          state.detail.session.status = "failed";
          state.detail.session.liveBusy = false;
        } else if (event.type === "session.status") {
          state.detail.session.status = event.status;
          state.detail.session.liveBusy = isSessionBusy(event.status);
        } else if (
          event.type === "system.notice" &&
          event.content &&
          event.content.startsWith("Codex thread started: ")
        ) {
          state.detail.session.codexThreadId = event.content.slice("Codex thread started: ".length);
          refreshCodexStatus(normalizedSessionId);
        }
      }

      if ((event.type === "token_count" || event.type === "codex.quota") && state.detail.session) {
        setDetailCodexQuota(normalizedSessionId, event.payload);
      }

      trackUnseenEvents([event]);
      mergeDetailTimelineRawEvents([event]);
      state.detail.cursor = Math.max(state.detail.cursor, event.seq || 0);
      scheduleSessionDetailRender();
    },
  });
  state.ws = socket;
}

async function refreshCodexStatus(sessionId) {
  if (!state.detail.session) {
    return;
  }

  try {
    const status = await getCodexStatus({
      sessionId,
      threadId: state.detail.session.codexThreadId || "",
      cwd: state.detail.session.projectPath || "",
    });

    if (state.detail.session && state.detail.session.sessionId === sessionId) {
      state.detail.codexStatus = status;
      scheduleSessionDetailRender();
    }
  } catch {
    /* ignore */
  }
}

function trackUnseenEvents(nextEvents) {
  if (state.detail.autoScroll) {
    return;
  }

  const existingIds = new Set(state.detail.rawEvents.map((event) => event.id));
  let addedCount = 0;

  nextEvents.forEach((event) => {
    if (!existingIds.has(event.id)) {
      existingIds.add(event.id);
      addedCount += 1;
    }
  });

  if (addedCount > 0) {
    state.detail.unseenCount += addedCount;
  }
}

function buildCommandGroupAt(events, startIndex) {
  const startEvent = events[startIndex];
  const group = {
    type: "command-group",
    id: startEvent.id || `command-group-${startIndex}`,
    startEvent,
    command: extractCommandText(startEvent),
    events: [],
    outputCount: 0,
    stderrCount: 0,
    endEvent: null,
  };

  let cursor = startIndex + 1;
  while (cursor < events.length) {
    const next = events[cursor];
    if (isCommandStartNotice(next)) {
      break;
    }

    if (!isCommandBodyEvent(next)) {
      break;
    }

    group.events.push(next);

    if (next.type === "cli.chunk") {
      group.outputCount += 1;
      if (next.stream === "stderr") {
        group.stderrCount += 1;
      }
    }

    if (isCommandEndNotice(next)) {
      group.endEvent = next;
      cursor += 1;
      break;
    }

    cursor += 1;
  }

  return { group, endIndex: cursor - 1 };
}

function listCommandGroupRanges(events) {
  const ranges = [];
  let index = 0;

  while (index < events.length) {
    if (!isCommandStartNotice(events[index])) {
      index += 1;
      continue;
    }

    const { group, endIndex } = buildCommandGroupAt(events, index);
    ranges.push({ start: index, end: endIndex, group });
    index = endIndex + 1;
  }

  return ranges;
}

function isTranscriptMetaSkip(event) {
  if (event.type === "codex.quota") {
    return true;
  }

  if (event.type !== "system.notice" || !event.content) {
    return false;
  }

  const content = event.content;
  if (content.startsWith("Codex thread started:")) {
    return true;
  }

  if (content.startsWith("Turn completed:")) {
    return true;
  }

  if (content === "Task stopped by user.") {
    return true;
  }

  if (content === "No active runner to stop.") {
    return true;
  }

  if (content.startsWith("Process exited with code")) {
    return true;
  }

  return false;
}

function shouldShowSessionStatusItem(events, index) {
  const event = events[index];
  if (event?.type !== "session.status") {
    return false;
  }

  if (!["starting", "waiting_input", "failed", "completed", "stopping"].includes(event.status)) {
    return false;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (events[cursor].type !== "session.status") {
      continue;
    }

    return events[cursor].status !== event.status;
  }

  return true;
}

function shouldShowTranscriptNotice(event) {
  if (event.type !== "system.notice") {
    return false;
  }

  if (!event.content || isTranscriptMetaSkip(event)) {
    return false;
  }

  if (event.level === "error" || event.level === "warning") {
    return true;
  }

  return event.content === "Task stopped by user.";
}

function buildConversationItems(events, options = {}) {
  const ranges = listCommandGroupRanges(events);
  const consumed = new Set();

  ranges.forEach(({ start, end }) => {
    for (let k = start; k <= end; k += 1) {
      consumed.add(k);
    }
  });

  const items = [];
  let i = 0;

  while (i < events.length) {
    if (consumed.has(i)) {
      const rg = ranges.find((r) => i >= r.start && i <= r.end);
      if (rg && i === rg.start) {
        const group = rg.group;
        group.matchingEvents = [group.startEvent, ...group.events].filter((candidate) =>
          matchesEventOptions(candidate, options),
        );
        if (group.matchingEvents.length > 0) {
          items.push({ type: "tool", group });
        }

        i = rg.end + 1;
        continue;
      }

      if (rg && i > rg.start) {
        i += 1;
        continue;
      }
    }

    const ev = events[i];

    if (ev.type === "session.status") {
      if (shouldShowSessionStatusItem(events, i) && matchesEventOptions(ev, options)) {
        items.push({ type: "status", event: ev, id: ev.id });
      }

      i += 1;
      continue;
    }

    if (isTranscriptMetaSkip(ev)) {
      i += 1;
      continue;
    }

    if (ev.type === "message.user") {
      if (matchesEventOptions(ev, options)) {
        items.push({ type: "user", events: [ev], id: ev.id });
      }

      i += 1;
      continue;
    }

    if (ev.type === "cli.chunk" && ev.stream === "assistant") {
      const batch = [];
      let j = i;
      while (j < events.length && !consumed.has(j)) {
        const e = events[j];
        if (e.type === "cli.chunk" && e.stream === "assistant") {
          batch.push(e);
          j += 1;
        } else {
          break;
        }
      }

      if (batch.some((e) => matchesEventOptions(e, options))) {
        items.push({ type: "assistant", events: batch, id: batch[0].id });
      }

      i = j;
      continue;
    }

    if (ev.type === "system.notice" && shouldShowTranscriptNotice(ev)) {
      if (matchesEventOptions(ev, options)) {
        items.push({ type: "notice", event: ev, id: ev.id });
      }

      i += 1;
      continue;
    }

    i += 1;
  }

  return items;
}

function buildConversationSearchResults(items) {
  return items
    .map((item, index) => {
      if (item.type === "tool") {
        return buildCommandGroupSearchResult(item.group, index);
      }

      if (item.type === "user") {
        return buildUserConversationSearchResult(item, index);
      }

      if (item.type === "assistant") {
        return buildAssistantConversationSearchResult(item, index);
      }

      if (item.type === "status") {
        return buildStatusSearchResult(item, index);
      }

      if (item.type === "notice") {
        return buildEventSearchResult(item.event, index);
      }

      return null;
    })
    .filter(Boolean);
}

function buildTaskSearchResults(taskBlocks) {
  return taskBlocks.map((task) => buildTaskSearchResult(task));
}

function buildTaskSearchResult(task) {
  const keyword = normalizeSearchKeyword(state.detail.search);
  const prompt = task.user.text || "";
  const summaryCandidates = [
    task.assistantMessage?.mainText,
    ...task.steps.map((step) => [step.label, step.meta].filter(Boolean).join(" · ")),
    ...task.commandGroups.map((group) => getCommandStepSummary(group, describeCommandPreview(group))),
    ...task.noticeEvents.map((event) => event.content || ""),
  ].filter(Boolean);
  const snippet = keyword
    ? resolveTaskSearchSnippet([prompt, ...summaryCandidates], keyword)
    : summaryCandidates[0] || prompt;

  return {
    key: task.key,
    targetId: getTaskContainerElementId(task.key),
    groupId: "",
    kind: "Task",
    title: shortenText(prompt || `Task ${task.index + 1}`, 120),
    snippet: shortenText(snippet || "", 180),
    meta: task.executionStatus.label,
    ts: task.startedAt,
  };
}

function resolveTaskSearchSnippet(candidates, keyword) {
  const normalized = normalizeSearchKeyword(keyword);
  if (!normalized) {
    return candidates.find(Boolean) || "";
  }

  return (
    candidates.find((candidate) => String(candidate || "").toLowerCase().includes(normalized)) ||
    candidates.find(Boolean) ||
    ""
  );
}

function getCommandGroupInspectKey(group, index = 0) {
  return `command:${group.id || `group-${index}`}`;
}

function getUserInspectKey(item) {
  return `user:${item.id}`;
}

function getAssistantInspectKey(item) {
  return `assistant:${item.id}`;
}

function getStatusInspectKey(event, index = 0) {
  return `status:${event.id || `status-${index}`}`;
}

function getNoticeInspectKey(event, index = 0) {
  return `notice:${event.id || `notice-${index}`}`;
}

function getConversationItemInspectKey(item, index = 0) {
  if (item.type === "tool") {
    return getCommandGroupInspectKey(item.group, index);
  }

  if (item.type === "user") {
    return getUserInspectKey(item);
  }

  if (item.type === "assistant") {
    return getAssistantInspectKey(item);
  }

  if (item.type === "status") {
    return getStatusInspectKey(item.event, index);
  }

  if (item.type === "notice") {
    return getNoticeInspectKey(item.event, index);
  }

  return `item:${index}`;
}

function resolveInspectItem(items, selectionKey) {
  if (!selectionKey) {
    return null;
  }

  return (
    items.find((item, index) => getConversationItemInspectKey(item, index) === selectionKey) || null
  );
}

function resolveInspectTask(taskBlocks, selectionKey) {
  if (!selectionKey) {
    return null;
  }

  return taskBlocks.find((task) => task.key === selectionKey) || null;
}

function getSelectedModelLabel(uiOptions, launch, threadInfo) {
  const opts =
    uiOptions && Array.isArray(uiOptions.models) && uiOptions.models.length > 0
      ? uiOptions
      : CLIENT_FALLBACK_CODEX_UI_OPTIONS;
  return (
    opts.models.find((item) => item.id === launch?.modelId)?.label ||
    threadInfo?.model ||
    opts.models[0]?.label ||
    t("session.model.unsynced")
  );
}

function getSelectedReasoningLabel(uiOptions, launch, threadInfo) {
  const opts =
    uiOptions && Array.isArray(uiOptions.reasoningLevels) && uiOptions.reasoningLevels.length > 0
      ? uiOptions
      : CLIENT_FALLBACK_CODEX_UI_OPTIONS;
  return (
    (() => {
      const selected = opts.reasoningLevels.find((item) => item.id === launch?.reasoningId);
      return selected
        ? formatReasoningEffortLabel(selected.id || selected.label)
        : "";
    })() ||
    (threadInfo?.reasoningEffort ? formatReasoningEffortLabel(threadInfo.reasoningEffort) : "") ||
    t("session.reasoning.unsynced")
  );
}

function formatReasoningEffortLabel(value) {
  if (value === "low") {
    return t("runtime.low");
  }

  if (value === "medium") {
    return t("runtime.medium");
  }

  if (value === "high") {
    return t("runtime.high");
  }

  if (value === "xhigh") {
    return t("runtime.xhigh");
  }

  return value || t("session.reasoning.unsynced");
}

function openInspectDrawer(selectionKey = state.detail.inspectSelectionKey) {
  state.detail.inspectDrawerOpen = true;
  if (selectionKey) {
    state.detail.inspectSelectionKey = selectionKey;
  }

  if (!state.detail.codexQuota && state.detail.session?.sessionId) {
    getCodexQuota(state.detail.session.sessionId)
      .then((payload) => {
        setDetailCodexQuota(state.detail.session.sessionId, payload);
        if (state.detail.inspectDrawerOpen) {
          renderSessionDetail();
        }
      })
      .catch(() => {});
  }
}

function closeInspectDrawer() {
  if (!state.detail.inspectDrawerOpen) {
    return;
  }

  state.detail.inspectDrawerOpen = false;
  renderSessionDetail();
}

function renderInspectSearchSection({
  searchResults,
  visibleEventCount,
  filterOptions,
  severityOptions,
}) {
  return `
    <div class="inspect-search-stack">
      <label class="event-search-field inspect-search-field">
        <span>${escapeHtml(t("inspect.searchFlow"))}</span>
        <input
          id="event-search"
          value="${escapeHtml(state.detail.search)}"
          placeholder="${escapeHtml(t("inspect.searchPlaceholder"))}"
        />
      </label>
      <div class="inspect-toolbar-meta">
        <span>${escapeHtml(
          t("generic.showing", {
            visible: visibleEventCount,
            total: state.detail.rawEvents.length,
          }),
        )}</span>
        <div class="event-toolbar-actions">
          ${
            state.detail.search.trim()
              ? `
                <div class="search-hit-nav">
                  <span id="search-hit-status" class="search-hit-status">0 / 0</span>
                  <button id="search-hit-prev" type="button" class="secondary-button">${escapeHtml(t("inspect.searchPrev"))}</button>
                  <button id="search-hit-next" type="button" class="secondary-button">${escapeHtml(t("inspect.searchNext"))}</button>
                </div>
              `
              : ""
          }
          ${
            state.detail.search.trim()
              ? `<button id="clear-event-search" type="button" class="secondary-button">${escapeHtml(t("inspect.clearSearch"))}</button>`
              : ""
          }
        </div>
      </div>
      <div class="inspect-filter-group">
        <span class="meta-label">${escapeHtml(t("generic.type"))}</span>
        <div class="event-filters">
          ${filterOptions
            .map(
              (option) => `
                <button
                  type="button"
                  class="filter-chip ${state.detail.filter === option.id ? "filter-chip-active" : ""}"
                  data-event-filter="${option.id}"
                >
                  ${escapeHtml(option.label)} · ${escapeHtml(String(option.count))}
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
      <div class="inspect-filter-group">
        <span class="meta-label">${escapeHtml(t("generic.level"))}</span>
        <div class="event-filters">
          ${severityOptions
            .map(
              (option) => `
                <button
                  type="button"
                  class="filter-chip ${state.detail.severity === option.id ? "filter-chip-active" : ""}"
                  data-event-severity="${option.id}"
                >
                  ${escapeHtml(option.label)} · ${escapeHtml(String(option.count))}
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
      <div class="search-results-panel inspect-search-results">
        <div class="search-results-header">
          <span class="search-results-title">${escapeHtml(t("inspect.results"))}</span>
          <span class="search-results-count">${escapeHtml(t("inspect.resultCount", { count: searchResults.length }))}</span>
        </div>
        ${
          searchResults.length > 0
            ? `<div class="search-results-list">${searchResults
                .map((result) => renderSearchResultItem(result))
                .join("")}</div>`
            : `<div class="search-results-empty">${escapeHtml(t("inspect.emptySearch"))}</div>`
        }
      </div>
    </div>
  `;
}

function renderInspectQuota(detailState) {
  const quota = detailState.codexQuota?.quota;
  const hourPercent =
    typeof quota?.hour?.percent === "number" && Number.isFinite(quota.hour.percent)
      ? `${quota.hour.percent}%`
      : "--";
  const hourRemain =
    typeof quota?.hour?.remainTime === "string" && quota.hour.remainTime.trim()
      ? quota.hour.remainTime.trim()
      : "--";
  const weekPercent =
    typeof quota?.week?.percent === "number" && Number.isFinite(quota.week.percent)
      ? `${quota.week.percent}%`
      : "--";
  const weekReset =
    typeof quota?.week?.resetDate === "string" && quota.week.resetDate.trim()
      ? quota.week.resetDate.trim()
      : "--";

  return `
    <div class="inspect-quota-card">
      <p class="inspect-quota-title">${escapeHtml(t("composer.quota.remaining"))}</p>
      <p class="inspect-quota-line">${escapeHtml(t("composer.quota.hours", { percent: hourPercent, remain: hourRemain }))}</p>
      <p class="inspect-quota-line">${escapeHtml(t("composer.quota.week", { percent: weekPercent, reset: weekReset }))}</p>
    </div>
  `;
}

function renderRawEventList(events) {
  const items = [...events].slice(-80).reverse();
  if (items.length === 0) {
    return `<div class="inspect-empty">${escapeHtml(t("inspect.rawEventsEmpty"))}</div>`;
  }

  return `
    <div class="inspect-raw-list">
      ${items
        .map((event) => {
          const summary =
            event.type === "message.user"
              ? event.content || ""
              : event.type === "cli.chunk"
                ? `${event.stream || "stdout"} · ${event.content || ""}`
                : event.type === "session.status"
                  ? event.status || ""
                  : event.type === "cli.exit"
                    ? `exit ${String(event.exitCode ?? "—")}`
                    : event.content || "";

          return `
            <div class="inspect-raw-item">
              <div class="inspect-raw-head">
                <span class="inspect-raw-kind">${escapeHtml(event.type)}</span>
                <span class="inspect-raw-ts">${escapeHtml(event.ts ? formatTs(event.ts) : "—")}</span>
              </div>
              <p class="inspect-raw-summary">${escapeHtml(shortenText(summary, 160) || "—")}</p>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function formatRuntimeValue(value, fallback = t("generic.notSynced")) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function collectRuntimeHints(session) {
  const status = state.detail.codexStatus || {};
  const runtimeHints = Array.isArray(status.runtimeHints)
    ? status.runtimeHints.map((hint) => localizeRuntimeHint(hint, status.runtime))
    : [];
  const eventHints = [];
  const recentEvents = [...state.detail.rawEvents].slice(-40);

  if (
    recentEvents.some(
      (event) =>
        event.type === "cli.chunk" &&
        event.stream === "stderr" &&
        /operation not permitted|permission denied/i.test(String(event.content || "")),
    )
  ) {
    eventHints.push(t("inspect.hint.permissionsDenied"));
  }

  if (
    recentEvents.some(
      (event) =>
        event.type === "cli.chunk" &&
        event.stream === "stderr" &&
        /read-only/i.test(String(event.content || "")),
    )
  ) {
    eventHints.push(t("inspect.hint.readOnly"));
  }

  if (
    session?.status === "failed" &&
    recentEvents.some(
      (event) =>
        (event.type === "system.notice" || event.type === "cli.chunk") &&
        /sandbox|approval/i.test(String(event.content || "")),
    )
  ) {
    eventHints.push(t("inspect.hint.sandboxApproval"));
  }

  return [...new Set([...runtimeHints, ...eventHints])];
}

function localizeRuntimeHint(hint, runtime) {
  const text = String(hint || "").trim();
  if (!text) {
    return "";
  }

  if (
    text === "当前是 read-only sandbox，不能直接写文件或执行会修改环境的命令。" ||
    text === "The current runtime is using a read-only sandbox. File writes and environment-changing commands are blocked."
  ) {
    return t("inspect.hint.readOnly");
  }

  if (
    text === "当前是 workspace-write sandbox，只能写入当前 workspace roots。" ||
    text === "The current runtime is using a workspace-write sandbox. It can only write inside the current writable roots."
  ) {
    return t("inspect.hint.workspaceWrite");
  }

  if (
    text === `当前 ${runtime?.executionMode} 运行链路不支持交互审批弹窗。` ||
    text === `The current ${runtime?.executionMode} runtime path does not support interactive approval prompts.`
  ) {
    return t("inspect.hint.noInteractiveApproval", {
      mode: runtime?.executionMode || "runtime",
    });
  }

  if (
    runtime?.workspaceRoot &&
    (text === `当前 workspace root 是 ${runtime.workspaceRoot}。` ||
      text === `The current workspace root is ${runtime.workspaceRoot}.`)
  ) {
    return t("inspect.hint.workspaceRoot", {
      path: runtime.workspaceRoot,
    });
  }

  return text;
}

function localizeApprovalTitle(title) {
  const normalized = String(title || "").trim();
  if (!normalized) {
    return t("approval.required");
  }

  if (
    normalized === "命令执行需要授权" ||
    normalized === "Command execution requires approval"
  ) {
    return t("approval.commandRequired");
  }

  if (
    normalized === "文件修改需要授权" ||
    normalized === "File changes require approval"
  ) {
    return t("approval.fileChangeRequired");
  }

  if (
    normalized === "额外权限需要授权" ||
    normalized === "Extra permissions require approval"
  ) {
    return t("approval.extraPermissionRequired");
  }

  if (
    normalized === "操作需要授权" ||
    normalized === "Approval required" ||
    normalized === "Approval required for operation"
  ) {
    return t("approval.required");
  }

  return normalized;
}

function renderRuntimeRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    return `<strong>${escapeHtml(t("generic.none"))}</strong>`;
  }

  return `<strong>${roots.map((item) => escapeHtml(String(item))).join("<br>")}</strong>`;
}

function renderInspectSessionSection(session) {
  const runtime = state.detail.codexStatus?.runtime || null;
  const runtimeHints = collectRuntimeHints(session);
  const projectPath = session.projectPath || "";

  return `
    <div class="inspect-session-stack">
      ${renderInspectQuota(state.detail)}
      <div class="inspect-session-card">
        <div class="inspect-session-row"><span class="meta-label">${escapeHtml(t("inspect.session"))}</span><strong>${escapeHtml(session.sessionId)}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">${escapeHtml(t("inspect.project"))}</span><strong>${escapeHtml(session.projectId)}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">${escapeHtml(t("inspect.projectDirectory"))}</span><strong>${escapeHtml(projectPath || t("generic.notSynced"))}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">${escapeHtml(t("inspect.currentCwd"))}</span><strong>${escapeHtml(formatRuntimeValue(runtime?.cwd, projectPath || t("generic.notSynced")))}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">${escapeHtml(t("inspect.executionPath"))}</span><strong>${escapeHtml(formatRuntimeValue(runtime?.executionMode, "codex app-server"))}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">Sandbox</span><strong>${escapeHtml(formatRuntimeValue(runtime?.sandboxMode))}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">Approval</span><strong>${escapeHtml(formatRuntimeValue(runtime?.approvalMode))}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">${escapeHtml(t("inspect.workspaceRoot"))}</span><strong>${escapeHtml(formatRuntimeValue(runtime?.workspaceRoot, projectPath || t("generic.notSynced")))}</strong></div>
        <div class="inspect-session-row inspect-session-row-multiline"><span class="meta-label">${escapeHtml(t("inspect.writableRoots"))}</span>${renderRuntimeRoots(runtime?.writableRoots)}</div>
        <div class="inspect-session-row"><span class="meta-label">WS</span><strong>${escapeHtml(state.socketState)}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">${escapeHtml(t("inspect.pid"))}</span><strong>${escapeHtml(String(session.pid ?? t("generic.notStarted")))}</strong></div>
        <div class="inspect-session-row"><span class="meta-label">${escapeHtml(t("inspect.thread"))}</span><strong>${escapeHtml(session.codexThreadId || t("generic.notEstablished"))}</strong></div>
      </div>
      ${
        runtimeHints.length > 0
          ? `
            <div class="inspect-session-card inspect-session-card-hints">
              <div class="inspect-detail-head">
                <span class="inspect-detail-kind">${escapeHtml(t("inspect.runtimeHints"))}</span>
              </div>
              <div class="inspect-hint-list">
                ${runtimeHints
                  .map((hint) => `<p class="inspect-hint-item">${escapeHtml(hint)}</p>`)
                  .join("")}
              </div>
            </div>
          `
          : ""
      }
      <div class="inspect-session-actions">
        <button id="refresh-events" class="secondary-button" type="button">${escapeHtml(t("inspect.fetchHistory"))}</button>
        ${
          !state.detail.autoScroll
            ? `<button id="resume-auto-scroll" type="button" class="secondary-button toolbar-jump-button">${escapeHtml(t("inspect.followBottom"))}</button>`
            : ""
        }
        <button
          id="toggle-auto-scroll"
          type="button"
          class="secondary-button ${state.detail.autoScroll ? "toolbar-toggle-active" : ""}"
          aria-pressed="${state.detail.autoScroll ? "true" : "false"}"
        >
          ${escapeHtml(t("inspect.autoScroll", { value: t(state.detail.autoScroll ? "generic.on" : "generic.off") }))}
        </button>
      </div>
      <details class="inspect-raw-details">
        <summary class="inspect-raw-summary-toggle">${escapeHtml(t("inspect.rawEventsDebug"))}</summary>
        ${renderRawEventList(state.detail.rawEvents)}
      </details>
    </div>
  `;
}

function renderInspectDetailSection(selectedTask) {
  if (!selectedTask) {
    return `<div class="inspect-empty">${escapeHtml(t("inspect.emptySelection"))}</div>`;
  }

  const promptText = selectedTask.user.text || "";
  const assistantText = selectedTask.assistantMessage?.mainText || "";
  const finalCopyPayload = encodeCopyPayload(assistantText);

  return `
    <div class="inspect-detail-stack">
      <div class="inspect-detail-head">
        <span class="inspect-detail-kind">${escapeHtml(t("inspect.detailTitle"))}</span>
        ${
          selectedTask.startedAt
            ? `<span class="search-result-meta">${escapeHtml(formatTs(selectedTask.startedAt))}</span>`
            : ""
        }
      </div>

      <div class="inspect-detail-card inspect-detail-card-user">
        <div class="inspect-detail-head">
          <span class="inspect-detail-kind">${escapeHtml(t("inspect.userInput"))}</span>
        </div>
        <div>${renderSearchHighlight(promptText, state.detail.search)}</div>
      </div>

      <div class="inspect-detail-card">
        <div class="inspect-detail-head">
          <span class="inspect-detail-kind">${escapeHtml(t("inspect.executionDetails"))}</span>
          <span class="pill ${escapeHtml(selectedTask.executionStatus.className)}">${escapeHtml(getTaskExecutionLineLabel(selectedTask))}</span>
        </div>
        ${renderTaskStepList(selectedTask)}
        ${renderTaskExecutionDetails(selectedTask)}
      </div>

      <div class="inspect-detail-card inspect-detail-card-assistant">
        <div class="inspect-detail-head">
          <span class="inspect-detail-kind">${escapeHtml(t("inspect.assistantReply"))}</span>
          ${
            assistantText
              ? `<button type="button" class="event-copy-button" data-copy-text="${escapeHtml(finalCopyPayload)}">${escapeHtml(t("generic.copy"))}</button>`
              : ""
          }
        </div>
        <div class="msg-md">
          ${
            assistantText
              ? formatAssistantHtml(assistantText, state.detail.search)
              : `<p class="msg-md-p msg-md-empty">${escapeHtml(getTaskExecutionLineLabel(selectedTask))}</p>`
          }
        </div>
      </div>
    </div>
  `;
}

function getInspectSelectionTitle(selectedTask) {
  if (!selectedTask) {
    return t("inspect.selectionTitle");
  }

  const promptText = selectedTask.user.text || "";
  return shortenText(promptText || `Task ${selectedTask.index + 1}`, 60);
}

function buildCommandGroupSearchResult(group, index) {
  const matchCount = group.matchingEvents?.length || 0;
  const firstMatch = group.matchingEvents?.find((event) => event.id !== group.startEvent.id) || group.startEvent;

  return {
    key: getCommandGroupInspectKey(group, index),
    targetId: getCommandGroupElementId(group.id || `group-${index}`),
    groupId: group.id || `group-${index}`,
    kind: t("inspect.tool"),
    title: group.command || t("inspect.commandUnknown"),
    snippet: describeSearchResultSnippet(firstMatch),
    meta: t("inspect.resultCountMatches", { count: matchCount }),
    ts: group.startEvent.ts,
  };
}

function buildUserConversationSearchResult(item) {
  const ev = item.events[0];
  return {
    key: getUserInspectKey(item),
    targetId: getUserBubbleElementId(ev.id),
    groupId: "",
    kind: t("inspect.userKind"),
    title: ev.content || "",
    snippet: "",
    meta: ev.ts ? formatTs(ev.ts) : "",
    ts: ev.ts,
  };
}

function buildAssistantConversationSearchResult(item) {
  const text = item.events.map((e) => e.content || "").join("");
  return {
    key: getAssistantInspectKey(item),
    targetId: getAssistantBubbleElementId(item.id),
    groupId: "",
    kind: "Assistant",
    title: shortenText(text, 140),
    snippet: shortenText(text, 200),
    meta: item.events[0]?.ts ? formatTs(item.events[0].ts) : "",
    ts: item.events[0]?.ts,
  };
}

function buildStatusSearchResult(item, index) {
  return {
    key: getStatusInspectKey(item.event, index),
    targetId: getEventElementId(item.event.id || `status-${index}`),
    groupId: "",
    kind: t("inspect.statusKind"),
    title: sessionStatusLabel(item.event.status),
    snippet: "",
    meta: item.event.ts ? formatTs(item.event.ts) : "",
    ts: item.event.ts,
  };
}

function buildEventSearchResult(event, index) {
  return {
    key: getNoticeInspectKey(event, index),
    targetId: getEventElementId(event.id || `event-${index}`),
    groupId: "",
    kind: searchResultKindLabel(event),
    title: describeSearchResultTitle(event),
    snippet: describeSearchResultSnippet(event),
    meta: event.ts ? formatTs(event.ts) : "",
    ts: event.ts,
  };
}

function renderSearchResultItem(result) {
  return `
    <button
      type="button"
      class="search-result-item ${state.detail.activeSearchResultKey === result.key ? "search-result-item-active" : ""}"
      data-search-result-key="${escapeHtml(result.key)}"
      data-search-result-target="${escapeHtml(result.targetId)}"
      data-search-result-group-id="${escapeHtml(result.groupId || "")}"
    >
      <div class="search-result-head">
        <span class="search-result-kind">${escapeHtml(result.kind)}</span>
        ${
          result.meta
            ? `<span class="search-result-meta">${escapeHtml(result.meta)}</span>`
            : ""
        }
      </div>
      <strong class="search-result-title">${renderSearchHighlight(shortenText(result.title, 120), state.detail.search)}</strong>
      ${
        result.snippet && result.snippet !== result.title
          ? `<p class="search-result-snippet">${renderSearchHighlight(shortenText(result.snippet, 160), state.detail.search)}</p>`
          : ""
      }
    </button>
  `;
}

function formatAssistantHtml(text, search) {
  const raw = String(text || "");
  if (!raw.trim()) {
    return `<p class="msg-md-p msg-md-empty">${renderSearchHighlight("", search)}</p>`;
  }

  const html = renderMessageRichText(raw, {
    renderText: (value) => renderSearchHighlight(value, search),
    renderCodeText: (value) => renderSearchHighlight(value, search),
    renderCodeBlock: (block, helpers) => {
      const lang = String(block.lang || "").trim() || "code";
      const code = String(block.text || "").replace(/\n$/, "");
      const copyAttr = escapeHtml(encodeCopyPayload(code));
      return `<div class="msg-md-code-block"><div class="code-block-toolbar"><span class="code-block-lang">${escapeHtml(lang)}</span><button type="button" class="event-copy-button code-block-copy" data-copy-text="${copyAttr}">${escapeHtml(t("generic.copy"))}</button></div><pre class="msg-md-pre"><code class="msg-md-code">${helpers.renderCodeText(code)}</code></pre></div>`;
    },
  });

  return html || `<p class="msg-md-p">${renderSearchHighlight(raw.trim(), search)}</p>`;
}

function renderUserBubble(item) {
  const ev = item.events[0];
  const id = escapeHtml(getUserBubbleElementId(ev.id));
  const copyPayload = encodeCopyPayload(ev.content || "");
  const inspectKey = escapeHtml(getUserInspectKey(item));

  return `
    <div
      id="${id}"
      class="transcript-row transcript-row-user"
      data-inspect-key="${inspectKey}"
    >
      <article class="msg-bubble msg-user msg-user-soft transcript-inspectable" aria-label="${escapeHtml(t("timeline.userMessage"))}">
        <div class="msg-bubble-body">${renderSearchHighlight(ev.content || "", state.detail.search)}</div>
        <div class="msg-bubble-actions">
          <button type="button" class="event-copy-button msg-copy" data-copy-text="${escapeHtml(copyPayload)}">${escapeHtml(t("generic.copy"))}</button>
        </div>
      </article>
    </div>
  `;
}

function renderAssistantBubble(item) {
  const text = item.events.map((e) => e.content || "").join("");
  const id = escapeHtml(getAssistantBubbleElementId(item.id));
  const copyPayload = encodeCopyPayload(text);
  const bodyHtml = formatAssistantHtml(text, state.detail.search);
  const inspectKey = escapeHtml(getAssistantInspectKey(item));

  return `
    <div
      id="${id}"
      class="transcript-row transcript-row-assistant"
      data-inspect-key="${inspectKey}"
    >
      <article class="msg-bubble msg-assistant transcript-inspectable" aria-label="${escapeHtml(t("timeline.assistant"))}">
        <div class="msg-bubble-body msg-md">${bodyHtml}</div>
        <div class="msg-bubble-actions">
          <button type="button" class="event-copy-button msg-copy" data-copy-text="${escapeHtml(copyPayload)}">${escapeHtml(t("generic.copy"))}</button>
        </div>
      </article>
    </div>
  `;
}

function isRawStdoutBucketExpanded(bucketId) {
  const explicit = state.detail.rawStdoutBuckets[bucketId];
  if (typeof explicit === "boolean") {
    return explicit;
  }

  return false;
}

function renderRawStdoutBucket(item) {
  const expanded = isRawStdoutBucketExpanded(item.id);
  const text = item.events.map((e) => e.content || "").join("\n");
  const id = escapeHtml(getRawStdoutElementId(item.id));
  const jsonish =
    item.events.length === 1 && String(item.events[0].content || "").trimStart().startsWith("{");

  return `
    <div id="${id}" class="transcript-row transcript-row-raw">
      <article class="raw-stdout-card ${expanded ? "raw-stdout-open" : ""} ${jsonish ? "raw-stdout-jsonish" : ""}">
        <button
          type="button"
          class="raw-stdout-toggle"
          data-raw-stdout-toggle="${escapeHtml(item.id)}"
          aria-expanded="${expanded ? "true" : "false"}"
        >
          <span class="raw-stdout-title">${escapeHtml(t("inspect.rawStdout"))}</span>
          <span class="raw-stdout-meta">${escapeHtml(t("generic.segmentCount", { count: item.events.length }))}</span>
          <span class="raw-stdout-chevron">${escapeHtml(t(expanded ? "generic.collapse" : "generic.expand"))}</span>
        </button>
        ${
          expanded
            ? `<pre class="raw-stdout-body">${renderSearchHighlight(text, state.detail.search)}</pre>`
            : ""
        }
      </article>
    </div>
  `;
}

function renderOrphanStderrBucket(item) {
  const text = item.events.map((e) => e.content || "").join("\n");
  const id = escapeHtml(getOrphanStderrElementId(item.id));
  const copyPayload = encodeCopyPayload(text);

  return `
    <div id="${id}" class="transcript-row transcript-row-stderr">
      <article class="orphan-stderr-card" aria-label="Stderr">
        <div class="orphan-stderr-head">
          <span class="orphan-stderr-label">stderr</span>
          <button type="button" class="event-copy-button msg-copy" data-copy-text="${escapeHtml(copyPayload)}">${escapeHtml(t("generic.copy"))}</button>
        </div>
        <pre class="orphan-stderr-body">${renderSearchHighlight(text, state.detail.search)}</pre>
      </article>
    </div>
  `;
}

function renderNoticeRow(item) {
  const ev = item.event;
  const id = escapeHtml(getEventElementId(ev.id));
  const levelClass =
    ev.level === "error"
      ? "msg-notice-error"
      : ev.level === "warning"
        ? "msg-notice-warning"
        : "msg-notice-info";

  return `
    <div
      id="${id}"
      class="transcript-row transcript-row-notice"
      data-inspect-key="${escapeHtml(getNoticeInspectKey(ev))}"
    >
      <article class="msg-notice ${levelClass}" role="status">
        <p class="msg-notice-text">${renderSearchHighlight(ev.content || "", state.detail.search)}</p>
      </article>
    </div>
  `;
}

function renderStatusMarker(item) {
  const event = item.event;
  const id = escapeHtml(getEventElementId(event.id));
  return `
    <div
      id="${id}"
      class="transcript-row transcript-row-status"
      data-inspect-key="${escapeHtml(getStatusInspectKey(event))}"
    >
      <div class="status-marker status-marker-${escapeHtml(event.status || "idle")}">
        <span class="status-marker-dot" aria-hidden="true"></span>
        <span class="status-marker-label">${escapeHtml(sessionStatusLabel(event.status))}</span>
      </div>
    </div>
  `;
}

function renderToolBodyEvent(event) {
  const id = escapeHtml(getEventElementId(event.id));
  const search = state.detail.search;

  if (event.type === "cli.chunk" && event.stream === "command") {
    return `
      <div id="${id}" class="tool-body-chunk tool-body-command">
        <pre>${renderSearchHighlight(event.content || "", search)}</pre>
      </div>
    `;
  }

  if (event.type === "cli.chunk" && event.stream === "stderr") {
    return `
      <div id="${id}" class="tool-body-chunk tool-body-stderr">
        <pre>${renderSearchHighlight(event.content || "", search)}</pre>
      </div>
    `;
  }

  if (event.type === "system.notice") {
    const levelClass =
      event.level === "error"
        ? "tool-body-notice-error"
        : event.level === "warning"
          ? "tool-body-notice-warning"
          : "tool-body-notice-muted";

    return `
      <div id="${id}" class="tool-body-notice ${levelClass}">
        <p>${renderSearchHighlight(event.content || "", search)}</p>
      </div>
    `;
  }

  return "";
}

function renderConversationItem(item) {
  if (item.type === "tool") {
    return renderCommandGroup(item.group);
  }

  if (item.type === "user") {
    return renderUserBubble(item);
  }

  if (item.type === "assistant") {
    return renderAssistantBubble(item);
  }

  if (item.type === "status") {
    return renderStatusMarker(item);
  }

  if (item.type === "notice") {
    return renderNoticeRow(item);
  }

  return "";
}

// LEGACY: deprecated task-block renderer. Kept temporarily during migration so
// related helper code can be removed in smaller follow-up diffs. Main detail
// rendering no longer uses this path.
function renderSessionStreamShell(taskBlocks) {
  const streamBody =
    taskBlocks.length > 0
      ? taskBlocks.map((task) => renderTaskBlock(task)).join("")
      : `<div class="event-empty">${escapeHtml(t("timeline.empty"))}</div>`;

  return `
    <div class="session-stream-shell">
      <div class="session-stream-main">
        <div id="event-list" class="event-list task-list event-list--flex">
          ${streamBody}
        </div>
      </div>
    </div>
  `;
}

function renderTaskBlock(task) {
  const promptText = task.user.text || "";
  const assistantText = task.assistantMessage?.mainText || "";
  const finalCopyPayload = encodeCopyPayload(assistantText);
  const assistantMainHtml = renderTaskAssistantMain(task);
  const assistantBubbleClass = assistantText
    ? "msg-bubble msg-assistant turn-assistant-bubble"
    : "msg-bubble msg-assistant turn-assistant-bubble turn-assistant-bubble-thinking";
  const assistantBodyClass = assistantText
    ? "msg-bubble-body msg-md assistant-main-block"
    : "msg-bubble-body msg-md assistant-main-block assistant-main-block-thinking";

  return `
    <div
      id="${escapeHtml(getTaskContainerElementId(task.key))}"
      class="turn-thread"
    >
      <div class="transcript-row transcript-row-user">
        <article class="msg-bubble msg-user msg-user-soft" aria-label="${escapeHtml(t("timeline.userMessage"))}">
          <div class="msg-bubble-body">${renderSearchHighlight(promptText, state.detail.search)}</div>
        </article>
      </div>

      <div class="transcript-row transcript-row-assistant">
        <article class="${assistantBubbleClass}" aria-label="${escapeHtml(t("timeline.assistant"))}">
          <div class="${assistantBodyClass}">
            ${assistantMainHtml}
          </div>

          ${
            assistantText
              ? `
                <div class="msg-bubble-actions">
                  <button type="button" class="event-copy-button msg-copy" data-copy-text="${escapeHtml(finalCopyPayload)}">${escapeHtml(t("generic.copy"))}</button>
                </div>
              `
              : ""
          }
        </article>
      </div>
    </div>
  `;
}

function hasTaskExecutionDetails(task) {
  return (
    task.steps.length > 0 ||
    task.commandGroups.length > 0 ||
    task.orphanStdoutEvents.length > 0 ||
    task.orphanStderrEvents.length > 0 ||
    task.noticeEvents.length > 0 ||
    task.statusEvents.length > 0 ||
    task.exitEvents.length > 0
  );
}

function getTaskExecutionLineLabel(task) {
  const statusId = task.executionStatus?.id || "idle";
  return getTaskExecutionLineLabelFromStatus(statusId);
}

function renderTaskAssistantMain(task) {
  const showLiveExecutionTimeline =
    state.detail.liveExecutionTaskKey === task.key &&
    Array.isArray(task.steps) &&
    task.steps.length > 0;

  if (showLiveExecutionTimeline) {
    return renderTaskAssistantTimeline(task);
  }

  const compactStepsHtml = showLiveExecutionTimeline
    ? ""
    : renderTaskStepList(task, {
        compact: true,
        onlyActive: true,
        includeRecentWhenIdle: !task.assistantMessage?.mainText,
      });

  let mainHtml = "";
  if (task.assistantMessage?.mainText) {
    mainHtml = `${formatAssistantHtml(task.assistantMessage.mainText, state.detail.search)}`;
  } else {
    mainHtml = "";
  }

  return `
    <div class="assistant-main-stack">
      <div class="assistant-main-text">
        ${mainHtml}
      </div>
      ${compactStepsHtml}
    </div>
  `;
}

function renderTaskAssistantTimeline(task, options = {}) {
  const executionEvents = Array.isArray(task.executionEvents) ? task.executionEvents : [];
  const stepByGroupId = new Map(
    (Array.isArray(task.steps) ? task.steps : [])
      .filter((step) => step.kind === "command" && step.groupId)
      .map((step) => [step.groupId, step]),
  );
  const commandRanges = listCommandGroupRanges(executionEvents);
  const commandRangeByStart = new Map(commandRanges.map((range) => [range.start, range]));
  const blocks = [];
  let assistantBuffer = "";

  const flushAssistantBuffer = () => {
    const text = assistantBuffer.trim();
    if (!text) {
      assistantBuffer = "";
      return;
    }

    blocks.push(`
      <div class="assistant-main-text assistant-main-text-inline">
        ${formatAssistantHtml(text, state.detail.search)}
      </div>
    `);
    assistantBuffer = "";
  };

  for (let index = 0; index < executionEvents.length; index += 1) {
    const range = commandRangeByStart.get(index);
    if (range) {
      flushAssistantBuffer();
      const step = stepByGroupId.get(range.group.id);
      if (step) {
        blocks.push(renderTaskTimelineCommandStep(task, step));
      }
      index = range.end;
      continue;
    }

    const event = executionEvents[index];
    if (event?.type === "cli.chunk" && event.stream === "assistant" && event.content) {
      assistantBuffer += event.content;
    }
  }

  flushAssistantBuffer();
  return `
    <div class="assistant-main-stack assistant-main-stack-live">
      ${blocks.join("")}
    </div>
  `;
}

function renderTaskTimelineCommandStep(task, step) {
  const stepKey = step.groupId || `step-${task.key}`;
  const expanded = isTaskStepExpanded(task.key, stepKey, Boolean(step.defaultExpanded));
  const collapsedSummary = step.collapsedSummary || step.detailSummary || "";
  const detailBlock =
    expanded && step.group
      ? `
            <div class="task-step-detail-body">
              ${renderInlineCommandDetail(step.group)}
            </div>
          `
      : "";

  return `
    <div class="task-step-list task-step-list-inline">
      <div class="task-step-item task-step-item-command task-step-item-command-${escapeHtml(step.status || "success")} ${expanded ? "task-step-item-expanded" : "task-step-item-collapsed"}">
        <button
          type="button"
          class="task-step-toggle-row"
          data-task-step-toggle="1"
          data-task-key="${escapeHtml(task.key)}"
          data-step-key="${escapeHtml(stepKey)}"
          aria-expanded="${expanded ? "true" : "false"}"
        >
          <span class="task-step-toggle-main">
            <span class="task-step-label task-step-label-muted">${renderSearchHighlight(step.label, state.detail.search)}</span>
            ${step.meta ? `<span class="task-step-meta">${escapeHtml(step.meta)}</span>` : ""}
          </span>
        </button>
        ${
          step.status === "running" && Array.isArray(step.previewLines) && step.previewLines.length > 0
            ? `
              <div class="task-step-preview task-step-preview-running">
                ${step.previewLines
                  .map(
                    (line) =>
                      `<div class="task-step-preview-line">${renderSearchHighlight(
                        shortenText(line, 180),
                        state.detail.search,
                      )}</div>`,
                  )
                  .join("")}
              </div>
            `
            : collapsedSummary
              ? `<div class="task-step-collapsed-summary">${renderSearchHighlight(collapsedSummary, state.detail.search)}</div>`
              : ""
        }
        ${detailBlock}
      </div>
    </div>
  `;
}

function renderTaskStepList(task, options = {}) {
  const compact = Boolean(options.compact);
  const onlyActive = Boolean(options.onlyActive);
  const includeRecentWhenIdle = Boolean(options.includeRecentWhenIdle);

  let steps = Array.isArray(task.steps) ? [...task.steps] : [];

  if (onlyActive) {
    const activeSteps = steps.filter((step) => {
      if (step.kind === "command") {
        return step.status === "running" || step.status === "error";
      }
      return step.kind === "warning" || step.kind === "error";
    });
    const fallbackRecentSteps =
      includeRecentWhenIdle && activeSteps.length === 0
        ? steps.filter((step) => step.kind === "command" || step.kind === "warning").slice(-1)
        : [];

    steps = activeSteps.length > 0 ? activeSteps : fallbackRecentSteps;

    // 主流里最多只放一条当前命令，避免全堆在顶部
    const runningCommands = steps.filter((step) => step.kind === "command");
    const notices = steps.filter((step) => step.kind !== "command");
    const latestRunning = runningCommands.length > 0 ? [runningCommands.at(-1)] : [];
    steps = [...latestRunning, ...notices].slice(0, 2);
  }

  if (!steps.length) {
    return compact ? "" : `<div class="task-step-empty">${escapeHtml(t("task.empty"))}</div>`;
  }

  return `
    <div class="task-step-list ${compact ? "task-step-list-compact" : "task-step-list-detail"}">
      ${steps
    .map((step, index) => {
      if (step.kind !== "command") {
        return `
              <div class="task-step-item task-step-item-${escapeHtml(step.kind || "status")}">
                <div class="task-step-row">
                  <span class="task-step-label">${renderSearchHighlight(step.label, state.detail.search)}</span>
                  ${
          step.meta
            ? `<span class="task-step-meta">${escapeHtml(step.meta)}</span>`
            : ""
        }
                </div>
              </div>
            `;
      }

      const stepKey = step.groupId || `step-${index}`;
      const expanded = !compact && isTaskStepExpanded(
        task.key,
        stepKey,
        Boolean(step.defaultExpanded),
      );

      const previewLines = Array.isArray(step.previewLines) ? step.previewLines : [];
      const previewHtml =
        step.status === "running" && previewLines.length > 0
          ? `
                <div class="task-step-preview task-step-preview-running">
                  ${previewLines
            .map(
              (line) =>
                `<div class="task-step-preview-line">${renderSearchHighlight(
                  shortenText(line, 180),
                  state.detail.search,
                )}</div>`,
            )
            .join("")}
                </div>
              `
          : "";

      const collapsedSummary = step.collapsedSummary || step.detailSummary || "";
      const detailBlock =
        !compact && expanded && step.group
          ? `
                <div class="task-step-detail-body">
                  ${renderInlineCommandDetail(step.group)}
                </div>
              `
          : "";

      return `
            <div class="task-step-item task-step-item-command task-step-item-command-${escapeHtml(step.status || "success")} ${expanded ? "task-step-item-expanded" : "task-step-item-collapsed"}">
              <button
                type="button"
                class="task-step-toggle-row"
                data-task-step-toggle="${compact ? "0" : "1"}"
                data-task-key="${escapeHtml(task.key)}"
                data-step-key="${escapeHtml(stepKey)}"
                aria-expanded="${expanded ? "true" : "false"}"
                ${compact ? "tabindex='-1'" : ""}
              >
                <span class="task-step-toggle-main">
                  <span class="task-step-label task-step-label-muted">${renderSearchHighlight(step.label, state.detail.search)}</span>
                  ${
        !compact && step.meta
          ? `<span class="task-step-meta">${escapeHtml(step.meta)}</span>`
          : ""
      }
                </span>
              </button>

              ${
        step.status === "running"
          ? previewHtml
          : !compact && collapsedSummary
            ? `<div class="task-step-collapsed-summary">${renderSearchHighlight(collapsedSummary, state.detail.search)}</div>`
            : ""
      }

              ${detailBlock}
            </div>
          `;
    })
    .join("")}
    </div>
  `;
}

function renderTaskExecutionDetails(task) {
  const outputHtml = renderTaskOutputDetails(task);
  const rawEvents = getTaskRawEvents(task);

  return `
    <div class="assistant-execution-details">
      ${renderTaskStepList(task, { compact: false, onlyActive: false })}
      ${outputHtml}
      ${
    rawEvents.length > 0
      ? `
            <details class="assistant-raw-events">
              <summary>${escapeHtml(t("inspect.viewRawEvents"))}</summary>
              ${renderRawEventList(rawEvents)}
            </details>
          `
      : ""
  }
    </div>
  `;
}

function renderTaskOutputDetails(task) {
  const orphanEvents = [...task.orphanStdoutEvents, ...task.orphanStderrEvents];
  if (orphanEvents.length === 0) {
    return "";
  }

  const summaryParts = [];
  if (task.orphanStdoutEvents.length > 0) {
    summaryParts.push(t("command.stdoutCount", { count: task.orphanStdoutEvents.length }));
  }
  if (task.orphanStderrEvents.length > 0) {
    summaryParts.push(t("command.stderrCount", { count: task.orphanStderrEvents.length }));
  }

  return `
    <div class="assistant-command-item assistant-command-item-inline-detail">
      <div class="assistant-command-head">
        <span class="assistant-command-code">${escapeHtml(t("inspect.commandOutput"))}</span>
        <span class="assistant-command-meta">${escapeHtml(summaryParts.join(" · "))}</span>
      </div>
      <details class="assistant-command-output">
        <summary>${escapeHtml(t("inspect.viewOutputDetails"))}</summary>
        <div class="assistant-command-body">
          ${orphanEvents.map((event) => renderToolBodyEvent(event)).join("")}
        </div>
      </details>
    </div>
  `;
}

function renderInlineCommandDetail(group) {
  const exitCode = getCommandExitCode(group.endEvent);
  const status = getCommandRunStatusPresentation(group, exitCode);
  const timing = describeCommandTiming(group);
  const preview = describeCommandPreview(group);
  const copyPayload = encodeCopyPayload(group.command || "");
  const meta = [];

  if (group.outputCount > 0) {
    meta.push(t("command.outputCount", { count: group.outputCount }));
  }
  if (group.stderrCount > 0) {
    meta.push(t("command.stderrCount", { count: group.stderrCount }));
  }
  if (timing) {
    meta.push(timing.label);
  }
  meta.push(status.label);

  const outputSummary = getCommandOutputSummary(group, preview);

  return `
    <div class="assistant-command-item assistant-command-item-inline-detail">
      <div class="assistant-command-head">
        <code class="assistant-command-code">${escapeHtml(group.command || t("inspect.commandUnknown"))}</code>
        <span class="assistant-command-meta">${escapeHtml(meta.join(" · "))}</span>
      </div>
      ${
        outputSummary
          ? `<p class="assistant-command-preview">${renderSearchHighlight(outputSummary, state.detail.search)}</p>`
          : ""
      }
      <details class="assistant-command-output">
        <summary>${escapeHtml(t("inspect.viewFullCommandOutput"))}</summary>
        ${
          group.command
            ? `
              <div class="assistant-command-actions">
                <button
                  type="button"
                  class="event-copy-button msg-copy"
                  data-copy-text="${escapeHtml(copyPayload)}"
                >${escapeHtml(t("inspect.copyCommand"))}</button>
              </div>
            `
            : ""
        }
        <div class="assistant-command-body">
          ${
            group.events.length > 0
              ? group.events
                  .filter((event) => !isCommandEndNotice(event))
                  .map((event) => renderToolBodyEvent(event))
                  .join("") || `<div class="command-group-empty">${escapeHtml(t("generic.noExtraOutput"))}</div>`
              : `<div class="command-group-empty">${escapeHtml(t("generic.noOutputYet"))}</div>`
          }
        </div>
      </details>
    </div>
  `;
}

function getCommandOutputSummary(group, preview) {
  if (!group.endEvent) {
    return t("inspect.commandStillRunning");
  }

  if (preview && !preview.empty) {
    const firstLine = String(preview.text || "")
      .split("\n")
      .find((line) => line.trim() && line.trim() !== "…");
    if (firstLine) {
      return shortenText(firstLine.replace(/^\[stderr\]\s*/, ""), 140);
    }
  }

  if (group.stderrCount > 0) {
    return t("inspect.commandEndedWithErrors");
  }

  if (group.outputCount > 0) {
    return t("inspect.commandCompletedExpand");
  }

  return t("inspect.commandCompletedNoOutput");
}

function getTaskRawEvents(task) {
  const events = [];
  const seen = new Set();

  const pushEvent = (event) => {
    if (!event) {
      return;
    }
    const key = event.id || `${event.type}:${event.ts || ""}:${event.content || event.status || ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    events.push(event);
  };

  task.statusEvents.forEach(pushEvent);
  task.noticeEvents.forEach(pushEvent);
  task.commandGroups.forEach((group) => {
    pushEvent(group.startEvent);
    group.events.forEach(pushEvent);
    pushEvent(group.endEvent);
  });

  return events.sort((left, right) => Number(left.ts || 0) - Number(right.ts || 0));
}

function renderCommandGroup(group) {
  const exitCode = getCommandExitCode(group.endEvent);
  const status = getCommandRunStatusPresentation(group, exitCode);
  const timing = describeCommandTiming(group);
  const attention = describeCommandAttention(group);
  const preview = describeCommandPreview(group);
  const commandLabel = renderSearchHighlight(
    shortenText(group.command || t("inspect.commandUnknown"), 220),
    state.detail.search,
  );
  const stderrStrong = group.stderrCount > 0;
  const exitStrong = Boolean(exitCode && exitCode !== "0");
  const inspectKey = getCommandGroupInspectKey(group);
  const summary = getCommandStepSummary(group, preview);
  const selected = state.detail.inspectSelectionKey === inspectKey;

  return `
    <article
      id="${escapeHtml(getCommandGroupElementId(group.id))}"
      class="command-group command-step-card ${selected ? "command-step-card-selected" : ""} ${attention?.cardClass || ""} ${stderrStrong ? "command-group-has-stderr" : ""} ${exitStrong ? "command-group-exit-bad" : ""}"
      data-inspect-key="${escapeHtml(inspectKey)}"
    >
      <div class="command-task-card">
        <div class="command-task-toggle">
          <div class="command-task-toggle-body">
            <div class="command-task-title-row">
              <code class="command-task-title">${commandLabel}</code>
              <span class="command-status-pill ${escapeHtml(status.pillClass)}">${escapeHtml(status.label)}</span>
            </div>
            <p class="command-step-summary">${escapeHtml(summary)}</p>
            <div class="command-task-metrics" aria-label="${escapeHtml(t("inspect.commandMetrics"))}">
              ${
                timing
                  ? `<span class="command-task-metric command-task-metric-timing"><span class="command-task-metric-k">${escapeHtml(t("inspect.duration"))}</span><span class="command-task-metric-v">${escapeHtml(timing.value)}</span></span>`
                  : ""
              }
              <span class="command-task-metric"><span class="command-task-metric-k">${escapeHtml(t("inspect.output"))}</span><span class="command-task-metric-v">${escapeHtml(String(group.outputCount))}</span></span>
              ${
                stderrStrong
                  ? `<span class="command-task-metric command-task-metric-warn"><span class="command-task-metric-k">stderr</span><span class="command-task-metric-v">${escapeHtml(String(group.stderrCount))}</span></span>`
                  : ""
              }
              ${
                exitStrong
                  ? `<span class="command-task-metric command-task-metric-danger"><span class="command-task-metric-k">exit</span><span class="command-task-metric-v">${escapeHtml(formatExitCodeForDisplay(group.endEvent, exitCode))}</span></span>`
                  : ""
              }
            </div>
          </div>
        </div>
      </div>
    </article>
  `;
}

function getCommandStepSummary(group, preview) {
  const presentation = describeCommandPresentation(group, preview);

  if (!group.endEvent) {
    return presentation.collapsedSummary || t("command.summary.running");
  }

  return presentation.collapsedSummary || t("command.summary.completed");
}

function renderCommandGroupDetail(group) {
  const exitCode = getCommandExitCode(group.endEvent);
  const status = getCommandRunStatusPresentation(group, exitCode);
  const timing = describeCommandTiming(group);
  const copyButton = group.command
    ? `
      <button
        type="button"
        class="event-copy-button command-task-copy"
        data-copy-text="${escapeHtml(encodeCopyPayload(group.command))}"
      >${escapeHtml(t("inspect.copyCommand"))}</button>
    `
    : "";

  return `
    <div class="inspect-detail-stack">
      <div class="inspect-detail-head">
        <span class="inspect-detail-kind">${escapeHtml(t("inspect.executionSteps"))}</span>
        ${copyButton}
      </div>
      <div class="inspect-command-card">
        <div class="command-task-title-row">
          <code class="command-task-title">${escapeHtml(group.command || t("inspect.commandUnknown"))}</code>
          <span class="command-status-pill ${escapeHtml(status.pillClass)}">${escapeHtml(status.label)}</span>
        </div>
        <div class="command-task-metrics inspect-command-metrics">
          ${
            timing
              ? `<span class="command-task-metric command-task-metric-timing"><span class="command-task-metric-k">${escapeHtml(t("inspect.duration"))}</span><span class="command-task-metric-v">${escapeHtml(timing.value)}</span></span>`
              : ""
          }
          <span class="command-task-metric"><span class="command-task-metric-k">${escapeHtml(t("inspect.output"))}</span><span class="command-task-metric-v">${escapeHtml(String(group.outputCount))}</span></span>
          <span class="command-task-metric ${group.stderrCount > 0 ? "command-task-metric-warn" : ""}"><span class="command-task-metric-k">stderr</span><span class="command-task-metric-v">${escapeHtml(String(group.stderrCount))}</span></span>
          <span class="command-task-metric ${exitCode && exitCode !== "0" ? "command-task-metric-danger" : ""}">
            <span class="command-task-metric-k">exit</span>
            <span class="command-task-metric-v">${escapeHtml(formatExitCodeForDisplay(group.endEvent, exitCode))}</span>
          </span>
        </div>
      </div>
      <div class="inspect-detail-card inspect-detail-card-raw">
        ${
          group.events.length > 0
            ? group.events
                .filter((event) => !isCommandEndNotice(event))
                .map((event) => renderToolBodyEvent(event))
                .join("") || `<div class="command-group-empty">${escapeHtml(t("generic.noExtraOutput"))}</div>`
            : `<div class="command-group-empty">${escapeHtml(t("generic.noOutputYet"))}</div>`
        }
      </div>
    </div>
  `;
}

function isCommandStartNotice(event) {
  return (
    event.type === "system.notice" &&
    event.content &&
    event.content.startsWith("Running command:")
  );
}

function isCommandEndNotice(event) {
  return (
    event.type === "system.notice" &&
    event.content &&
    event.content.startsWith("Command completed")
  );
}

function isCommandBodyEvent(event) {
  return isCommandEndNotice(event) || isCommandOutputEvent(event);
}

function isCommandOutputEvent(event) {
  return (
    event.type === "cli.chunk" &&
    (event.stream === "command" || event.stream === "stderr")
  );
}

function extractCommandText(event) {
  if (!isCommandStartNotice(event)) {
    return "";
  }

  return event.content.replace("Running command: ", "");
}

function describeCommandTiming(group) {
  const durationSeconds = getCommandDurationSeconds(group);
  if (durationSeconds <= 0) {
    return null;
  }

  return {
    label: t(group.endEvent ? "command.elapsedLabel" : "command.runningForLabel", {
      value: formatDurationSeconds(durationSeconds),
    }),
    value: formatDurationSeconds(durationSeconds),
    className: group.endEvent
      ? "command-group-pill-timing"
      : "command-group-pill-live",
  };
}

function describeCommandAttention(group) {
  const exitCode = getCommandExitCode(group.endEvent);
  if (exitCode && exitCode !== "0") {
    return {
      label: t("inspect.problemCommand"),
      pillClass: "command-group-pill-danger",
      cardClass: "command-group-danger",
    };
  }

  const durationSeconds = getCommandDurationSeconds(group);
  if (!group.endEvent && durationSeconds >= LONG_RUNNING_COMMAND_SECONDS) {
    return {
      label: t("inspect.longRunning"),
      pillClass: "command-group-pill-warning",
      cardClass: "command-group-running-long",
    };
  }

  if (durationSeconds >= SLOW_COMMAND_SECONDS) {
    return {
      label: t("inspect.slowCommand"),
      pillClass: "command-group-pill-warning",
      cardClass: "command-group-slow",
    };
  }

  return null;
}

function describeCommandPreview(group) {
  const outputEvents = group.events.filter(isCommandOutputEvent);
  const hasStderr = outputEvents.some((event) => event.stream === "stderr");
  const lines = outputEvents.flatMap((event) => getCommandPreviewLines(event));
  const keyword = normalizeSearchKeyword(state.detail.search);

  if (lines.length === 0) {
    return {
      text: group.endEvent ? t("inspect.commandCompletedNoOutput") : t("generic.noOutputYet"),
      hiddenLineCount: 0,
      hasStderr: false,
      empty: true,
      focusedBySearch: false,
    };
  }

  if (keyword) {
    const focusedPreview = buildSearchFocusedPreview(lines, keyword);
    if (focusedPreview) {
      return {
        ...focusedPreview,
        hasStderr,
        empty: false,
        focusedBySearch: true,
      };
    }
  }

  if (lines.length <= COMMAND_PREVIEW_HEAD_LINES + COMMAND_PREVIEW_TAIL_LINES) {
    return {
      text: lines.join("\n"),
      hiddenLineCount: 0,
      hasStderr,
      empty: false,
      focusedBySearch: false,
    };
  }

  const hiddenLineCount = lines.length - COMMAND_PREVIEW_HEAD_LINES - COMMAND_PREVIEW_TAIL_LINES;
  return {
    text: [
      ...lines.slice(0, COMMAND_PREVIEW_HEAD_LINES),
      "…",
      ...lines.slice(-COMMAND_PREVIEW_TAIL_LINES),
    ].join("\n"),
    hiddenLineCount,
    hasStderr,
    empty: false,
    focusedBySearch: false,
  };
}

function getCommandOutputLines(group) {
  return group.events
    .filter(isCommandOutputEvent)
    .flatMap((event) => getCommandPreviewLines(event))
    .map((line) => String(line || "").replace(/\r/g, ""))
    .filter((line) => line.trim());
}

function getTailLines(lines, count) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }
  return lines.slice(-Math.max(1, count));
}

function getFirstMeaningfulPreviewLine(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && line !== "…");
}

function describeCommandPresentation(group, preview = describeCommandPreview(group)) {
  const lines = getCommandOutputLines(group);
  const exitCode = getCommandExitCode(group.endEvent);
  const isRunning = !group.endEvent;
  const isError = Boolean(exitCode && exitCode !== "0");
  const hasOutput = lines.length > 0;

  const previewLines = isRunning
    ? getTailLines(lines, COMMAND_RUNNING_PREVIEW_LINES)
    : [];

  let collapsedSummary = "";
  let detailSummary = "";

  if (isRunning) {
    const lastLine = getTailLines(lines, 1)[0];
    collapsedSummary = lastLine
      ? shortenText(lastLine.replace(/^\[stderr\]\s*/, ""), COMMAND_COLLAPSED_SUMMARY_MAX)
      : t("command.summary.running");
    detailSummary = collapsedSummary;
  } else if (preview && !preview.empty) {
    const firstLine = getFirstMeaningfulPreviewLine(preview.text);
    if (firstLine) {
      collapsedSummary = shortenText(
        firstLine.replace(/^\[stderr\]\s*/, ""),
        COMMAND_COLLAPSED_SUMMARY_MAX,
      );
      detailSummary = collapsedSummary;
    }
  }

  if (!collapsedSummary) {
    if (isError) {
      collapsedSummary = t("command.summary.failedExpand");
      detailSummary = collapsedSummary;
    } else if (group.stderrCount > 0) {
      collapsedSummary = t("command.summary.completedWithStderr");
      detailSummary = collapsedSummary;
    } else if (hasOutput) {
      collapsedSummary = t("command.summary.completedExpand");
      detailSummary = collapsedSummary;
    } else {
      collapsedSummary = group.endEvent ? t("inspect.noOutput") : t("inspect.noOutputYetShort");
      detailSummary = collapsedSummary;
    }
  }

  return {
    status: isRunning ? "running" : isError ? "error" : "success",
    previewLines,
    collapsedSummary,
    detailSummary,
  };
}

function getTaskStepDetailKey(taskKey, stepKey) {
  return `${taskKey}::${stepKey}`;
}

function isTaskStepExpanded(taskKey, stepKey, fallback = false) {
  const key = getTaskStepDetailKey(taskKey, stepKey);
  const explicitValue = state.detail.taskDetails[key];
  if (typeof explicitValue === "boolean") {
    return explicitValue;
  }
  return fallback;
}

function setTaskStepExpanded(taskKey, stepKey, expanded) {
  const key = getTaskStepDetailKey(taskKey, stepKey);
  state.detail.taskDetails[key] = Boolean(expanded);
}

function buildSearchFocusedPreview(lines, keyword) {
  const matchedIndexes = [];

  lines.forEach((line, index) => {
    if (String(line || "").toLowerCase().includes(keyword)) {
      matchedIndexes.push(index);
    }
  });

  if (matchedIndexes.length === 0) {
    return null;
  }

  const ranges = [
    expandPreviewRange(matchedIndexes[0], lines.length),
  ];
  const lastMatch = matchedIndexes[matchedIndexes.length - 1];
  if (lastMatch !== matchedIndexes[0]) {
    ranges.push(expandPreviewRange(lastMatch, lines.length));
  }

  const mergedRanges = mergePreviewRanges(ranges);
  const previewLines = [];
  let visibleLineCount = 0;
  let cursor = 0;

  mergedRanges.forEach((range) => {
    if (range.start > cursor) {
      previewLines.push("…");
    }

    previewLines.push(...lines.slice(range.start, range.end + 1));
    visibleLineCount += range.end - range.start + 1;
    cursor = range.end + 1;
  });

  if (cursor < lines.length) {
    previewLines.push("…");
  }

  return {
    text: previewLines.join("\n"),
    hiddenLineCount: Math.max(0, lines.length - visibleLineCount),
  };
}

function expandPreviewRange(index, totalLines) {
  return {
    start: Math.max(0, index - COMMAND_PREVIEW_MATCH_CONTEXT_LINES),
    end: Math.min(totalLines - 1, index + COMMAND_PREVIEW_MATCH_CONTEXT_LINES),
  };
}

function mergePreviewRanges(ranges) {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged = [sorted[0]];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = merged[merged.length - 1];

    if (current.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, current.end);
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function matchesEventOptions(event, options = {}) {
  return (
    matchesEventFilter(event, options.filter || "all") &&
    matchesEventSearch(event, options.search || "") &&
    matchesEventSeverity(event, options.severity || "all")
  );
}

function getCommandDurationSeconds(group) {
  const startTs = Number(group.startEvent?.ts || 0);
  const endTs = Number(group.endEvent?.ts || getLastTimedEventTs(group.events) || 0);

  if (!startTs || !endTs || endTs <= startTs) {
    return 0;
  }

  return endTs - startTs;
}

function getLastTimedEventTs(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const ts = Number(events[index]?.ts || 0);
    if (ts > 0) {
      return ts;
    }
  }

  return 0;
}

function getCommandPreviewLines(event) {
  const normalized = String(event.content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.map((line) => (event.stream === "stderr" ? `[stderr] ${line}` : line));
}

function formatDurationSeconds(durationSeconds) {
  const totalMs = Math.max(0, Math.round(Number(durationSeconds || 0) * 1000));

  if (totalMs < 1000) {
    return `${totalMs}ms`;
  }

  const totalSeconds = totalMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(totalSeconds >= 10 ? 0 : 1)}s`;
  }

  const roundedSeconds = Math.round(totalSeconds);
  if (roundedSeconds >= 3600) {
    const hours = Math.floor(roundedSeconds / 3600);
    const minutes = Math.floor((roundedSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatElapsedSinceIso(isoString) {
  const ts = Date.parse(String(isoString || ""));
  if (!Number.isFinite(ts)) {
    return "--";
  }

  return formatDurationSeconds(Math.max(0, (Date.now() - ts) / 1000));
}

function formatElapsedSinceUnixSeconds(unixSeconds) {
  const safeSeconds = Number(unixSeconds || 0);
  if (!Number.isFinite(safeSeconds) || safeSeconds <= 0) {
    return "--";
  }

  return formatDurationSeconds(Math.max(0, Date.now() / 1000 - safeSeconds));
}

function getCommandExitCode(endEvent) {
  const match = endEvent?.content?.match(/^Command completed \(([^)]+)\):/);
  return match?.[1] || "";
}

function getCommandRunStatusPresentation(group, exitCode) {
  if (!group.endEvent) {
    return { label: t("inspect.running"), pillClass: "command-status-live" };
  }

  if (exitCode && exitCode !== "0") {
    return { label: t("inspect.error"), pillClass: "command-status-error" };
  }

  return { label: t("inspect.completed"), pillClass: "command-status-done" };
}

function formatExitCodeForDisplay(endEvent, exitCode) {
  if (!endEvent) {
    return "—";
  }

  if (exitCode === "" || exitCode == null) {
    return "—";
  }

  return String(exitCode);
}

function shouldExpandCommandGroupByDefault(group) {
  if (!group.endEvent) {
    return true;
  }

  if (group.stderrCount > 0) {
    return true;
  }

  const exitCode = getCommandExitCode(group.endEvent);
  if (exitCode && exitCode !== "0") {
    return true;
  }

  return false;
}

function isCommandGroupExpanded(groupId, fallback) {
  const explicitValue = state.detail.commandGroups[groupId];
  if (typeof explicitValue === "boolean") {
    return explicitValue;
  }

  return fallback;
}

function getEventFilterOptions(counts) {
  return [
    { id: "all", label: t("inspect.filter.all"), count: counts.all },
    { id: "assistant", label: t("inspect.filter.assistant"), count: counts.assistant },
    { id: "command", label: t("inspect.filter.command"), count: counts.command },
    { id: "system", label: t("inspect.filter.system"), count: counts.system },
  ];
}

function getEventSeverityOptions(events) {
  return [
    { id: "all", label: t("inspect.severity.all"), count: events.length },
    {
      id: "error",
      label: t("inspect.error"),
      count: events.filter((event) => matchesEventSeverity(event, "error")).length,
    },
    {
      id: "warning",
      label: t("inspect.warning"),
      count: events.filter((event) => matchesEventSeverity(event, "warning")).length,
    },
    {
      id: "stderr",
      label: t("inspect.stderr"),
      count: events.filter((event) => matchesEventSeverity(event, "stderr")).length,
    },
  ];
}

function getEventCounts(events) {
  const counts = {
    all: events.length,
    assistant: 0,
    command: 0,
    system: 0,
  };

  events.forEach((event) => {
    if (matchesEventFilter(event, "assistant")) {
      counts.assistant += 1;
    }

    if (matchesEventFilter(event, "command")) {
      counts.command += 1;
    }

    if (matchesEventFilter(event, "system")) {
      counts.system += 1;
    }
  });

  return counts;
}

function summarizeSessionDetail(events) {
  const counts = getEventCounts(events);
  const lastAssistantEvent = [...events]
    .reverse()
    .find((event) => event.type === "cli.chunk" && event.stream === "assistant");
  const lastCommandNotice = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "system.notice" &&
        event.content &&
        event.content.startsWith("Running command:"),
    );

  return {
    totalEvents: counts.all,
    assistantEvents: counts.assistant,
    commandEvents: counts.command,
    systemEvents: counts.system,
    lastAssistantReply: lastAssistantEvent?.content || "",
    lastCommand: lastCommandNotice?.content
      ? lastCommandNotice.content.replace("Running command: ", "")
      : "",
  };
}

function getSessionStatusOptions(sessions) {
  const counts = new Map();
  sessions.forEach((session) => {
    counts.set(session.status, (counts.get(session.status) || 0) + 1);
  });

  const orderedStatuses = [
    "idle",
    "starting",
    "running",
    "waiting_input",
    "stopping",
    "completed",
    "failed",
  ];
  const presentStatuses = orderedStatuses.filter((status) => counts.has(status));

  return [
    { value: "all", label: t("sessions.statusAll", { count: sessions.length }) },
    ...presentStatuses.map((status) => ({
      value: status,
      label: `${sessionStatusLabel(status)} (${counts.get(status) || 0})`,
    })),
  ];
}

function getSessionProjectOptions(projects, sessions) {
  const counts = new Map();
  sessions.forEach((session) => {
    counts.set(session.projectId, (counts.get(session.projectId) || 0) + 1);
  });

  return [
    { value: "all", label: t("sessions.projectAll", { count: sessions.length }) },
    ...projects.map((project) => ({
      value: project.projectId,
      label: `${project.name} (${counts.get(project.projectId) || 0})`,
    })),
  ];
}

function getThreadFilterOptions(sessions) {
  const readyCount = sessions.filter((session) => Boolean(session.codexThreadId)).length;
  const missingCount = sessions.length - readyCount;

  return [
    { value: "all", label: t("sessions.threadAll"), count: sessions.length },
    { value: "ready", label: t("sessions.threadReadyFilter"), count: readyCount },
    { value: "missing", label: t("sessions.threadMissingFilter"), count: missingCount },
  ];
}

function getSessionSortOptions() {
  return [
    { value: "activity_desc", label: t("sessions.sort.activity_desc") },
    { value: "created_desc", label: t("sessions.sort.created_desc") },
    { value: "events_desc", label: t("sessions.sort.events_desc") },
    { value: "reply_desc", label: t("sessions.sort.reply_desc") },
  ];
}

function parseHashRoute(hash) {
  const normalized = hash || "#/sessions";
  const [path, query = ""] = normalized.split("?");
  return {
    path,
    query,
  };
}

function getCodexQuotaCacheKey(sessionId) {
  return `${CODEX_QUOTA_CACHE_PREFIX}${String(sessionId || "").trim()}`;
}

function readQuotaNumber(input) {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }

  if (typeof input === "string" && input.trim()) {
    const parsed = Number.parseFloat(input);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toQuotaRemainingPercent(input) {
  const usedPercent = readQuotaNumber(input);
  if (usedPercent == null) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function formatQuotaRemainTime(input) {
  const resetAt = readQuotaNumber(input);
  if (resetAt == null) {
    return null;
  }

  const diffSec = Math.max(0, Math.floor(resetAt - Date.now() / 1000));
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatQuotaResetDate(input) {
  const resetAt = readQuotaNumber(input);
  if (resetAt == null) {
    return null;
  }

  const date = new Date(resetAt * 1000);
  return new Intl.DateTimeFormat(getIntlLocale(), {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function normalizeCodexQuotaPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (
    payload.quota &&
    typeof payload.quota === "object" &&
    payload.quota.hour &&
    payload.quota.week
  ) {
    return payload;
  }

  const rateLimits =
    payload.rateLimits && typeof payload.rateLimits === "object" ? payload.rateLimits : {};
  const primary =
    rateLimits.primary && typeof rateLimits.primary === "object" ? rateLimits.primary : {};
  const secondary =
    rateLimits.secondary && typeof rateLimits.secondary === "object" ? rateLimits.secondary : {};

  if (!Object.keys(primary).length && !Object.keys(secondary).length) {
    return null;
  }

  return {
    quota: {
      hour: {
        percent: toQuotaRemainingPercent(primary.used_percent),
        remainTime: formatQuotaRemainTime(primary.resets_at),
      },
      week: {
        percent: toQuotaRemainingPercent(secondary.used_percent),
        resetDate: formatQuotaResetDate(secondary.resets_at),
      },
    },
  };
}

function hasVisibleCodexQuota(payload) {
  const quota = payload?.quota;
  if (!quota || typeof quota !== "object") {
    return false;
  }

  return (
    quotaValuePresent(quota?.hour?.percent) ||
    quotaValuePresent(quota?.hour?.remainTime) ||
    quotaValuePresent(quota?.week?.percent) ||
    quotaValuePresent(quota?.week?.resetDate)
  );
}

function quotaValuePresent(input) {
  if (typeof input === "number" && Number.isFinite(input)) {
    return true;
  }

  return typeof input === "string" && input.trim().length > 0;
}

function readCachedCodexQuota(sessionId) {
  const key = getCodexQuotaCacheKey(sessionId);
  if (!sessionId) {
    return null;
  }

  try {
    const raw = window.localStorage?.getItem(key);
    const normalized = raw ? normalizeCodexQuotaPayload(JSON.parse(raw)) : null;
    return normalized && hasVisibleCodexQuota(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function writeCachedCodexQuota(sessionId, payload) {
  const normalized = normalizeCodexQuotaPayload(payload);
  if (!sessionId || !normalized || !hasVisibleCodexQuota(normalized)) {
    return;
  }

  try {
    window.localStorage?.setItem(getCodexQuotaCacheKey(sessionId), JSON.stringify(normalized));
  } catch {
    /* ignore quota cache write errors */
  }
}

function setDetailCodexQuota(sessionId, payload) {
  const normalized = normalizeCodexQuotaPayload(payload);
  if (!normalized || !hasVisibleCodexQuota(normalized)) {
    return state.detail.codexQuota;
  }

  state.detail.codexQuota = normalized;
  if (sessionId) {
    writeCachedCodexQuota(sessionId, normalized);
  }
  return normalized;
}

function getSlashQueryFromDraft(value) {
  const text = String(value || "");
  if (!text.startsWith("/")) {
    return null;
  }

  if (/[\r\n]/.test(text)) {
    return null;
  }

  const normalized = text.trim();
  if (!normalized.startsWith("/")) {
    return null;
  }

  const body = normalized.slice(1);
  if (/\s/.test(body)) {
    return null;
  }

  return body.toLowerCase();
}

function getVisibleSlashCommands() {
  const query = String(state.detail.slashQuery || "").trim().toLowerCase();
  const items = Array.isArray(state.detail.slashCommands) ? state.detail.slashCommands : [];
  if (!query) {
    return items;
  }

  return items.filter((item) => {
    const haystack = [
      item.slash,
      item.title,
      item.description,
      item.hint || "",
      item.id,
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function clampSlashActiveIndex() {
  const visible = getVisibleSlashCommands();
  if (!visible.length) {
    state.detail.slashActiveIndex = 0;
    return;
  }

  if (state.detail.slashActiveIndex < 0) {
    state.detail.slashActiveIndex = 0;
    return;
  }

  if (state.detail.slashActiveIndex >= visible.length) {
    state.detail.slashActiveIndex = visible.length - 1;
  }
}

function patchComposerSlashMenu() {
  const slot = document.querySelector("#composer-slash-slot");
  if (!(slot instanceof HTMLElement)) {
    return;
  }

  slot.innerHTML = "";
}

function closeSlashMenu() {
  state.detail.slashMenuOpen = false;
  state.detail.slashQuery = "";
  state.detail.slashActiveIndex = 0;
  state.detail.slashCommandsLoading = false;
  patchComposerSlashMenu();
}

async function loadSlashCommands(sessionId, { force = false } = {}) {
  if (!sessionId) {
    return;
  }

  if (state.detail.slashCommandsLoading) {
    return;
  }

  if (!force && Array.isArray(state.detail.slashCommands) && state.detail.slashCommands.length > 0) {
    patchComposerSlashMenu();
    return;
  }

  state.detail.slashCommandsLoading = true;
  patchComposerSlashMenu();

  try {
    const payload = await getSessionSlashCommands(sessionId);
    state.detail.slashCommands = Array.isArray(payload?.items) ? payload.items : [];
  } catch (error) {
    state.detail.slashCommands = [];
    showToast(messageOf(error));
  } finally {
    state.detail.slashCommandsLoading = false;
    patchComposerSlashMenu();
  }
}

async function executeComposerSlashCommand(sessionId, command) {
  if (!sessionId || !command) {
    return;
  }

  if (!command.enabled) {
    showToast(command.hint || t("composer.slashUnavailable"));
    return;
  }

  if (state.detail.slashExecuting) {
    return;
  }

  state.detail.slashExecuting = true;

  try {
    const result = await executeSessionSlashCommand(sessionId, command.id);
    state.detail.draft = "";
    if (state.detail.session && command.id === "stop") {
      state.detail.session.status = "stopping";
      state.detail.session.liveBusy = true;
    }
    if (result?.data?.quota) {
      setDetailCodexQuota(sessionId, result.data.quota);
    }
    if (result?.data?.status) {
      state.detail.codexStatus = result.data.status;
    }
    closeSlashMenu();
    showToast(result?.message || t("composer.slashExecuted", { slash: command.slash }));

    if (result?.refreshDetail) {
      await renderSessionDetailPage(sessionId);
      return;
    }

    renderSessionDetail();
  } catch (error) {
    showToast(messageOf(error));
  } finally {
    state.detail.slashExecuting = false;
  }
}

function bindComposerSlashMenuControls() {
  document.querySelectorAll("[data-slash-command-id]").forEach((el) => {
    el.onclick = async () => {
      const commandId = el.getAttribute("data-slash-command-id");
      if (!commandId || !state.detail.session?.sessionId) {
        return;
      }

      const command = getVisibleSlashCommands().find((item) => item.id === commandId);
      if (!command) {
        return;
      }

      await executeComposerSlashCommand(state.detail.session.sessionId, command);
    };
  });
}

function hydrateSessionDetailViewState(query) {
  const nextView = loadSessionDetailViewState(query);
  state.detail = {
    ...state.detail,
    ...nextView,
  };
}

function hydrateSessionsViewState(query) {
  const nextView = loadSessionsViewState(query);
  state.sessions = {
    ...state.sessions,
    ...nextView,
  };
}

function loadSessionsViewState(query) {
  const hashState = query ? parseSessionsViewQuery(query) : null;
  if (hashState) {
    return normalizeSessionsViewState(hashState);
  }

  const storedState = readSessionsViewStateFromStorage();
  if (storedState) {
    return normalizeSessionsViewState(storedState);
  }

  return { ...DEFAULT_SESSIONS_VIEW };
}

function loadSessionDetailViewState(query) {
  const detailState = query ? parseSessionDetailViewQuery(query) : null;
  if (detailState) {
    return normalizeSessionDetailViewState(detailState);
  }

  return { ...DEFAULT_DETAIL_VIEW };
}

function parseSessionsViewQuery(query) {
  const params = new URLSearchParams(query);
  if ([...params.keys()].length === 0) {
    return null;
  }

  return {
    keyword: params.get("q") || "",
    status: params.get("status") || "all",
    projectId: params.get("project") || "all",
    thread: params.get("thread") || "all",
    sort: params.get("sort") || DEFAULT_SESSIONS_VIEW.sort,
    page: params.get("page") || DEFAULT_SESSIONS_VIEW.page,
  };
}

function parseSessionDetailViewQuery(query) {
  const params = new URLSearchParams(query);
  if ([...params.keys()].length === 0) {
    return null;
  }

  return {
    filter: params.get("filter") || DEFAULT_DETAIL_VIEW.filter,
    severity: params.get("level") || DEFAULT_DETAIL_VIEW.severity,
    search: params.get("q") || "",
    autoScroll: params.get("follow") || "1",
  };
}

function normalizeSessionsViewState(input) {
  return {
    keyword: String(input.keyword || ""),
    status: isAllowedSessionStatus(input.status) ? input.status : DEFAULT_SESSIONS_VIEW.status,
    projectId: String(input.projectId || DEFAULT_SESSIONS_VIEW.projectId),
    thread: isAllowedThreadFilter(input.thread) ? input.thread : DEFAULT_SESSIONS_VIEW.thread,
    sort: isAllowedSessionSort(input.sort) ? input.sort : DEFAULT_SESSIONS_VIEW.sort,
    page: normalizePage(input.page),
    pageSize: DEFAULT_SESSIONS_VIEW.pageSize,
  };
}

function normalizeSessionDetailViewState(input) {
  return {
    filter: isAllowedDetailFilter(input.filter) ? input.filter : DEFAULT_DETAIL_VIEW.filter,
    severity: isAllowedDetailSeverity(input.severity)
      ? input.severity
      : DEFAULT_DETAIL_VIEW.severity,
    search: String(input.search || ""),
    autoScroll: normalizeAutoScroll(input.autoScroll),
    rawStdoutBuckets:
      input.rawStdoutBuckets && typeof input.rawStdoutBuckets === "object"
        ? input.rawStdoutBuckets
        : {},
  };
}

function normalizePage(value) {
  const page = Number.parseInt(String(value || DEFAULT_SESSIONS_VIEW.page), 10);
  if (Number.isNaN(page) || page < 1) {
    return DEFAULT_SESSIONS_VIEW.page;
  }

  return page;
}

function normalizeAutoScroll(value) {
  if (value === false || value === "0" || value === 0 || value === "false") {
    return false;
  }

  return true;
}

function isAllowedSessionStatus(value) {
  return [
    "all",
    "idle",
    "starting",
    "running",
    "waiting_input",
    "stopping",
    "completed",
    "failed",
  ].includes(String(value || ""));
}

function isAllowedDetailFilter(value) {
  return ["all", "assistant", "command", "system"].includes(String(value || ""));
}

function isAllowedDetailSeverity(value) {
  return ["all", "error", "warning", "stderr"].includes(String(value || ""));
}

function isAllowedThreadFilter(value) {
  return ["all", "ready", "missing"].includes(String(value || ""));
}

function isAllowedSessionSort(value) {
  return getSessionSortOptions().some((option) => option.value === value);
}

function persistSessionsViewState() {
  const viewState = {
    keyword: state.sessions.keyword,
    status: state.sessions.status,
    projectId: state.sessions.projectId,
    thread: state.sessions.thread,
    sort: state.sessions.sort,
    page: state.sessions.page,
    pageSize: state.sessions.pageSize,
  };

  writeSessionsViewStateToStorage(viewState);
  syncSessionsHash(viewState);
}

function persistSessionDetailViewState(sessionId) {
  syncSessionDetailHash(
    sessionId,
    state.detail.filter,
    state.detail.severity,
    state.detail.search,
    state.detail.autoScroll,
  );
}

function writeSessionsViewStateToStorage(viewState) {
  try {
    window.localStorage?.setItem(SESSION_VIEW_STORAGE_KEY, JSON.stringify(viewState));
  } catch (_error) {
    // Ignore storage failures in restricted browsers.
  }
}

function readSessionsViewStateFromStorage() {
  try {
    const raw = window.localStorage?.getItem(SESSION_VIEW_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function syncSessionsHash(viewState) {
  if (!window.location.hash.startsWith("#/sessions")) {
    return;
  }

  const nextHash = buildSessionsHash(viewState);
  if (window.location.hash === nextHash) {
    return;
  }

  if (window.history && typeof window.history.replaceState === "function") {
    window.history.replaceState(null, "", nextHash);
    state.route = nextHash;
    return;
  }

  window.location.hash = nextHash;
}

function syncSessionDetailHash(sessionId, filter, severity, search, autoScroll) {
  if (!window.location.hash.startsWith(`#/sessions/${sessionId}`)) {
    return;
  }

  const nextHash = buildSessionDetailHash(sessionId, filter, severity, search, autoScroll);
  if (window.location.hash === nextHash) {
    return;
  }

  if (window.history && typeof window.history.replaceState === "function") {
    window.history.replaceState(null, "", nextHash);
    state.route = nextHash;
    return;
  }

  window.location.hash = nextHash;
}

function buildSessionsHash(viewState) {
  const params = new URLSearchParams();

  if (viewState.keyword.trim()) {
    params.set("q", viewState.keyword.trim());
  }

  if (viewState.status !== DEFAULT_SESSIONS_VIEW.status) {
    params.set("status", viewState.status);
  }

  if (viewState.projectId !== DEFAULT_SESSIONS_VIEW.projectId) {
    params.set("project", viewState.projectId);
  }

  if (viewState.thread !== DEFAULT_SESSIONS_VIEW.thread) {
    params.set("thread", viewState.thread);
  }

  if (viewState.sort !== DEFAULT_SESSIONS_VIEW.sort) {
    params.set("sort", viewState.sort);
  }

  if (viewState.page > DEFAULT_SESSIONS_VIEW.page) {
    params.set("page", String(viewState.page));
  }

  const query = params.toString();
  return query ? `#/sessions?${query}` : "#/sessions";
}

function buildSessionDetailHash(sessionId, filter, severity, search, autoScroll) {
  const params = new URLSearchParams();

  if (filter !== DEFAULT_DETAIL_VIEW.filter) {
    params.set("filter", filter);
  }

  if (severity !== DEFAULT_DETAIL_VIEW.severity) {
    params.set("level", severity);
  }

  if (String(search || "").trim()) {
    params.set("q", String(search || "").trim());
  }

  if (!autoScroll) {
    params.set("follow", "0");
  }

  const query = params.toString();
  return query ? `#/sessions/${sessionId}?${query}` : `#/sessions/${sessionId}`;
}

function matchesSessionFilters(session, project, filters) {
  if (filters.status !== "all" && session.status !== filters.status) {
    return false;
  }

  if (filters.projectId !== "all" && session.projectId !== filters.projectId) {
    return false;
  }

  if (filters.thread === "ready" && !session.codexThreadId) {
    return false;
  }

  if (filters.thread === "missing" && session.codexThreadId) {
    return false;
  }

  const keyword = filters.keyword.trim().toLowerCase();
  if (!keyword) {
    return true;
  }

  const haystacks = [
    session.title,
    session.projectId,
    project?.name,
    session.status,
    session.lastAssistantContent,
    session.lastCommand,
    session.codexThreadId,
  ];

  return haystacks.some((value) => String(value || "").toLowerCase().includes(keyword));
}

function countActiveSessionFilters(filters) {
  let count = 0;

  if (filters.keyword.trim()) {
    count += 1;
  }

  if (filters.status !== "all") {
    count += 1;
  }

  if (filters.projectId !== "all") {
    count += 1;
  }

  if (filters.thread !== "all") {
    count += 1;
  }

  return count;
}

function sortSessions(sessions, sort) {
  const items = [...sessions];

  items.sort((left, right) => {
    if (sort === "created_desc") {
      return compareTimes(right.createdAt, left.createdAt) || compareTitles(left, right);
    }

    if (sort === "events_desc") {
      return (
        Number(right.eventCount || 0) - Number(left.eventCount || 0) ||
        compareTimes(right.lastEventAt || right.updatedAt, left.lastEventAt || left.updatedAt) ||
        compareTitles(left, right)
      );
    }

    if (sort === "reply_desc") {
      return (
        Number(Boolean(right.lastAssistantContent)) - Number(Boolean(left.lastAssistantContent)) ||
        compareTimes(right.lastEventAt || right.updatedAt, left.lastEventAt || left.updatedAt) ||
        compareTitles(left, right)
      );
    }

    return (
      compareTimes(right.lastEventAt || right.updatedAt || right.createdAt, left.lastEventAt || left.updatedAt || left.createdAt) ||
      compareTitles(left, right)
    );
  });

  return items;
}

function getPageCount(totalItems, pageSize) {
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

function clampPage(page, totalPages) {
  return Math.min(Math.max(page, 1), totalPages);
}

function getVisiblePageNumbers(currentPage, totalPages) {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const start = Math.max(1, Math.min(currentPage - 2, totalPages - 4));
  return Array.from({ length: 5 }, (_, index) => start + index);
}

function compareTimes(left, right) {
  return toTimestamp(left) - toTimestamp(right);
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }

  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
}

function compareTitles(left, right) {
  return String(left.title || "").localeCompare(String(right.title || ""), getIntlLocale());
}

function matchesEventFilter(event, filter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "assistant") {
    return event.type === "cli.chunk" && event.stream === "assistant";
  }

  if (filter === "command") {
    if (event.type === "cli.chunk" && event.stream === "command") {
      return true;
    }

    if (
      event.type === "system.notice" &&
      event.content &&
      (event.content.startsWith("Running command:") ||
        event.content.startsWith("Command completed"))
    ) {
      return true;
    }

    return false;
  }

  if (filter === "system") {
    return (
      event.type === "session.status" ||
      event.type === "cli.exit" ||
      event.type === "system.notice"
    );
  }

  return true;
}

function matchesEventSeverity(event, severity) {
  if (severity === "all") {
    return true;
  }

  if (severity === "error") {
    return (
      (event.type === "system.notice" && event.level === "error") ||
      (event.type === "cli.chunk" && event.stream === "stderr")
    );
  }

  if (severity === "warning") {
    return event.type === "system.notice" && event.level === "warning";
  }

  if (severity === "stderr") {
    return event.type === "cli.chunk" && event.stream === "stderr";
  }

  return true;
}

function matchesEventSearch(event, search) {
  const keyword = normalizeSearchKeyword(search);
  if (!keyword) {
    return true;
  }

  const haystacks = getEventSearchTexts(event);
  return haystacks.some((value) => String(value || "").toLowerCase().includes(keyword));
}

function getEventSearchTexts(event) {
  if (event.type === "message.user") {
    return ["user", "message.user", event.content];
  }

  if (event.type === "cli.chunk") {
    return ["cli", "cli.chunk", event.stream, cliEventLabel(event.stream), event.content];
  }

  if (event.type === "cli.exit") {
    return ["exit", "cli.exit", `exitCode:${String(event.exitCode)}`];
  }

  if (event.type === "session.status") {
    return ["status", "session.status", event.status, sessionStatusLabel(event.status)];
  }

  if (event.type === "codex.quota") {
    return [];
  }

  return ["system", "system.notice", event.level, event.content];
}

function normalizeSearchKeyword(search) {
  return String(search || "").trim().toLowerCase();
}

function loadingCard(message) {
  return `
    <article class="panel">
      <div class="loading-state">${escapeHtml(message)}</div>
    </article>
  `;
}

function encodeCopyPayload(value) {
  return encodeURIComponent(String(value || ""));
}

function decodeCopyPayload(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (_error) {
    return String(value || "");
  }
}

function errorCard(message) {
  return `
    <article class="panel">
      <div class="error-state">${escapeHtml(message)}</div>
    </article>
  `;
}

function renderPendingApprovalBar(detailState) {
  const approval = detailState.pendingApproval;
  if (!approval) {
    return "";
  }

  const runtime = detailState.codexStatus?.runtime || null;
  const targetHint = approval.reason || approval.cwd || "";
  const commandPreview = approval.command
    ? `<code class="approval-banner-command">${escapeHtml(approval.command)}</code>`
    : "";
  const workspaceNote = approval.cwd
    ? `<span class="approval-banner-chip">${escapeHtml(approval.cwd)}</span>`
    : "";
  const canResolve = approval.resumable !== false;
  const approvalExplain = describeApprovalContext(approval, runtime);
  const restoreHint = !canResolve
    ? `<p class="approval-banner-meta approval-banner-meta--warning">${escapeHtml(t("approval.restoreHint"))}</p>`
    : "";
  const actionHtml = canResolve
    ? `
        <button type="button" class="secondary-button" data-approval-decision="decline">${escapeHtml(t("approval.deny"))}</button>
        <button type="button" class="secondary-button" data-approval-decision="accept">${escapeHtml(t("approval.allowOnce"))}</button>
        <button type="button" class="primary-button" data-approval-decision="acceptForSession">${escapeHtml(t("approval.allowForTurn"))}</button>
      `
    : `
        <button type="button" class="primary-button" data-approval-retry="true">${escapeHtml(t("approval.retryAction"))}</button>
      `;

  return `
    <section class="approval-banner" data-approval-id="${escapeHtml(approval.requestId)}" data-approval-resumable="${canResolve ? "true" : "false"}">
      <div class="approval-banner-copy">
        <div class="approval-banner-head">
          <p class="approval-banner-title">${escapeHtml(localizeApprovalTitle(approval.title))}</p>
          <span class="approval-banner-badge">${escapeHtml(canResolve ? t("approval.pending") : t("approval.restore"))}</span>
        </div>
        <p class="approval-banner-meta">${escapeHtml(t("approval.continueHint"))}</p>
        ${targetHint ? `<p class="approval-banner-meta approval-banner-meta--strong">${escapeHtml(targetHint)}</p>` : ""}
        ${
          approvalExplain
            ? `<p class="approval-banner-meta approval-banner-meta--strong">${escapeHtml(approvalExplain)}</p>`
            : ""
        }
        ${commandPreview}
        <div class="approval-banner-foot">
          ${workspaceNote}
          ${
            runtime?.sandboxMode
              ? `<span class="approval-banner-chip">Sandbox: ${escapeHtml(formatRuntimeValue(runtime.sandboxMode))}</span>`
              : ""
          }
          ${
            runtime?.approvalMode
              ? `<span class="approval-banner-chip">Approval: ${escapeHtml(formatRuntimeValue(runtime.approvalMode))}</span>`
              : ""
          }
        </div>
        ${restoreHint}
      </div>
      <div class="approval-banner-actions">
        ${actionHtml}
      </div>
    </section>
  `;
}

function bindPendingApprovalControls(sessionId) {
  const banner = document.querySelector("#session-approval-slot .approval-banner");
  if (!banner) {
    return;
  }

  const retryButton = banner.querySelector("[data-approval-retry]");
  if (retryButton instanceof HTMLButtonElement) {
    retryButton.onclick = async () => {
      const approval = state.detail.pendingApproval;
      const requestId = banner.getAttribute("data-approval-id");
      if (!approval || !requestId) {
        return;
      }

      const previousPendingApproval = { ...approval };
      const previousStatus = state.detail.session?.status || "waiting_input";
      const previousLiveBusy = Boolean(state.detail.session?.liveBusy);
      retryButton.disabled = true;
      banner.setAttribute("aria-busy", "true");
      state.detail.pendingApproval = null;
      if (state.detail.session?.sessionId === sessionId) {
        state.detail.session.status = "running";
        state.detail.session.liveBusy = true;
      }
      scheduleSessionDetailRender({ immediate: true });

      try {
        const codex = buildCodexLaunchPayload(
          state.detail.codexLaunch,
          state.detail.codexUiOptions,
        );
        const payload = codex ? { codex } : {};
        await retrySessionApproval(sessionId, requestId, payload);
        await resumeActiveSessionDetail("approval-retry");
      } catch (error) {
        if (isTerminalApprovalError(error)) {
          dismissApproval(sessionId, requestId);
          state.detail.pendingApproval = null;
          const refreshedSession = await getSession(sessionId).catch(() => null);
          if (refreshedSession && state.detail.session?.sessionId === sessionId) {
            state.detail.session = refreshedSession;
            updateSessionListItem(refreshedSession);
          } else if (state.detail.session?.sessionId === sessionId) {
            state.detail.session.status = previousStatus;
            state.detail.session.liveBusy = previousLiveBusy;
          }
          syncDetailPendingApproval(state.detail.session, state.detail.timelineState);
        } else {
          state.detail.pendingApproval = previousPendingApproval;
          if (state.detail.session?.sessionId === sessionId) {
            state.detail.session.status = previousStatus;
            state.detail.session.liveBusy = previousLiveBusy;
          }
        }
        scheduleSessionDetailRender({ immediate: true });
        showToast(messageOf(error));
      }
    };
  }

  if (banner.getAttribute("data-approval-resumable") === "false") {
    return;
  }

  banner.querySelectorAll("[data-approval-decision]").forEach((button) => {
    button.onclick = async () => {
      const decision = button.getAttribute("data-approval-decision");
      const requestId = banner.getAttribute("data-approval-id");
      if (!decision || !requestId) {
        return;
      }
      if (isApprovalSuppressed(sessionId, requestId, state.detail.pendingApproval?.callId)) {
        return;
      }

      const previousPendingApproval = state.detail.pendingApproval
        ? { ...state.detail.pendingApproval }
        : null;
      state.detail.resolvingApprovalRequestId = requestId;
      state.detail.resolvingApprovalSessionId = sessionId;
      state.detail.resolvingApprovalCallId = String(previousPendingApproval?.callId || "").trim();
      state.detail.pendingApproval = null;
      banner.setAttribute("aria-busy", "true");
      banner.setAttribute("data-pending-decision", decision);
      banner
        .querySelectorAll("[data-approval-decision]")
        .forEach((actionButton) => actionButton.setAttribute("disabled", "disabled"));
      scheduleSessionDetailRender({ immediate: true });
      try {
        await resolveSessionApproval(sessionId, requestId, decision);
        await catchUpSessionEvents(sessionId, state.detail.cursor || 0).catch(() => null);
        const refreshedSession = await getSession(sessionId).catch(() => null);
        if (refreshedSession && state.detail.session?.sessionId === sessionId) {
          state.detail.session = refreshedSession;
          updateSessionListItem(refreshedSession);
        }
        syncDetailPendingApproval(state.detail.session, state.detail.timelineState);
        scheduleSessionDetailRender({ immediate: true });
      } catch (error) {
        if (isApprovalSuppressed(sessionId, requestId, previousPendingApproval?.callId)) {
          clearResolvingApprovalState();
        }
        if (isTerminalApprovalError(error)) {
          dismissApproval(sessionId, requestId);
          state.detail.pendingApproval = null;
          const refreshedSession = await getSession(sessionId).catch(() => null);
          if (refreshedSession && state.detail.session?.sessionId === sessionId) {
            state.detail.session = refreshedSession;
            updateSessionListItem(refreshedSession);
          }
          syncDetailPendingApproval(state.detail.session, state.detail.timelineState);
        } else {
          state.detail.pendingApproval = previousPendingApproval;
        }
        showToast(messageOf(error));
        scheduleSessionDetailRender({ immediate: true });
      }
    };
  });
}

function describeApprovalContext(approval, runtime) {
  const command = typeof approval?.command === "string" ? approval.command : "";
  const targetPath = extractApprovalPath(command);
  const writableRoots = Array.isArray(runtime?.writableRoots) ? runtime.writableRoots : [];
  const workspaceRoot = typeof runtime?.workspaceRoot === "string" ? runtime.workspaceRoot : "";

  if (!targetPath) {
    return "";
  }

  if (writableRoots.some((root) => isPathInsideRoot(targetPath, root))) {
    return t("approval.pathInWritable", { targetPath });
  }

  if (workspaceRoot) {
    return t("approval.pathOutsideWorkspace", { targetPath, workspaceRoot });
  }

  return t("approval.pathOutsideWritable", { targetPath });
}

function extractApprovalPath(command) {
  const text = String(command || "");
  const match = text.match(/\/Users\/[^\s'"]+/);
  return match ? match[0] : "";
}

function isPathInsideRoot(targetPath, rootPath) {
  const target = String(targetPath || "").trim();
  const root = String(rootPath || "").trim();
  if (!target || !root) {
    return false;
  }

  return target === root || target.startsWith(`${root}/`);
}

function showToast(message) {
  const text = String(message || "").trim();
  if (!text) {
    return;
  }

  const now = Date.now();
  if (text === lastToastMessage && now - lastToastAt < 1500) {
    return;
  }

  lastToastMessage = text;
  lastToastAt = now;
  window.alert(text);
}

function isSessionBusy(status) {
  return ["starting", "running", "stopping"].includes(status);
}

function isSessionLiveBusy(session) {
  if (!session) {
    return false;
  }

  if (session.sourceKind === "imported_rollout") {
    return Boolean(session.liveBusy);
  }

  return isSessionBusy(session.status);
}

function getSessionDisplayStatus(session) {
  if (!session) {
    return "idle";
  }

  if (session.sourceKind === "imported_rollout" && !isSessionLiveBusy(session)) {
    return "waiting_input";
  }

  return session.status;
}

function getActiveTimelineTurn(session) {
  if (!session || !isSessionLiveBusy(session) || !state.detail.timelineState) {
    return null;
  }

  const timelineState = state.detail.timelineState;
  const activeTurnId = timelineState.activeTurnId;
  if (activeTurnId && timelineState.turnsById[activeTurnId]) {
    return timelineState.turnsById[activeTurnId];
  }

  for (let index = timelineState.turnOrder.length - 1; index >= 0; index -= 1) {
    const turnId = timelineState.turnOrder[index];
    const turn = timelineState.turnsById[turnId];
    if (turn?.status === "running" || turn?.status === "idle") {
      return turn;
    }
  }

  const lastTurnId = timelineState.turnOrder[timelineState.turnOrder.length - 1];
  if (lastTurnId && timelineState.turnsById[lastTurnId]) {
    return timelineState.turnsById[lastTurnId];
  }

  return null;
}

function getOptimisticActiveTurn(session) {
  const optimistic = state.detail.optimisticSend;
  if (!session || !isSessionLiveBusy(session) || !optimistic) {
    return null;
  }

  return {
    id: optimistic.turnId || optimistic.tempTurnId,
    startedAt: optimistic.createdAt,
  };
}

function getTurnStartedAtUnixSeconds(turn) {
  const startedAt = Date.parse(String(turn?.startedAt || ""));
  if (!Number.isFinite(startedAt)) {
    return 0;
  }

  return Math.floor(startedAt / 1000);
}

function getSessionActivityBadges(session, activeTurn) {
  if (!session) {
    return [];
  }
  if (session.sourceKind === "imported_rollout" && session.sourceRolloutHasOpenTurn) {
    return [{ label: t("session.externalRunning"), tone: "warm" }];
  }
  return [];
}

function statusClass(status) {
  if (status === "running" || status === "waiting_input") {
    return "pill-warm";
  }

  if (status === "failed") {
    return "pill-danger";
  }

  if (status === "completed") {
    return "pill-success";
  }

  return "pill-neutral";
}

function sessionStatusLabel(status) {
  if (status === "idle") {
    return t("session.status.idle");
  }

  if (status === "starting") {
    return t("session.status.starting");
  }

  if (status === "running") {
    return t("session.status.running");
  }

  if (status === "waiting_input") {
    return t("session.status.waiting_input");
  }

  if (status === "stopping") {
    return t("session.status.stopping");
  }

  if (status === "completed") {
    return t("session.status.completed");
  }

  if (status === "failed") {
    return t("session.status.failed");
  }

  return status || t("session.status.unknown");
}

function cliEventLabel(stream) {
  if (stream === "assistant") {
    return "assistant";
  }

  if (stream === "command") {
    return "command";
  }

  return stream || "stdout";
}

function formatTs(ts) {
  if (!ts) {
    return "unknown";
  }

  return new Date(ts * 1000).toLocaleString(getIntlLocale());
}

function shortenText(value, limit) {
  if (!value) {
    return "";
  }

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function disconnectConversationLayoutObserver() {
  state.detail.layoutScrollObserver?.disconnect();
  state.detail.layoutScrollObserver = null;
}

function scrollEventsToBottom() {
  if (!state.detail.autoScroll) {
    return;
  }

  const list = document.querySelector("#event-list");
  if (!list) {
    return;
  }

  list.scrollTop = list.scrollHeight;
  const last = list.lastElementChild;
  if (last) {
    last.scrollIntoView({ block: "end", inline: "nearest", behavior: "auto" });
  }
}

function getEventListBottomGap() {
  const list = document.querySelector("#event-list");
  if (!list) {
    return 0;
  }

  return Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight);
}

function shouldShowJumpToBottomButton() {
  if (state.detail.autoScroll) {
    return false;
  }

  const list = document.querySelector("#event-list");
  if (!list) {
    return state.detail.unseenCount > 0;
  }

  return state.detail.unseenCount > 0 || getEventListBottomGap() > list.clientHeight;
}

function resumeAutoScrollToBottom() {
  state.detail.autoScroll = true;
  state.detail.unseenCount = 0;
  scrollEventsToBottom();
  renderSessionDetail();
  window.requestAnimationFrame(() => {
    scrollEventsToBottom();
    scheduleInitialScrollToBottom();
  });
}

function scheduleAggressiveScrollToBottom() {
  if (!state.detail.autoScroll) {
    return;
  }

  const delaysMs = [0, 16, 32, 48, 100, 200, 400, 700, 1200];
  delaysMs.forEach((ms) => {
    window.setTimeout(() => scrollEventsToBottom(), ms);
  });
}

function scheduleInitialScrollToBottom() {
  if (!state.detail.autoScroll) {
    return;
  }

  scrollEventsToBottom();
  window.requestAnimationFrame(() => scrollEventsToBottom());
}

function captureAutoScrollBottomOffset() {
  if (!state.detail.autoScroll) {
    return null;
  }

  const list = document.querySelector("#event-list");
  if (!list) {
    return null;
  }

  return Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight);
}

function restoreAutoScrollBottomOffset(offset) {
  if (offset == null || !state.detail.autoScroll) {
    return;
  }

  const list = document.querySelector("#event-list");
  if (!list) {
    return;
  }

  list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - offset);
}

function scheduleAutoScrollAnchorRestore() {
  if (!state.detail.autoScroll) {
    return;
  }

  window.requestAnimationFrame(() => {
    restoreAutoScrollBottomOffset(0);
  });
}

function attachConversationLayoutScrollObserver() {
  if (!state.detail.autoScroll || typeof ResizeObserver === "undefined") {
    return;
  }

  const panel = document.querySelector(".conversation-panel");
  if (!panel) {
    return;
  }

  let timeoutId = 0;
  const ro = new ResizeObserver(() => {
    if (!state.detail.autoScroll) {
      return;
    }

    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => restoreAutoScrollBottomOffset(0), 16);
  });

  ro.observe(panel);
  state.detail.layoutScrollObserver = ro;
}

function stepSearchMatch(direction) {
  const hits = getSearchMatchElements();
  if (hits.length === 0) {
    return;
  }

  const total = hits.length;
  state.detail.searchMatchIndex =
    (state.detail.searchMatchIndex + direction + total) % total;
  syncSearchMatchNavigation({ scrollIntoView: true });
}

function syncSearchMatchNavigation(options = {}) {
  const hits = getSearchMatchElements();
  const status = document.querySelector("#search-hit-status");
  const prevButton = document.querySelector("#search-hit-prev");
  const nextButton = document.querySelector("#search-hit-next");
  const total = hits.length;

  hits.forEach((hit) => hit.classList.remove("command-search-hit-active"));

  if (!state.detail.search.trim() || total === 0) {
    state.detail.searchMatchIndex = 0;
    if (status) {
      status.textContent = "0 / 0";
    }
    prevButton?.setAttribute("disabled", "disabled");
    nextButton?.setAttribute("disabled", "disabled");
    return;
  }

  state.detail.searchMatchIndex = Math.max(0, Math.min(state.detail.searchMatchIndex, total - 1));
  const activeHit = hits[state.detail.searchMatchIndex];
  activeHit?.classList.add("command-search-hit-active");

  if (status) {
    status.textContent = `${state.detail.searchMatchIndex + 1} / ${total}`;
  }

  prevButton?.removeAttribute("disabled");
  nextButton?.removeAttribute("disabled");

  if (options.scrollIntoView && activeHit) {
    activeHit.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }
}

function getSearchMatchElements() {
  return Array.from(document.querySelectorAll("#event-list .command-search-hit"));
}

function captureEventListScrollTop() {
  if (state.detail.autoScroll) {
    return null;
  }

  const list = document.querySelector("#event-list");
  return list ? list.scrollTop : null;
}

function restoreEventListScrollTop(scrollTop) {
  if (scrollTop == null || state.detail.autoScroll) {
    return;
  }

  const list = document.querySelector("#event-list");
  if (list) {
    list.scrollTop = scrollTop;
  }
}

function bindEventListAutoPause(sessionId) {
  const list = document.querySelector("#event-list");
  if (!list) {
    return;
  }

  list.addEventListener("scroll", () => {
    if (isEventListNearTop(list)) {
      void maybeLoadOlderSessionEvents(sessionId, list);
    }

    const nearBottom = isEventListNearBottom(list);

    if (state.detail.autoScroll && nearBottom) {
      return;
    }

    if (state.detail.autoScroll) {
      state.detail.autoScroll = false;
      state.detail.unseenCount = 0;
      persistSessionDetailViewState(sessionId);
      renderSessionDetail();
      return;
    }

    if (!nearBottom) {
      return;
    }

    state.detail.autoScroll = true;
    state.detail.unseenCount = 0;
    persistSessionDetailViewState(sessionId);
    renderSessionDetail();
  });
}

function isEventListNearBottom(list) {
  return list.scrollHeight - list.scrollTop - list.clientHeight <= 24;
}

function isEventListNearTop(list) {
  return list.scrollTop <= 48;
}

async function maybeLoadOlderSessionEvents(sessionId, list) {
  if (
    state.detail.historyLoading ||
    !state.detail.historyHasMore ||
    !state.detail.beforeCursor ||
    state.detail.beforeCursor <= 1
  ) {
    return;
  }

  state.detail.historyLoading = true;
  const previousScrollTop = list.scrollTop;
  const previousScrollHeight = list.scrollHeight;

  try {
    const payload = await getSessionTimelineEvents(sessionId, {
      before: state.detail.beforeCursor,
      limit: 200,
    });

    if (payload.items.length === 0) {
      state.detail.historyHasMore = false;
      state.detail.historyLoading = false;
      return;
    }

    mergeDetailTimelineRawEvents(payload.items);
    state.detail.beforeCursor = payload.beforeCursor || state.detail.beforeCursor;
    state.detail.historyHasMore = Boolean(payload.hasMoreBefore);
    state.detail.historyLoading = false;
    renderSessionDetail();

    window.requestAnimationFrame(() => {
      const nextList = document.querySelector("#event-list");
      if (!nextList) {
        return;
      }

      const scrollDelta = nextList.scrollHeight - previousScrollHeight;
      nextList.scrollTop = previousScrollTop + scrollDelta;
    });
  } catch (error) {
    state.detail.historyLoading = false;
    showToast(messageOf(error));
  }
}

function bindCopyButtons() {
  document.querySelectorAll("[data-copy-text]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const encoded = button.getAttribute("data-copy-text") || "";
      const copied = await writeClipboardText(decodeCopyPayload(encoded));
      if (!copied) {
        showToast(t("inspect.copyFailed"));
        return;
      }

      flashCopySuccess(button);
    });
  });
}

async function writeClipboardText(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_error) {
    // Fallback below.
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "readonly");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();

  try {
    return document.execCommand("copy");
  } catch (_error) {
    return false;
  } finally {
    input.remove();
  }
}

function flashCopySuccess(button) {
  const original = button.textContent;
  button.textContent = t("inspect.copied");
  button.classList.add("event-copy-button-copied");

  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove("event-copy-button-copied");
  }, 1200);
}

function cleanupSocket() {
  state.ws?.close();
  state.ws = null;
  state.socketState = "closed";
}

function cleanupDetailClock() {
  if (state.detail.liveClockId) {
    window.clearInterval(state.detail.liveClockId);
    state.detail.liveClockId = 0;
  }
}

function cleanupLiveResumeSync() {
  if (state.detail.liveResumeTimerId) {
    window.clearTimeout(state.detail.liveResumeTimerId);
    state.detail.liveResumeTimerId = 0;
  }
}

function cleanupImportedSessionSync() {
  if (state.detail.importedSyncTimerId) {
    window.clearTimeout(state.detail.importedSyncTimerId);
    state.detail.importedSyncTimerId = 0;
  }
}

async function resumeActiveSessionDetail(reason = "resume") {
  const sessionId = state.detail.session?.sessionId || state.workspace.activeSessionId || "";
  if (!sessionId || state.detail.resumeSyncInFlight) {
    return;
  }

  const now = Date.now();
  if (now - Number(state.detail.lastResumeSyncAt || 0) < 900) {
    return;
  }

  state.detail.resumeSyncInFlight = true;
  state.detail.lastResumeSyncAt = now;

  try {
    const shouldForceReconnect =
      reason === "visibility" || reason === "focus" || reason === "pageshow";

    if (shouldForceReconnect || state.socketState === "closed" || state.socketState === "error") {
      cleanupSocket();
      state.socketState = "connecting";
      attachSessionSocket(sessionId);
    }

    if (state.detail.session?.sourceKind === "imported_rollout") {
      await syncImportedSession(sessionId).catch(() => null);
    }

    const refreshedSession = await getSession(sessionId).catch(() => null);
    if (refreshedSession && state.detail.session?.sessionId === sessionId) {
      state.detail.session = refreshedSession;
      syncDetailPendingApproval(refreshedSession, state.detail.timelineState);
      updateSessionListItem(refreshedSession);
    }

    await catchUpSessionEvents(sessionId, state.detail.cursor || 0).catch(() => null);

    if (state.detail.session?.sessionId === sessionId) {
      scheduleSessionDetailRender();
      scheduleImportedSessionSync(sessionId, 1000);
    }
  } finally {
    state.detail.resumeSyncInFlight = false;
  }
}

function shouldAutoSyncImportedSession(session) {
  return Boolean(
    session &&
      session.sourceKind === "imported_rollout" &&
      session.sourceRolloutHasOpenTurn === true &&
      !isSessionLiveBusy(session),
  );
}

function scheduleLiveResumeSync(sessionId, delayMs = 3200) {
  cleanupLiveResumeSync();
  const session = state.detail.session;
  if (!session || session.sessionId !== sessionId || !isSessionLiveBusy(session)) {
    return;
  }

  state.detail.liveResumeTimerId = window.setTimeout(async () => {
    state.detail.liveResumeTimerId = 0;

    if (!state.detail.session || state.detail.session.sessionId !== sessionId || !isSessionLiveBusy(state.detail.session)) {
      return;
    }

    try {
      await resumeActiveSessionDetail("live-heartbeat");
    } finally {
      if (
        state.detail.session &&
        state.detail.session.sessionId === sessionId &&
        isSessionLiveBusy(state.detail.session)
      ) {
        scheduleLiveResumeSync(sessionId, 3200);
      }
    }
  }, delayMs);
}

function updateSessionListItem(session) {
  if (!session?.sessionId) {
    return;
  }

  state.sessions.items = state.sessions.items.map((item) =>
    item.sessionId === session.sessionId
      ? {
          ...item,
          title: session.title,
          status: session.status,
          liveBusy: session.liveBusy,
          codexThreadId: session.codexThreadId,
          sourceKind: session.sourceKind,
          sourceRolloutPath: session.sourceRolloutPath,
          sourceThreadId: session.sourceThreadId,
          sourceRolloutHasOpenTurn: session.sourceRolloutHasOpenTurn,
          updatedAt: session.updatedAt,
        }
      : item,
  );
}

function scheduleImportedSessionSync(sessionId, delayMs = 1200) {
  cleanupImportedSessionSync();
  const session = state.detail.session;
  if (!session || session.sessionId !== sessionId || !shouldAutoSyncImportedSession(session)) {
    return;
  }

  state.detail.importedSyncTimerId = window.setTimeout(async () => {
    state.detail.importedSyncTimerId = 0;

    if (!state.detail.session || state.detail.session.sessionId !== sessionId) {
      return;
    }

    try {
      const result = await syncImportedSession(sessionId);
      if (!state.detail.session || state.detail.session.sessionId !== sessionId) {
        return;
      }

      if (result?.appendedEvents > 0) {
        await catchUpSessionEvents(sessionId, state.detail.cursor);
      }

      if (result?.appendedEvents > 0 || result?.synced) {
        const refreshedSession = await getSession(sessionId).catch(() => null);
        if (refreshedSession && state.detail.session?.sessionId === sessionId) {
          state.detail.session = refreshedSession;
          syncDetailPendingApproval(refreshedSession, state.detail.timelineState);
          updateSessionListItem(refreshedSession);
        }
      }

      scheduleSessionDetailRender();
      scheduleImportedSessionSync(sessionId, 1600);
    } catch {
      scheduleImportedSessionSync(sessionId, 2400);
    }
  }, delayMs);
}

function ensureDetailClock() {
  cleanupDetailClock();
  syncDetailClockLabels();
  if (!state.detail.session) {
    return;
  }

  state.detail.liveClockId = window.setInterval(() => {
    syncDetailClockLabels();
  }, 1000);
}

function syncDetailClockLabels() {
  const session = state.detail.session;
  if (!session) {
    return;
  }

  const sessionElapsedEl = document.querySelector("#session-elapsed-chip");
  if (sessionElapsedEl) {
    sessionElapsedEl.textContent = t("session.elapsed", {
      value: formatElapsedSinceIso(session.createdAt),
    });
  }

  const activeElapsedEl = document.querySelector("#session-active-elapsed-chip");
  if (activeElapsedEl && state.detail.activeTaskStartedAt > 0) {
    activeElapsedEl.textContent = t("session.turnElapsed", {
      value: formatElapsedSinceUnixSeconds(state.detail.activeTaskStartedAt),
    });
  }

  document.querySelectorAll("[data-active-elapsed='true']").forEach((element) => {
    if (!(element instanceof HTMLElement) || state.detail.activeTaskStartedAt <= 0) {
      return;
    }
    element.textContent = formatElapsedSinceUnixSeconds(state.detail.activeTaskStartedAt);
  });

  const mobileActiveElapsedEl = document.querySelector("#session-mobile-active-elapsed");
  if (mobileActiveElapsedEl && state.detail.activeTaskStartedAt > 0) {
    mobileActiveElapsedEl.textContent = formatElapsedSinceUnixSeconds(
      state.detail.activeTaskStartedAt,
    );
  }
}

function renderSearchHighlight(value, search) {
  const text = String(value || "");
  const keyword = normalizeSearchKeyword(search);
  if (!keyword) {
    return escapeHtml(text);
  }

  const lowerText = text.toLowerCase();
  let cursor = 0;
  let html = "";

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(keyword, cursor);
    if (matchIndex === -1) {
      html += escapeHtml(text.slice(cursor));
      break;
    }

    html += escapeHtml(text.slice(cursor, matchIndex));
    html += `<mark class="command-search-hit">${escapeHtml(
      text.slice(matchIndex, matchIndex + keyword.length),
    )}</mark>`;
    cursor = matchIndex + keyword.length;
  }

  return html;
}

function jumpToSearchResult(result) {
  if (!result.key || !result.targetId) {
    return;
  }

  state.detail.activeSearchResultKey = result.key;
  openInspectDrawer(result.key);
  renderSessionDetail();
  window.setTimeout(() => {
    focusSearchTarget(result.targetId);
  }, 0);
}

function focusSearchTarget(targetId) {
  const target = document.querySelector(`#${targetId}`);
  if (!target) {
    return;
  }

  target.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });
}

function getCommandGroupElementId(groupId) {
  return `command-group-${sanitizeDomIdSegment(groupId || "unknown")}`;
}

function getEventElementId(eventId) {
  return `event-${sanitizeDomIdSegment(eventId || "unknown")}`;
}

function getUserBubbleElementId(eventId) {
  return `user-msg-${sanitizeDomIdSegment(eventId || "unknown")}`;
}

function getAssistantBubbleElementId(stableId) {
  return `assistant-msg-${sanitizeDomIdSegment(stableId || "unknown")}`;
}

function getRawStdoutElementId(bucketId) {
  return `raw-out-${sanitizeDomIdSegment(bucketId || "unknown")}`;
}

function getOrphanStderrElementId(bucketId) {
  return `orphan-err-${sanitizeDomIdSegment(bucketId || "unknown")}`;
}

function sanitizeDomIdSegment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function searchResultKindLabel(event) {
  if (event.type === "message.user") {
    return t("timeline.userMessage");
  }

  if (event.type === "cli.chunk") {
    return cliEventLabel(event.stream);
  }

  if (event.type === "cli.exit") {
    return t("inspect.processExit");
  }

  if (event.type === "session.status") {
    return t("inspect.statusChange");
  }

  if (event.level === "error") {
    return "Error";
  }

  if (event.level === "warning") {
    return t("inspect.warning");
  }

  return t("inspect.filter.system");
}

function describeSearchResultTitle(event) {
  if (event.type === "cli.exit") {
    return `exitCode: ${String(event.exitCode)}`;
  }

  if (event.type === "session.status") {
    return event.status || "unknown";
  }

  if (event.content) {
    return event.content;
  }

  return searchResultKindLabel(event);
}

function describeSearchResultSnippet(event) {
  if (!event) {
    return "";
  }

  if (event.type === "system.notice" && isCommandStartNotice(event)) {
    return extractCommandText(event);
  }

  return describeSearchResultTitle(event);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function messageOf(error) {
  return error instanceof Error ? error.message : "Unknown error";
}
