import { groupTimelineActivities } from "./session-command-activity.js";
import { t } from "./i18n/index.js";

const TURN_STATUS_PRIORITY = {
  idle: 0,
  running: 1,
  completed: 2,
  failed: 3,
  aborted: 4,
};

function createItemIndex() {
  return new Map();
}

function nextTurnFallbackId(event) {
  return event?.turnId || `turn:${event?.id || crypto.randomUUID?.() || Date.now()}`;
}

function nextApprovalFallbackId(event) {
  return event?.requestId || event?.callId || `approval:${event?.id || Date.now()}`;
}

function nextMessageFallbackId(event, prefix = "message") {
  return event?.messageId || `${prefix}:${event?.id || Date.now()}`;
}

function appendDeltaText(currentText, textDelta) {
  const delta = String(textDelta || "");
  if (!delta) {
    return currentText || "";
  }

  return `${currentText || ""}${delta}`;
}

function reduceLegacyAssistantMessage(state, event) {
  const messageId = nextMessageFallbackId(event, resolveAssistantItemType(event));
  reduceTimeline(state, {
    ...event,
    id: `${event.id}:start`,
    kind: "assistant_message_start",
    messageId,
    payload: { raw: event.payload?.raw || event.payload || {} },
  });
  reduceTimeline(state, {
    ...event,
    id: `${event.id}:delta`,
    kind: "assistant_message_delta",
    messageId,
    payload: {
      textDelta: event.payload?.text || "",
      raw: event.payload?.raw || event.payload || {},
    },
  });
  reduceTimeline(state, {
    ...event,
    id: `${event.id}:end`,
    kind: "assistant_message_end",
    messageId,
    payload: { raw: event.payload?.raw || event.payload || {} },
  });
}

function reduceLegacyReasoning(state, event) {
  const messageId = nextMessageFallbackId(event, "reasoning");
  const reasoningText =
    event.payload?.content || event.payload?.summary || event.payload?.text || "";
  reduceTimeline(state, {
    ...event,
    id: `${event.id}:start`,
    kind: "reasoning_start",
    messageId,
    payload: {
      summary: event.payload?.summary || "",
      raw: event.payload?.raw || event.payload || {},
    },
  });
  reduceTimeline(state, {
    ...event,
    id: `${event.id}:delta`,
    kind: "reasoning_delta",
    messageId,
    payload: {
      textDelta: reasoningText,
      summary: event.payload?.summary || "",
      raw: event.payload?.raw || event.payload || {},
    },
  });
  reduceTimeline(state, {
    ...event,
    id: `${event.id}:end`,
    kind: "reasoning_end",
    messageId,
    payload: { raw: event.payload?.raw || event.payload || {} },
  });
}

function resolveTurnId(state, event) {
  if (event.turnId) {
    return event.turnId;
  }

  if (event.kind === "user_message") {
    return nextTurnFallbackId(event);
  }

  return state.activeTurnId || state.turnOrder[state.turnOrder.length - 1] || nextTurnFallbackId(event);
}

function ensureTurn(state, turnId, seed = {}) {
  if (!state.turnsById[turnId]) {
    state.turnsById[turnId] = {
      id: turnId,
      status: "idle",
      startedAt: seed.timestamp || null,
      completedAt: null,
      userMessageId: null,
      lastCommentaryId: null,
      finalMessageId: null,
      reasoningId: null,
      messageIds: [],
      commandIds: [],
      patchIds: [],
      approvalIds: [],
      systemIds: [],
      tokenCountId: null,
    };
    state.turnOrder.push(turnId);
  }

  return state.turnsById[turnId];
}

function setTurnStatus(turn, nextStatus) {
  const current = turn.status || "idle";
  if ((TURN_STATUS_PRIORITY[nextStatus] || 0) >= (TURN_STATUS_PRIORITY[current] || 0)) {
    turn.status = nextStatus;
  }
}

function insertTimelineItem(state, item) {
  const existingIndex = state.itemIndexById.get(item.id);
  if (typeof existingIndex === "number") {
    state.timelineItems[existingIndex] = {
      ...state.timelineItems[existingIndex],
      ...item,
    };
    return state.timelineItems[existingIndex];
  }

  const nextItem = { ...item };
  let insertAt = state.timelineItems.findIndex((candidate) => candidate.seq > nextItem.seq);
  if (insertAt === -1) {
    insertAt = state.timelineItems.length;
  }

  state.timelineItems.splice(insertAt, 0, nextItem);
  state.itemIndexById = createItemIndex();
  state.timelineItems.forEach((candidate, index) => {
    state.itemIndexById.set(candidate.id, index);
  });
  return nextItem;
}

