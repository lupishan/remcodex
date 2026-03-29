import { escapeHtml, renderRichText } from "./message-rich-text.js";
import { formatInlineList, t } from "./i18n/index.js";
import {
  basename,
  classifyCommandActivity,
  resolveActivityDisplay,
} from "./session-command-activity.js";

function getCompactDisplayPaths(paths, limit = 2) {
  const values = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (values.length === 0) {
    return { preview: [], remainingCount: 0 };
  }

  const basenameCounts = new Map();
  values.forEach((path) => {
    const key = basename(path) || path;
    basenameCounts.set(key, (basenameCounts.get(key) || 0) + 1);
  });

  const displayPaths = values.map((path) => {
    const key = basename(path) || path;
    return (basenameCounts.get(key) || 0) > 1 ? path : key;
  });

  return {
    preview: displayPaths.slice(0, limit),
    remainingCount: Math.max(0, displayPaths.length - limit),
  };
}

function compactCommandPreview(command, maxLength = 64) {
  const source = String(command || "").trim();
  if (!source) {
    return "";
  }

  const unwrapped = source.replace(
    /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/,
    "$2",
  );
  const normalized = unwrapped.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
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

function renderInlineActivityDetail({
  shell = "",
  output = "",
  error = "",
  patchText = "",
}) {
  const hasBody = shell || output || error || patchText;
  if (!hasBody) {
    return { hasDetail: false, bodyHtml: "" };
  }

  return {
    hasDetail: true,
    bodyHtml: `
      <div class="assistant-command-content">
        ${shell ? `<pre class="assistant-command-shell">${escapeHtml(shell)}</pre>` : ""}
        ${patchText ? `<pre class="assistant-command-output">${escapeHtml(patchText)}</pre>` : ""}
        ${output ? `<pre class="assistant-command-output">${escapeHtml(output)}</pre>` : ""}
        ${error ? `<pre class="assistant-command-error-output">${escapeHtml(error)}</pre>` : ""}
      </div>
    `,
  };
}

function renderRawActivityItems(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return "";
  }

  const blocks = list
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      if (item.type === "patch") {
        return renderInlineActivityDetail({
          patchText: item.patchText || "",
          output: item.output || "",
          error: item.stderr || "",
        }).bodyHtml;
      }
      if (item.type === "command") {
        return renderInlineActivityDetail({
          shell: item.command || "",
          output: item.output || item.stdout || "",
          error: item.stderr || "",
        }).bodyHtml;
      }
      return "";
    })
    .filter(Boolean);

  return blocks.join("");
}

function renderInlineActivityRow({
  rowClass = "",
  itemId = "",
  label = "",
  meta = "",
  detail = null,
  open = false,
}) {
  if (detail?.hasDetail) {
    return `
      <div class="transcript-row transcript-row-inline-activity timeline-row ${escapeHtml(rowClass)}" data-timeline-id="${escapeHtml(itemId)}">
        <div class="timeline-inline-step">
          <details class="timeline-inline-detail-row" ${open ? "open" : ""}>
            <summary class="task-step-row task-step-item-status">
              <span class="task-step-label">${escapeHtml(label)}</span>
              ${meta ? `<span class="task-step-meta">${escapeHtml(meta)}</span>` : ""}
            </summary>
            ${detail.bodyHtml}
          </details>
        </div>
      </div>
    `;
  }

  return `
    <div class="transcript-row transcript-row-inline-activity timeline-row ${escapeHtml(rowClass)}" data-timeline-id="${escapeHtml(itemId)}">
      <div class="timeline-inline-step">
        <div class="task-step-row task-step-item-status">
          <span class="task-step-label">${escapeHtml(label)}</span>
          ${meta ? `<span class="task-step-meta">${escapeHtml(meta)}</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

function renderInlinePatchMeta(item, classification, display) {
  const changeEntries = Object.entries(item.changes || {});
  if (changeEntries.length > 0) {
    const basenameCounts = new Map();
    changeEntries.forEach(([path]) => {
      const key = basename(path) || path;
      basenameCounts.set(key, (basenameCounts.get(key) || 0) + 1);
    });
    const preview = changeEntries.slice(0, 2).map(([path, change]) => {
      const compact = basename(path) || path;
      const displayPath = (basenameCounts.get(compact) || 0) > 1 ? path : compact;
      return `${displayPath} +${Number(change?.added || 0)} -${Number(change?.removed || 0)}`;
    });
    if (changeEntries.length > 2) {
      preview.push(t("timeline.summary.moreItems", { count: changeEntries.length }));
    }
    return preview.join("、");
  }

  if (classification.files.length > 0) {
    const firstPath = classification.files[0];
    return `${basename(firstPath) || firstPath} +${Number(classification.stats?.added || 0)} -${Number(classification.stats?.removed || 0)}`;
  }

  return display.subtitle || "";
}

function getBubbleWidthClass(text) {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }

  return source.includes("\n") ? "" : " msg-bubble-fluid";
}

