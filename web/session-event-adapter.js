function toIsoTimestamp(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeJsonParse(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeId(raw, fallbackPrefix = "raw") {
  if (raw?.id) {
    return String(raw.id);
  }

  const topType = String(raw?.type || "unknown");
  const payloadType = String(raw?.payload?.type || "unknown");
  const timestamp = String(raw?.timestamp || Date.now());
  return `${fallbackPrefix}:${topType}:${payloadType}:${timestamp}`;
}

function pickTurnId(payload) {
  return payload?.turn_id || payload?.turnId || null;
}

function pickCallId(payload) {
  return payload?.call_id || payload?.callId || null;
}

function pickRequestId(payload) {
  return payload?.request_id || payload?.requestId || null;
}

function pickMessageId(payload) {
  return payload?.message_id || payload?.messageId || payload?.id || null;
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeFunctionCallArguments(payload) {
  const parsed = safeJsonParse(payload?.arguments);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function normalizeFunctionCallOutput(payload) {
  const output = typeof payload?.output === "string" ? payload.output : "";
  const rejected = /Rejected\("rejected by user"\)/.test(output);

  return {
    output,
    rejected,
    raw: payload,
  };
}

function normalizeCustomToolOutput(payload) {
  const output = typeof payload?.output === "string" ? payload.output : "";
  const parsed = safeJsonParse(output);

  return {
    output,
    parsed,
    raw: payload,
  };
}

function normalizeExecCommandEnd(payload) {
  const command = Array.isArray(payload?.command)
    ? payload.command.join(" ")
    : typeof payload?.command === "string"
      ? payload.command
      : "";

  return {
    command,
    argv: Array.isArray(payload?.command) ? payload.command : [],
    cwd: payload?.cwd || null,
    stdout: payload?.stdout || "",
    stderr: payload?.stderr || "",
    aggregatedOutput: payload?.aggregated_output || "",
    formattedOutput: payload?.formatted_output || "",
    exitCode:
      typeof payload?.exit_code === "number"
        ? payload.exit_code
        : Number.isFinite(Number(payload?.exit_code))
          ? Number(payload.exit_code)
          : null,
    processId: payload?.process_id || null,
    status: payload?.status || null,
    duration: payload?.duration || null,
    parsedCommand: Array.isArray(payload?.parsed_cmd) ? payload.parsed_cmd : [],
    raw: payload,
  };
}

function normalizePatchEnd(payload) {
  return {
    stdout: payload?.stdout || "",
    stderr: payload?.stderr || "",
    success: typeof payload?.success === "boolean" ? payload.success : null,
    status: payload?.status || null,
    changes: payload?.changes && typeof payload.changes === "object" ? payload.changes : {},
    raw: payload,
  };
}

function normalizeTokenCount(payload) {
  return {
    info: payload?.info || null,
    rateLimits: payload?.rate_limits || null,
    raw: payload,
  };
}

function normalizeDirectSemanticPayload(topType, raw, payload) {
  if (topType === "message.user") {
    return {
      text:
        payload?.text ||
        raw?.text ||
        raw?.content ||
        normalizeMessageContent(payload?.content || raw?.content),
      raw,
    };
  }

  if (
    topType === "message.assistant.start" ||
    topType === "message.assistant.delta" ||
    topType === "message.assistant.end" ||
    topType === "message.assistant"
  ) {
    const isDelta = topType === "message.assistant.delta";
    return {
      text: isDelta
        ? undefined
        : payload?.text ||
          raw?.text ||
          raw?.content ||
          normalizeMessageContent(payload?.content || raw?.content),
      textDelta:
        payload?.textDelta ||
        payload?.text_delta ||
        raw?.textDelta ||
        raw?.text_delta ||
        payload?.delta ||
        raw?.delta ||
        payload?.text ||
        raw?.text ||
        payload?.content ||
        raw?.content ||
        "",
      raw,
    };
  }

  if (topType === "reasoning.start" || topType === "reasoning.delta" || topType === "reasoning.end" || topType === "reasoning") {
    const isDelta = topType === "reasoning.delta";
    return {
      summary: payload?.summary || raw?.summary || raw?.text || "",
      text: isDelta
        ? undefined
        : payload?.text ||
          raw?.text ||
          payload?.summary ||
          raw?.summary ||
          "",
      textDelta:
        payload?.textDelta ||
        payload?.text_delta ||
        raw?.textDelta ||
        raw?.text_delta ||
        payload?.delta ||
        raw?.delta ||
        payload?.summary ||
        raw?.summary ||
        payload?.text ||
        raw?.text ||
        "",
      raw,
    };
  }

  if (topType === "command.start") {
    return {
      command: payload?.command || raw?.command || "",
      cwd: payload?.cwd || raw?.cwd || null,
      justification: payload?.justification || raw?.justification || null,
      sandboxPermissions:
        payload?.sandboxPermissions || raw?.sandboxPermissions || raw?.sandbox_permissions || null,
      raw,
    };
  }

  if (topType === "command.end") {
    return {
      command: payload?.command || raw?.command || "",
      cwd: payload?.cwd || raw?.cwd || null,
      stdout: payload?.stdout || raw?.stdout || "",
      stderr: payload?.stderr || raw?.stderr || "",
      output: payload?.output || raw?.output || "",
      aggregatedOutput:
        payload?.aggregatedOutput || payload?.aggregated_output || raw?.aggregatedOutput || "",
      formattedOutput:
        payload?.formattedOutput || payload?.formatted_output || raw?.formattedOutput || "",
      exitCode:
        payload?.exitCode ??
        payload?.exit_code ??
        raw?.exitCode ??
        raw?.exit_code ??
        null,
      duration: payload?.duration || raw?.duration || null,
      status: payload?.status || raw?.status || null,
      rejected: payload?.rejected ?? raw?.rejected ?? false,
      raw,
    };
  }

  if (topType === "command.output.delta") {
    return {
      stream: payload?.stream || raw?.stream || "stdout",
      textDelta:
        payload?.textDelta ||
        payload?.text_delta ||
        raw?.textDelta ||
        raw?.text_delta ||
        payload?.delta ||
        raw?.delta ||
        payload?.text ||
        raw?.text ||
        "",
      raw,
    };
  }

  if (topType === "patch.start") {
    return {
      input: payload?.input || raw?.input || raw?.patch || "",
      raw,
    };
  }

  if (topType === "patch.end") {
    return {
      output: payload?.output || raw?.output || "",
      stdout: payload?.stdout || raw?.stdout || "",
      stderr: payload?.stderr || raw?.stderr || "",
      success: payload?.success ?? raw?.success ?? null,
      status: payload?.status || raw?.status || null,
      changes: payload?.changes || raw?.changes || {},
      raw,
    };
  }

  if (topType === "patch.output.delta") {
    return {
      textDelta:
        payload?.textDelta ||
        payload?.text_delta ||
        raw?.textDelta ||
        raw?.text_delta ||
        payload?.delta ||
        raw?.delta ||
        payload?.text ||
        raw?.text ||
        "",
      raw,
    };
  }

  if (topType === "approval.requested" || topType === "approval.resolved") {
    return {
      title: payload?.title || raw?.title || "",
      reason: payload?.reason || raw?.reason || "",
      command: payload?.command || raw?.command || "",
      decision: payload?.decision || raw?.decision || null,
      resumable: payload?.resumable ?? raw?.resumable ?? true,
      raw,
    };
  }

  if (topType === "turn.aborted" || topType === "error") {
    return {
      reason: payload?.reason || raw?.reason || "",
      message: payload?.message || raw?.message || "",
      code: payload?.code || raw?.code || null,
      raw,
    };
  }

  if (topType === "token_count") {
    return normalizeTokenCount({
      ...raw,
      ...payload,
      rate_limits: payload?.rate_limits || raw?.rate_limits || raw?.rateLimits || null,
    });
  }

  return payload;
}

export function normalizeRawSessionEvent(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const timestamp = toIsoTimestamp(raw.timestamp);
  const seq =
    typeof raw.seq === "number"
      ? raw.seq
      : Number.isFinite(Number(raw.seq))
        ? Number(raw.seq)
        : 0;
  const topType = String(raw.type || "");
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  const payloadType = String(payload.type || "");

  const directSemanticKinds = new Set([
    "message.user",
    "message.assistant",
    "message.assistant.start",
    "message.assistant.delta",
    "message.assistant.end",
    "reasoning",
    "reasoning.start",
    "reasoning.delta",
    "reasoning.end",
    "command.start",
    "command.output.delta",
    "command.end",
    "patch.start",
    "patch.output.delta",
    "patch.end",
    "approval.requested",
    "approval.resolved",
    "turn.started",
    "turn.completed",
    "turn.aborted",
    "error",
    "token_count",
  ]);

  if (directSemanticKinds.has(topType)) {
    const directKindMap = {
      "message.user": "user_message",
      "message.assistant": "assistant_message",
      "message.assistant.start": "assistant_message_start",
      "message.assistant.delta": "assistant_message_delta",
      "message.assistant.end": "assistant_message_end",
      reasoning: "reasoning",
      "reasoning.start": "reasoning_start",
      "reasoning.delta": "reasoning_delta",
      "reasoning.end": "reasoning_end",
      "command.start": "command_start",
      "command.output.delta": "command_output_delta",
      "command.end": "command_end",
      "patch.start": "patch_start",
      "patch.output.delta": "patch_output_delta",
      "patch.end": "patch_end",
      "approval.requested": "approval_requested",
      "approval.resolved": "approval_resolved",
      "turn.started": "turn_started",
      "turn.completed": "turn_completed",
      "turn.aborted": "turn_aborted",
      error: "error",
      token_count: "token_count",
    };

    return {
      id: normalizeId(raw, "semantic"),
      seq,
      timestamp,
      kind: directKindMap[topType],
      turnId: raw.turnId || payload.turnId || payload.turn_id || null,
      callId: raw.callId || payload.callId || payload.call_id || null,
      requestId: raw.requestId || payload.requestId || payload.request_id || null,
      messageId: raw.messageId || payload.messageId || payload.message_id || null,
      role: raw.role || payload.role || null,
      phase: raw.phase || payload.phase || null,
      payload: normalizeDirectSemanticPayload(topType, raw, payload),
    };
  }

  if (topType === "session_meta" || topType === "turn_context") {
    return null;
  }

  if (topType === "response_item") {
    if (payloadType === "message") {
      const role = String(payload.role || "");
      const phase = payload.phase || null;
      const text = normalizeMessageContent(payload.content);

      if (role === "user") {
        return {
          id: normalizeId(raw, "user"),
          seq,
          timestamp,
          kind: "user_message",
          turnId: pickTurnId(payload),
          callId: null,
          requestId: null,
          messageId: pickMessageId(payload),
          role: "user",
          phase: null,
          payload: {
            text,
            source: "response_item.message",
            raw: payload,
          },
        };
      }

      if (role === "assistant") {
        return {
          id: normalizeId(raw, "assistant"),
          seq,
          timestamp,
          kind: "assistant_message",
          turnId: pickTurnId(payload),
          callId: null,
          requestId: null,
          messageId: pickMessageId(payload),
          role: "assistant",
          phase: phase || "final_answer",
          payload: {
            text,
            source: "response_item.message",
            raw: payload,
          },
        };
      }

      return null;
    }

    if (payloadType === "reasoning") {
      return {
        id: normalizeId(raw, "reasoning"),
        seq,
        timestamp,
        kind: "reasoning",
        turnId: pickTurnId(payload),
        callId: null,
        requestId: null,
        messageId: pickMessageId(payload),
        role: "assistant",
        phase: "commentary",
        payload: {
          summary: payload?.summary || null,
          content: payload?.content || null,
          encryptedContent: payload?.encrypted_content || null,
          raw: payload,
        },
      };
    }

    if (payloadType === "function_call" && payload?.name === "exec_command") {
      const args = normalizeFunctionCallArguments(payload);
      return {
        id: normalizeId(raw, "command-start"),
        seq,
        timestamp,
        kind: "command_start",
        turnId: pickTurnId(payload) || args.turnId || null,
        callId: pickCallId(payload),
        requestId: pickRequestId(payload) || null,
        messageId: null,
        role: "assistant",
        phase: "commentary",
        payload: {
          name: payload.name,
          command: args.cmd || "",
          sandboxPermissions: args.sandbox_permissions || null,
          justification: args.justification || null,
          cwd: args.cwd || null,
          args,
          raw: payload,
        },
      };
    }

    if (payloadType === "function_call_output") {
      return {
        id: normalizeId(raw, "command-end"),
        seq,
        timestamp,
        kind: "command_end",
        turnId: pickTurnId(payload),
        callId: pickCallId(payload),
        requestId: pickRequestId(payload),
        messageId: null,
        role: "assistant",
        phase: "commentary",
        payload: normalizeFunctionCallOutput(payload),
      };
    }

    if (payloadType === "custom_tool_call" && payload?.name === "apply_patch") {
      return {
        id: normalizeId(raw, "patch-start"),
        seq,
        timestamp,
        kind: "patch_start",
        turnId: pickTurnId(payload),
        callId: pickCallId(payload),
        requestId: null,
        messageId: null,
        role: "assistant",
        phase: "commentary",
        payload: {
          name: payload.name,
          status: payload.status || null,
          input: payload.input || "",
          raw: payload,
        },
      };
    }

    if (payloadType === "custom_tool_call_output") {
      return {
        id: normalizeId(raw, "patch-end"),
        seq,
        timestamp,
        kind: "patch_end",
        turnId: pickTurnId(payload),
        callId: pickCallId(payload),
        requestId: null,
        messageId: null,
        role: "assistant",
        phase: "commentary",
        payload: normalizeCustomToolOutput(payload),
      };
    }

    return null;
  }

  if (topType === "event_msg") {
    if (payloadType === "user_message") {
      return {
        id: normalizeId(raw, "user"),
        seq,
        timestamp,
        kind: "user_message",
        turnId: pickTurnId(payload),
        callId: null,
        requestId: null,
        messageId: pickMessageId(payload),
        role: "user",
        phase: null,
        payload: {
          text: payload?.message || "",
          images: Array.isArray(payload?.images) ? payload.images : [],
          localImages: Array.isArray(payload?.local_images) ? payload.local_images : [],
          source: "event_msg.user_message",
          raw: payload,
        },
      };
    }

    if (payloadType === "agent_message") {
      return {
        id: normalizeId(raw, "assistant"),
        seq,
        timestamp,
        kind: "assistant_message",
        turnId: pickTurnId(payload),
        callId: null,
        requestId: null,
        messageId: pickMessageId(payload),
        role: "assistant",
        phase: payload?.phase || "final_answer",
        payload: {
          text: payload?.message || "",
          memoryCitation: payload?.memory_citation || null,
          source: "event_msg.agent_message",
          raw: payload,
        },
      };
    }

    if (payloadType === "task_started") {
      return {
        id: normalizeId(raw, "turn-start"),
        seq,
        timestamp,
        kind: "turn_started",
        turnId: pickTurnId(payload),
        callId: null,
        requestId: null,
        messageId: null,
        role: null,
        phase: null,
        payload: {
          modelContextWindow: payload?.model_context_window || null,
          collaborationModeKind: payload?.collaboration_mode_kind || null,
          raw: payload,
        },
      };
    }

    if (payloadType === "task_complete") {
      return {
        id: normalizeId(raw, "turn-complete"),
        seq,
        timestamp,
        kind: "turn_completed",
        turnId: pickTurnId(payload),
        callId: null,
        requestId: null,
        messageId: null,
        role: null,
        phase: null,
        payload: {
          lastAgentMessage: payload?.last_agent_message || "",
          raw: payload,
        },
      };
    }

    if (payloadType === "turn_aborted") {
      return {
        id: normalizeId(raw, "turn-aborted"),
        seq,
        timestamp,
        kind: "turn_aborted",
        turnId: pickTurnId(payload),
        callId: null,
        requestId: null,
        messageId: null,
        role: null,
        phase: null,
        payload: {
          reason: payload?.reason || null,
          raw: payload,
        },
      };
    }

    if (payloadType === "exec_command_end") {
      return {
        id: normalizeId(raw, "command-end"),
        seq,
        timestamp,
        kind: "command_end",
        turnId: pickTurnId(payload),
        callId: pickCallId(payload),
        requestId: null,
        messageId: null,
        role: null,
        phase: null,
        payload: normalizeExecCommandEnd(payload),
      };
    }

    if (payloadType === "patch_apply_end") {
      return {
        id: normalizeId(raw, "patch-end"),
        seq,
        timestamp,
        kind: "patch_end",
        turnId: pickTurnId(payload),
        callId: pickCallId(payload),
        requestId: null,
        messageId: null,
        role: null,
        phase: null,
        payload: normalizePatchEnd(payload),
      };
    }

    if (payloadType === "error") {
      return {
        id: normalizeId(raw, "error"),
        seq,
        timestamp,
        kind: "error",
        turnId: pickTurnId(payload),
        callId: pickCallId(payload),
        requestId: pickRequestId(payload),
        messageId: null,
        role: null,
        phase: null,
        payload: {
          message: payload?.message || "",
          code: payload?.codex_error_info || null,
          raw: payload,
        },
      };
    }

    if (payloadType === "token_count") {
      return {
        id: normalizeId(raw, "token-count"),
        seq,
        timestamp,
        kind: "token_count",
        turnId: pickTurnId(payload),
        callId: null,
        requestId: null,
        messageId: null,
        role: null,
        phase: null,
        payload: normalizeTokenCount(payload),
      };
    }
  }

  return null;
}

function expandOneShotNormalizedEvent(event) {
  if (!event) {
    return [];
  }

  if (event.kind === "assistant_message") {
    const messageId = event.messageId || `assistant:${event.id}`;
    const base = {
      ...event,
      messageId,
    };
    return [
      {
        ...base,
        id: `${event.id}:start`,
        kind: "assistant_message_start",
        payload: { raw: event.payload?.raw || event.payload || {} },
      },
      {
        ...base,
        id: `${event.id}:delta`,
        kind: "assistant_message_delta",
        payload: {
          textDelta: event.payload?.text || "",
          raw: event.payload?.raw || event.payload || {},
        },
      },
      {
        ...base,
        id: `${event.id}:end`,
        kind: "assistant_message_end",
        payload: { raw: event.payload?.raw || event.payload || {} },
      },
    ];
  }

  if (event.kind === "reasoning") {
    const messageId = event.messageId || `reasoning:${event.id}`;
    const reasoningText =
      event.payload?.content || event.payload?.summary || event.payload?.text || "";
    return [
      {
        ...event,
        id: `${event.id}:start`,
        kind: "reasoning_start",
        messageId,
        payload: {
          summary: event.payload?.summary || "",
          raw: event.payload?.raw || event.payload || {},
        },
      },
      {
        ...event,
        id: `${event.id}:delta`,
        kind: "reasoning_delta",
        messageId,
        payload: {
          textDelta: reasoningText,
          summary: event.payload?.summary || "",
          raw: event.payload?.raw || event.payload || {},
        },
      },
      {
        ...event,
        id: `${event.id}:end`,
        kind: "reasoning_end",
        messageId,
        payload: { raw: event.payload?.raw || event.payload || {} },
      },
    ];
  }

  return [event];
}

export function normalizeRawSessionEvents(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .flatMap((raw) => expandOneShotNormalizedEvent(normalizeRawSessionEvent(raw)))
    .filter(Boolean)
    .sort((a, b) => a.seq - b.seq);
}