function upsertUserMessage(state, event, turnId) {
  const turn = ensureTurn(state, turnId, event);
  const item = insertTimelineItem(state, {
    id: `user:${turnId}`,
    type: "user",
    turnId,
    seq: event.seq,
    timestamp: event.timestamp,
    role: "user",
    text: event.payload?.text || "",
  });
  turn.userMessageId = item.id;
  state.activeTurnId = turnId;
}

function resolveAssistantItemType(event) {
  return event.phase === "commentary" ? "assistant_commentary" : "assistant_final";
}

function upsertAssistantMessage(state, event, turnId, partial = {}) {
  const turn = ensureTurn(state, turnId, event);
  const phase = resolveAssistantItemType(event);
  const messageId = nextMessageFallbackId(event, phase);
  const itemId = `${phase}:${messageId}`;
  const current = state.messagesById[messageId] || {
    id: itemId,
    type: phase,
    turnId,
    messageId,
    seq: event.seq,
    timestamp: event.timestamp,
    role: "assistant",
    phase: event.phase || "final_answer",
    status: "streaming",
    text: "",
  };
  const item = insertTimelineItem(state, {
    ...current,
    ...partial,
    id: current.id,
    type: current.type,
    turnId,
    messageId,
    seq: current.seq || event.seq,
    timestamp: current.timestamp || event.timestamp,
    role: "assistant",
    phase: event.phase || current.phase || "final_answer",
  });
  state.messagesById[messageId] = item;
  if (!turn.messageIds.includes(item.id)) {
    turn.messageIds.push(item.id);
  }

  if (phase === "assistant_commentary") {
    turn.lastCommentaryId = item.id;
  } else {
    turn.finalMessageId = item.id;
  }

  return item;
}

function upsertReasoning(state, event, turnId, partial = {}) {
  const turn = ensureTurn(state, turnId, event);
  const messageId = nextMessageFallbackId(event, "reasoning");
  const current = state.reasoningById[messageId] || {
    id: `reasoning:${messageId}`,
    type: "reasoning",
    turnId,
    messageId,
    seq: event.seq,
    timestamp: event.timestamp,
    status: "thinking",
    summary: "",
    text: "",
  };
  const item = insertTimelineItem(state, {
    ...current,
    ...partial,
    id: current.id,
    type: "reasoning",
    turnId,
    messageId,
    seq: current.seq || event.seq,
    timestamp: current.timestamp || event.timestamp,
  });
  state.reasoningById[messageId] = item;
  turn.reasoningId = item.id;
  return item;
}

function completeReasoningIfPresent(state, turn) {
  if (!turn?.reasoningId) {
    return;
  }

  insertTimelineItem(state, {
    id: turn.reasoningId,
    status: "done",
  });
}

function upsertCommand(state, event, turnId, partial) {
  const turn = ensureTurn(state, turnId, event);
  const callId = event.callId || `command:${event.id}`;
  const current = state.commandsByCallId[callId] || {
    id: `command:${callId}`,
    type: "command",
    turnId,
    callId,
    seq: event.seq,
    timestamp: event.timestamp,
    status: "pending",
    command: "",
    cwd: null,
    stdout: "",
    stderr: "",
    output: "",
    outputStatus: "idle",
    exitCode: null,
    duration: null,
    justification: null,
    sandboxPermissions: null,
  };

  const next = {
    ...current,
    ...partial,
    id: current.id,
    type: "command",
    turnId,
    callId,
    seq: current.seq || event.seq,
    timestamp: current.timestamp || event.timestamp,
  };

  state.commandsByCallId[callId] = next;
  insertTimelineItem(state, next);
  if (!turn.commandIds.includes(next.id)) {
    turn.commandIds.push(next.id);
  }
  return next;
}