function renderChanges(changes) {
  const entries = Object.entries(changes || {});
  if (entries.length === 0) {
    return "";
  }

  return `
    <ul class="timeline-file-list">
      ${entries
        .map(
          ([file, change]) => `
            <li class="timeline-file-item">
              <span class="timeline-file-op">${escapeHtml(change?.type || "?")}</span>
              <span class="timeline-file-path">${escapeHtml(file)}</span>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderPlainStreamingText(text) {
  return `<div class="timeline-streaming-plain">${escapeHtml(String(text || "")).replace(/\n/g, "<br>")}</div>`;
}

function renderStreamingAwareRichText(text, options = {}) {
  const source = String(text || "");
  const body = renderRichText(source, options);
  if (body) {
    return body;
  }

  if (source) {
    return renderPlainStreamingText(source);
  }

  return "";
}

export function renderTimelineList(items, options = {}) {
  const body =
    Array.isArray(items) && items.length > 0
      ? items.map((item) => renderTimelineItem(item, options)).join("")
      : `<div class="event-empty">${escapeHtml(t("timeline.empty"))}</div>`;

  return `
    <div id="event-list" class="event-list timeline-list event-list--flex">
      ${body}
    </div>
  `;
}

export function renderTimeline(items, options = {}) {
  return `
    <div class="session-stream-shell">
      <div class="session-stream-main">
        ${renderTimelineList(items, options)}
      </div>
    </div>
  `;
}

export function renderTimelineItem(item, options = {}) {
  switch (item.type) {
    case "user":
      return renderUserMessage(item, options);
    case "assistant_commentary":
      return renderAssistantCommentary(item, options);
    case "assistant_final":
      return renderAssistantFinal(item, options);
    case "reasoning":
      return renderReasoningItem(item, options);
    case "command":
      return renderCommandItem(item, options);
    case "patch":
      return renderPatchItem(item, options);
    case "activity_summary":
      return renderActivitySummaryItem(item, options);
    case "file_change_summary":
      return renderFileChangeSummaryItem(item, options);
    case "approval":
      return renderApprovalItem(item, options);
    case "system":
      return renderSystemItem(item, options);
    default:
      return "";
  }
}

export function renderUserMessage(item) {
  return `
    <div class="transcript-row transcript-row-user timeline-row timeline-row-user" data-timeline-id="${escapeHtml(item.id || "")}">
      <article class="msg-bubble msg-user msg-user-soft${getBubbleWidthClass(item.text)}" aria-label="${escapeHtml(t("timeline.userMessage"))}">
        <div class="msg-bubble-body">${renderRichText(item.text || "")}</div>
      </article>
    </div>
  `;
}

export function renderAssistantCommentary(item) {
  const body = renderStreamingAwareRichText(item.text || "", {
    streaming: item.status === "streaming",
  });
  if (!body) {
    return "";
  }
  return `
    <div class="transcript-row transcript-row-assistant timeline-row timeline-row-commentary" data-timeline-id="${escapeHtml(item.id || "")}">
      <article class="msg-bubble msg-assistant turn-assistant-bubble timeline-commentary-bubble${getBubbleWidthClass(item.text)} ${item.status === "streaming" ? "timeline-assistant-streaming" : ""}" aria-label="${escapeHtml(t("timeline.assistantCommentary"))}">
        <div class="msg-bubble-body msg-md timeline-commentary-body">
          ${body}
        </div>
      </article>
    </div>
  `;
}

export function renderAssistantFinal(item) {
  const body = renderStreamingAwareRichText(item.text || "", {
    streaming: item.status === "streaming",
  });
  if (!body) {
    return "";
  }
  return `
    <div class="transcript-row transcript-row-assistant timeline-row timeline-row-final" data-timeline-id="${escapeHtml(item.id || "")}">
      <article class="msg-bubble msg-assistant turn-assistant-bubble${getBubbleWidthClass(item.text)} ${item.status === "streaming" ? "timeline-assistant-streaming" : ""}" aria-label="${escapeHtml(t("timeline.assistant"))}">
        <div class="msg-bubble-body msg-md">
          ${body}
        </div>
      </article>
    </div>
  `;
}

export function renderReasoningItem(item, options = {}) {
  const activeElapsedLabel =
    item.status === "thinking" ? String(options.activeElapsedLabel || "").trim() : "";
  const reasoningText = String(item.summary || item.text || "").trim();
  if (!reasoningText && !item.synthetic) {
    return "";
  }
  return `
    <div class="transcript-row transcript-row-assistant timeline-row timeline-row-reasoning" data-timeline-id="${escapeHtml(item.id || "")}">
      <div class="timeline-reasoning ${item.status === "thinking" ? "timeline-reasoning-thinking" : ""}">
        <div class="assistant-thinking-row">
          <span class="assistant-thinking">${escapeHtml(reasoningText || t("timeline.thinking"))}</span>
          ${
            activeElapsedLabel
              ? `<span class="assistant-thinking-elapsed" data-active-elapsed="true">${escapeHtml(activeElapsedLabel)}</span>`
              : ""
          }
        </div>
      </div>
    </div>
  `;
}

export function renderCommandItem(item) {
  const classification = classifyCommandActivity(item);
  const display = resolveActivityDisplay(item, classification);
  const inlineOutput = String(item.output || item.stdout || "");
  const isRunning =
    item.status === "running" ||
    item.outputStatus === "streaming" ||
    item.status === "awaiting_approval";
  const isFailed =
    item.status === "failed" ||
    item.status === "rejected" ||
    (item.exitCode !== null &&
      item.exitCode !== undefined &&
      Number.isFinite(Number(item.exitCode)) &&
      Number(item.exitCode) !== 0) ||
    Boolean(String(item.stderr || "").trim());
  const canRenderInline =
    isRunning ||
    (!isFailed && !["unknown"].includes(classification.kind));
  const shouldRenderCard = !canRenderInline && !isFailed;
  const summary = [];
  const pushSummary = (value) => {
    if (!value || summary.includes(value)) {
      return;
    }
    summary.push(value);
  };
  pushSummary(display.subtitle);
  pushSummary(item.cwd ? `cwd: ${item.cwd}` : "");
  pushSummary(
    item.exitCode !== null && item.exitCode !== undefined ? `exit ${item.exitCode}` : "",
  );
  pushSummary(item.status);
  const shouldOpen = item.status === "running" || item.outputStatus === "streaming";

  if (!shouldRenderCard) {
    const inlineMeta = display.subtitle || compactCommandPreview(item.command || "");
    const detail = renderInlineActivityDetail({
      shell: item.command || "",
      output: inlineOutput,
      error: item.stderr || "",
    });
    return renderInlineActivityRow({
      rowClass: "timeline-row-command timeline-row-inline-command",
      itemId: item.id || "",
      label: display.title || t("timeline.command"),
      meta: inlineMeta,
      detail,
      open: isRunning || isFailed,
    });
  }

  return `
    <div class="transcript-row transcript-row-assistant timeline-row timeline-row-command" data-timeline-id="${escapeHtml(item.id || "")}">
      <div class="timeline-card timeline-card-command timeline-card-${escapeHtml(item.status || "pending")}">
        <details ${shouldOpen ? "open" : ""}>
          <summary>
            <span class="timeline-card-title">${escapeHtml(display.title || t("timeline.command"))}</span>
            <span class="timeline-card-meta">${escapeHtml(summary.join(" · "))}</span>
          </summary>
          <div class="timeline-card-body">
            ${
              display.showRawCommandAsBody && item.command
                ? `<pre class="timeline-card-pre">${escapeHtml(item.command)}</pre>`
                : ""
            }
            ${
              item.output
                ? `<pre class="timeline-card-pre">${escapeHtml(item.output)}</pre>`
                : item.stdout
                  ? `<pre class="timeline-card-pre">${escapeHtml(item.stdout)}</pre>`
                  : item.status === "running"
                    ? renderStreamingPlaceholder(t("timeline.commandStreaming"))
                  : ""
            }
            ${item.stderr ? `<pre class="timeline-card-pre timeline-card-pre-error">${escapeHtml(item.stderr)}</pre>` : ""}
          </div>
        </details>
      </div>
    </div>
  `;
}

export function renderPatchItem(item) {
  const classification = classifyCommandActivity(item);
  const display = resolveActivityDisplay(item, classification);
  const isRunning =
    item.status === "running" ||
    item.outputStatus === "streaming" ||
    item.status === "awaiting_approval";
  const looksFailed =
    item.success === false ||
    Boolean(String(item.stderr || "").trim()) ||
    /verification failed/i.test(String(item.output || "")) ||
    /failed to find expected lines/i.test(String(item.output || ""));
  const shouldRenderCard =
    !looksFailed && !isRunning && classification.files.length === 0;
  const meta = [];
  const pushMeta = (value) => {
    if (!value || meta.includes(value)) {
      return;
    }
    meta.push(value);
  };
  pushMeta(display.subtitle);
  pushMeta(item.status || "pending");
  if (item.success === true) {
    pushMeta("success");
  } else if (item.success === false) {
    pushMeta("failed");
  }
  const shouldOpen = item.status === "running" || item.outputStatus === "streaming";

  if (!shouldRenderCard) {
    const detail = renderInlineActivityDetail({
      patchText: item.patchText || "",
      output: item.output || "",
      error: item.stderr || "",
    });
    return renderInlineActivityRow({
      rowClass: "timeline-row-patch timeline-row-inline-patch",
      itemId: item.id || "",
      label: display.title || t("timeline.patch"),
      meta: renderInlinePatchMeta(item, classification, display),
      detail,
      open: isRunning || looksFailed,
    });
  }

  return `
    <div class="transcript-row transcript-row-assistant timeline-row timeline-row-patch" data-timeline-id="${escapeHtml(item.id || "")}">
      <div class="timeline-card timeline-card-patch timeline-card-${escapeHtml(item.status || "pending")}">
        <details ${shouldOpen ? "open" : ""}>
          <summary>
            <span class="timeline-card-title">${escapeHtml(display.title || t("timeline.patch"))}</span>
            <span class="timeline-card-meta">${escapeHtml(meta.join(" · "))}</span>
          </summary>
          <div class="timeline-card-body">
            ${item.patchText ? `<pre class="timeline-card-pre">${escapeHtml(item.patchText)}</pre>` : ""}
            ${renderChanges(item.changes)}
            ${
              item.output
                ? `<pre class="timeline-card-pre">${escapeHtml(item.output)}</pre>`
                : item.status === "running"
                  ? renderStreamingPlaceholder(t("timeline.patchStreaming"))
                  : ""
            }
            ${item.stderr ? `<pre class="timeline-card-pre timeline-card-pre-error">${escapeHtml(item.stderr)}</pre>` : ""}
          </div>
        </details>
      </div>
    </div>
  `;
}

export function renderActivitySummaryItem(item) {
  const summary = item.summary || {};
  const browseFiles = Array.isArray(summary.browseFiles) ? summary.browseFiles : [];
  const searchTargets = Array.isArray(summary.searchTargets) ? summary.searchTargets : [];
  const metaParts = [];
  const browsePreview = getCompactDisplayPaths(browseFiles, 2);
  const searchPreview = getCompactDisplayPaths(searchTargets, 2);

  if (browsePreview.preview.length > 0) {
    metaParts.push(formatInlineList(browsePreview.preview));
  }
  if (browsePreview.remainingCount > 0) {
    metaParts.push(t("timeline.summary.moreFiles", { count: browsePreview.remainingCount }));
  }
  if (summary.searchCount > 0 && searchPreview.preview.length > 0) {
    metaParts.push(
      browsePreview.preview.length > 0
        ? t("timeline.summary.searchAt", { value: formatInlineList(searchPreview.preview) })
        : formatInlineList(searchPreview.preview),
    );
  }
  if (
    summary.validationCount > 0 &&
    searchPreview.preview.length > 0 &&
    summary.searchCount === 0
  ) {
    metaParts.push(formatInlineList(searchPreview.preview));
  }
  if (
    summary.searchCount > 0 &&
    searchPreview.remainingCount > 0 &&
    browsePreview.preview.length === 0
  ) {
    metaParts.push(t("timeline.summary.moreLocations", { count: searchPreview.remainingCount }));
  }
  if (
    summary.validationCount > 0 &&
    searchPreview.remainingCount > 0 &&
    summary.searchCount === 0
  ) {
    metaParts.push(t("timeline.summary.moreLocations", { count: searchPreview.remainingCount }));
  }
  if (summary.commandsCount > 0 && metaParts.length === 0) {
    metaParts.push(t("timeline.summary.activities", { count: summary.commandsCount }));
  }

  const detail = {
    hasDetail: Array.isArray(item.rawItems) && item.rawItems.length > 0,
    bodyHtml: renderRawActivityItems(item.rawItems),
  };

  return renderInlineActivityRow({
    rowClass: "timeline-row-activity-summary",
    itemId: item.id || "",
    label: summary.title || t("timeline.activitySummary"),
    meta: metaParts.join(" · "),
    detail,
  });
}

export function renderFileChangeSummaryItem(item) {
  const files = Array.isArray(item.files) ? item.files : [];
  const basenameCounts = new Map();
  files.forEach((file) => {
    const key = basename(file.path || "") || file.path || "";
    basenameCounts.set(key, (basenameCounts.get(key) || 0) + 1);
  });

  const preview = files.slice(0, 2).map((file) => {
    const path = file.path || t("timeline.file.untitled");
    const compact = basename(path) || path;
    const displayPath = (basenameCounts.get(compact) || 0) > 1 ? path : compact;
    return `${displayPath} +${Number(file.added || 0)} -${Number(file.removed || 0)}`;
  });
  if (files.length > 2) {
    preview.push(t("timeline.summary.moreItems", { count: files.length }));
  }
  const detail = {
    hasDetail: Array.isArray(item.rawItems) && item.rawItems.length > 0,
    bodyHtml: renderRawActivityItems(item.rawItems),
  };

  return renderInlineActivityRow({
    rowClass: "timeline-row-file-change-summary",
    itemId: item.id || "",
    label: item.title || t("timeline.fileChanges"),
    meta: formatInlineList(preview),
    detail,
  });
}

export function renderApprovalItem(item) {
  const metaParts = [];
  if (item.status === "rejected") {
    metaParts.push(t("approval.deny"));
  } else if (item.status === "resolved") {
    if (item.decision === "acceptForSession") {
      metaParts.push(t("approval.allowForTurn"));
    } else {
      metaParts.push(t("approval.allowOnce"));
    }
  } else {
    metaParts.push(t("approval.pending"));
  }

  if (item.reason) {
    metaParts.push(item.reason);
  } else if (item.command) {
    metaParts.push(compactCommandPreview(item.command, 88));
  }

  return renderInlineActivityRow({
    rowClass: "timeline-row-approval-history",
    itemId: item.id || "",
    label: localizeApprovalTitle(item.title),
    meta: metaParts.join(" · "),
  });
}

export function renderSystemItem(item) {
  return `
    <div class="transcript-row transcript-row-assistant timeline-row timeline-row-system" data-timeline-id="${escapeHtml(item.id || "")}">
      <div class="timeline-system timeline-system-${escapeHtml(item.status || item.subtype || "neutral")}">
        ${escapeHtml(item.text || item.subtype || t("timeline.system"))}
      </div>
    </div>
  `;
}