function upsertPatch(state, event, turnId, partial) {
  const turn = ensureTurn(state, turnId, event);
  const callId = event.callId || `patch:${event.id}`;
  const current = state.patchesByCallId[callId] || {
    id: `patch:${callId}`,
    type: "patch",
    turnId,
    callId,
    seq: event.seq,
    timestamp: event.timestamp,
    status: "pending",
    patchText: "",
    stdout: "",
    stderr: "",
    output: "",
    outputStatus: "idle",
    changes: {},
    success: null,
  };

  const next = {
    ...current,
    ...partial,
    id: current.id,
    type: "patch",
    turnId,
    callId,
    seq: current.seq || event.seq,
    timestamp: current.timestamp || event.timestamp,
  };

  state.patchesByCallId[callId] = next;
  insertTimelineItem(state, next);
  if (!turn.patchIds.includes(next.id)) {
    turn.patchIds.push(next.id);
  }
  return next;
}

function upsertApproval(state, event, turnId, partial) {
  const turn = ensureTurn(state, turnId, event);
  const requestId = nextApprovalFallbackId(event);
  const current = state.approvalsByRequestId[requestId] || {
    id: `approval:${requestId}`,
    type: "approval",
    turnId,
    requestId,
    seq: event.seq,
    timestamp: event.timestamp,
    status: "pending",
    title: "",
    reason: "",
    command: "",
  };

  const next = {
    ...current,
    ...partial,
    id: current.id,
    type: "approval",
    turnId,
    requestId,
    seq: current.seq || event.seq,
    timestamp: current.timestamp || event.timestamp,
  };

  state.approvalsByRequestId[requestId] = next;
  insertTimelineItem(state, next);
  if (!turn.approvalIds.includes(next.id)) {
    turn.approvalIds.push(next.id);
  }
  return next;
}

function upsertSystem(state, event, turnId, partial) {
  const turn = ensureTurn(state, turnId, event);
  const item = insertTimelineItem(state, {
    id: `system:${event.id}`,
    type: "system",
    turnId,
    seq: event.seq,
    timestamp: event.timestamp,
    ...partial,
  });
  if (!turn.systemIds.includes(item.id)) {
    turn.systemIds.push(item.id);
  }
  return item;
}

function upsertTokenCount(state, event, turnId) {
  const turn = ensureTurn(state, turnId, event);
  const item = insertTimelineItem(state, {
    id: `token:${turnId}`,
    type: "system",
    subtype: "token_count",
    turnId,
    seq: event.seq,
    timestamp: event.timestamp,
    payload: event.payload,
  });
  turn.tokenCountId = item.id;
  state.latestTokenCount = event.payload || null;
}

export function createEmptyTimelineState() {
  return {
    activeTurnId: null,
    turnsById: {},
    turnOrder: [],
    messagesById: {},
    reasoningById: {},
    commandsByCallId: {},
    patchesByCallId: {},
    approvalsByRequestId: {},
    timelineItems: [],
    itemIndexById: createItemIndex(),
    latestTokenCount: null,
  };
}

export function reduceTimeline(state, event) {
  if (!event) {
    return state;
  }

  const turnId = resolveTurnId(state, event);
  const turn = ensureTurn(state, turnId, event);

  switch (event.kind) {
    case "user_message":
      upsertUserMessage(state, event, turnId);
      setTurnStatus(turn, "idle");
      break;
    case "assistant_message_start":
      upsertAssistantMessage(state, event, turnId, {
        status: "streaming",
        text: event.payload?.text || "",
      });
      if (event.phase !== "commentary") {
        state.activeTurnId = turnId;
      }
      break;
    case "assistant_message_delta": {
      const existing = state.messagesById[nextMessageFallbackId(event, resolveAssistantItemType(event))];
      upsertAssistantMessage(state, event, turnId, {
        status: "streaming",
        text: appendDeltaText(existing?.text, event.payload?.textDelta),
      });
      break;
    }
    case "assistant_message_end":
      upsertAssistantMessage(state, event, turnId, {
        text:
          typeof event.payload?.text === "string" && event.payload.text !== ""
            ? event.payload.text
            : state.messagesById[nextMessageFallbackId(event, resolveAssistantItemType(event))]
                ?.text || "",
        status: "completed",
      });
      if (event.phase !== "commentary") {
        completeReasoningIfPresent(state, turn);
      }
      break;
    case "assistant_message":
      reduceLegacyAssistantMessage(state, event);
      break;
    case "reasoning_start":
      upsertReasoning(state, event, turnId, {
        status: "thinking",
        summary: event.payload?.summary || "",
        text: "",
      });
      setTurnStatus(turn, turn.status === "idle" ? "running" : turn.status);
      break;
    case "reasoning_delta": {
      const reasoningId = nextMessageFallbackId(event, "reasoning");
      const existing = state.reasoningById[reasoningId];
      const nextText = appendDeltaText(existing?.text, event.payload?.textDelta);
      upsertReasoning(state, event, turnId, {
        status: "thinking",
        text: nextText,
        summary: event.payload?.summary || nextText || existing?.summary || "",
      });
      setTurnStatus(turn, turn.status === "idle" ? "running" : turn.status);
      break;
    }
    case "reasoning_end":
      upsertReasoning(state, event, turnId, {
        status: "done",
        summary:
          event.payload?.summary ||
          state.reasoningById[nextMessageFallbackId(event, "reasoning")]?.summary ||
          "",
      });
      break;
    case "reasoning":
      reduceLegacyReasoning(state, event);
      break;
    case "command_start":
      upsertCommand(state, event, turnId, {
        status:
          event.payload?.sandboxPermissions === "require_escalated"
            ? "awaiting_approval"
            : "running",
        command: event.payload?.command || "",
        cwd: event.payload?.cwd || null,
        justification: event.payload?.justification || null,
        sandboxPermissions: event.payload?.sandboxPermissions || null,
      });
      setTurnStatus(turn, "running");
      state.activeTurnId = turnId;
      break;
    case "command_output_delta": {
      const commandId = event.callId || `command:${event.id}`;
      const currentCommand = state.commandsByCallId[commandId];
      const nextStdout =
        event.payload?.stream === "stderr"
          ? currentCommand?.stdout || ""
          : appendDeltaText(currentCommand?.stdout, event.payload?.textDelta);
      const nextStderr =
        event.payload?.stream === "stderr"
          ? appendDeltaText(currentCommand?.stderr, event.payload?.textDelta)
          : currentCommand?.stderr || "";
      upsertCommand(state, event, turnId, {
        status: currentCommand?.status === "awaiting_approval" ? "awaiting_approval" : "running",
        stdout: nextStdout,
        stderr: nextStderr,
        outputStatus: "streaming",
      });
      setTurnStatus(turn, "running");
      break;
    }
    case "command_end": {
      const rejected = Boolean(event.payload?.rejected);
      const completedStatus =
        event.payload?.status === "failed" || event.payload?.exitCode > 0
          ? "failed"
          : rejected
            ? "rejected"
            : "completed";
      upsertCommand(state, event, turnId, {
        status: completedStatus,
        command: event.payload?.command || state.commandsByCallId[event.callId]?.command || "",
        cwd: event.payload?.cwd || state.commandsByCallId[event.callId]?.cwd || null,
        stdout: event.payload?.stdout || state.commandsByCallId[event.callId]?.stdout || "",
        stderr: event.payload?.stderr || state.commandsByCallId[event.callId]?.stderr || "",
        output:
          event.payload?.aggregatedOutput ||
          event.payload?.formattedOutput ||
          event.payload?.output ||
          state.commandsByCallId[event.callId]?.output ||
          "",
        exitCode:
          event.payload?.exitCode ?? state.commandsByCallId[event.callId]?.exitCode ?? null,
        duration: event.payload?.duration || state.commandsByCallId[event.callId]?.duration || null,
        outputStatus: "done",
      });
      if (completedStatus === "failed") {
        setTurnStatus(turn, "failed");
      }
      break;
    }
    case "patch_start":
      upsertPatch(state, event, turnId, {
        status: "running",
        patchText: event.payload?.input || "",
      });
      setTurnStatus(turn, "running");
      state.activeTurnId = turnId;
      break;
    case "patch_output_delta": {
      const patchId = event.callId || `patch:${event.id}`;
      const currentPatch = state.patchesByCallId[patchId];
      upsertPatch(state, event, turnId, {
        status: currentPatch?.status || "running",
        output: appendDeltaText(currentPatch?.output, event.payload?.textDelta),
        outputStatus: "streaming",
      });
      setTurnStatus(turn, "running");
      break;
    }
    case "patch_end": {
      const patchStatus =
        event.payload?.status === "failed" || event.payload?.success === false
          ? "failed"
          : "completed";
      upsertPatch(state, event, turnId, {
        status: patchStatus,
        patchText:
          event.payload?.patchText || state.patchesByCallId[event.callId]?.patchText || "",
        output: event.payload?.output || state.patchesByCallId[event.callId]?.output || "",
        stdout: event.payload?.stdout || state.patchesByCallId[event.callId]?.stdout || "",
        stderr: event.payload?.stderr || state.patchesByCallId[event.callId]?.stderr || "",
        changes: event.payload?.changes || state.patchesByCallId[event.callId]?.changes || {},
        success:
          event.payload?.success ?? state.patchesByCallId[event.callId]?.success ?? null,
        outputStatus: "done",
      });
      if (patchStatus === "failed") {
        setTurnStatus(turn, "failed");
      }
      break;
    }
    case "approval_requested":
      upsertApproval(state, event, turnId, {
        status: "pending",
        title: event.payload?.title || t("approval.required"),
        reason: event.payload?.reason || "",
        command: event.payload?.command || "",
        resumable: event.payload?.resumable ?? true,
      });
      break;
    case "approval_resolved":
      upsertApproval(state, event, turnId, {
        status: event.payload?.decision === "decline" ? "rejected" : "resolved",
        decision: event.payload?.decision || null,
      });
      break;
    case "turn_started":
      setTurnStatus(turn, "running");
      state.activeTurnId = turnId;
      break;
    case "turn_completed":
      setTurnStatus(turn, "completed");
      turn.completedAt = event.timestamp;
      completeReasoningIfPresent(state, turn);
      if (state.activeTurnId === turnId) {
        state.activeTurnId = null;
      }
      break;
    case "turn_aborted":
      setTurnStatus(turn, "aborted");
      completeReasoningIfPresent(state, turn);
      upsertSystem(state, event, turnId, {
        subtype: "turn_aborted",
        text: event.payload?.reason || "Turn aborted",
        status: "aborted",
      });
      if (state.activeTurnId === turnId) {
        state.activeTurnId = null;
      }
      break;
    case "error":
      setTurnStatus(turn, "failed");
      completeReasoningIfPresent(state, turn);
      upsertSystem(state, event, turnId, {
        subtype: "error",
        text: event.payload?.message || "Unknown error",
        errorCode: event.payload?.code || null,
        status: "failed",
      });
      break;
    case "token_count":
      upsertTokenCount(state, event, turnId);
      break;
    default:
      break;
  }

  return state;
}

export function reduceTimelineBatch(state, events) {
  if (!Array.isArray(events)) {
    return state;
  }

  events.forEach((event) => {
    reduceTimeline(state, event);
  });
  return state;
}

export function buildTimelineView(state) {
  const items = state.timelineItems.filter(
    (item) => !(item.type === "system" && item.subtype === "token_count"),
  );
  const groupedItems = groupTimelineActivities(items);
  let activeTurn = null;
  if (state.activeTurnId && state.turnsById[state.activeTurnId]?.status === "running") {
    activeTurn = state.turnsById[state.activeTurnId];
  } else {
    for (let index = state.turnOrder.length - 1; index >= 0; index -= 1) {
      const turn = state.turnsById[state.turnOrder[index]];
      if (turn?.status === "running") {
        activeTurn = turn;
        break;
      }
    }
  }

  if (!activeTurn) {
    return groupedItems;
  }

  const lastTurnItem = [...groupedItems].reverse().find((item) => item.turnId === activeTurn.id) || null;
  const lastSeq = lastTurnItem?.seq ?? groupedItems[groupedItems.length - 1]?.seq ?? 0;
  const lastTimestamp =
    lastTurnItem?.timestamp ??
    activeTurn.startedAt ??
    groupedItems[groupedItems.length - 1]?.timestamp ??
    new Date().toISOString();

  return [
    ...groupedItems,
    {
      id: `thinking:${activeTurn.id}`,
      type: "reasoning",
      turnId: activeTurn.id,
      seq: lastSeq + 0.01,
      timestamp: lastTimestamp,
      status: "thinking",
      summary: t("timeline.thinking"),
      text: "",
      synthetic: true,
    },
  ];
}
