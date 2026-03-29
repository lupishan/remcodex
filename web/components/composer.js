import { getCodexHosts, getCodexQuota } from "../api.js";
import { t } from "../i18n/index.js";

const CODEX_LAUNCH_STORAGE_KEY = "remote-agent-console.codexLaunch.v1";

export const CLIENT_FALLBACK_CODEX_UI_OPTIONS = {
  models: [
    { id: "gpt-5.4", label: "gpt-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { id: "gpt-5.2-codex", label: "gpt-5.2-codex" },
    { id: "gpt-5.2", label: "gpt-5.2" },
    { id: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
    { id: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
  ],
  reasoningLevels: [
    { id: "low", label: "low", launch: { reasoningEffort: "low" } },
    { id: "medium", label: "medium", launch: { reasoningEffort: "medium" } },
    { id: "high", label: "high", launch: { reasoningEffort: "high" } },
    { id: "xhigh", label: "xhigh", launch: { reasoningEffort: "xhigh" } },
  ],
};

function getReasoningLabel(id, fallback = "") {
  if (id === "low") {
    return t("composer.reasoning.low");
  }
  if (id === "medium") {
    return t("composer.reasoning.medium");
  }
  if (id === "high") {
    return t("composer.reasoning.high");
  }
  if (id === "xhigh") {
    return t("composer.reasoning.xhigh");
  }
  return fallback || id || "";
}

let activeComposerContext = null;
let selectMeasureEl = null;

function positionComposerEnvironmentPopover() {
  const popover = document.querySelector(".toolbar-host-wrap .input-popover");
  const toggle = document.querySelector("#composer-env-toggle");
  if (!(popover instanceof HTMLElement) || !(toggle instanceof HTMLElement)) {
    return;
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const margin = 8;
  const gap = 8;
  const maxWidth = Math.min(352, Math.max(220, viewportWidth - margin * 2));

  popover.style.width = `${maxWidth}px`;
  popover.style.maxWidth = `${maxWidth}px`;
  popover.style.position = "fixed";
  popover.style.left = "0";
  popover.style.right = "auto";
  popover.style.bottom = "auto";
  popover.style.transform = "none";

  const toggleRect = toggle.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const width = Math.min(maxWidth, Math.ceil(popoverRect.width || maxWidth));
  const height = Math.ceil(popoverRect.height || 0);

  let left = toggleRect.right - width;
  left = Math.max(margin, Math.min(left, viewportWidth - width - margin));

  let top = toggleRect.top - height - gap;
  if (top < margin) {
    top = Math.min(viewportHeight - height - margin, toggleRect.bottom + gap);
  }

  popover.style.left = `${Math.max(margin, left)}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderComposerSlashMenuItem(item, active) {
  const hint = item.hint ? `<span class="composer-slash-item-hint">${escapeHtml(item.hint)}</span>` : "";
  return `
    <button
      type="button"
      class="composer-slash-item ${active ? "composer-slash-item--active" : ""}"
      data-slash-command-id="${escapeHtml(item.id)}"
      ${item.enabled ? "" : 'disabled aria-disabled="true"'}
    >
      <span class="composer-slash-item-main">
        <span class="composer-slash-item-name">${escapeHtml(item.slash)}</span>
        <span class="composer-slash-item-title">${escapeHtml(item.title)}</span>
      </span>
      <span class="composer-slash-item-desc">${escapeHtml(item.description)}</span>
      ${hint}
    </button>
  `;
}

export function renderComposerSlashMenu(detailState, items = []) {
  if (!detailState?.slashMenuOpen) {
    return "";
  }

  if (detailState.slashCommandsLoading) {
    return `
      <div class="composer-slash-menu" role="listbox" aria-label="${escapeHtml(t("composer.slashMenu"))}">
        <div class="composer-slash-empty">${escapeHtml(t("composer.slashLoading"))}</div>
      </div>
    `;
  }

  if (!items.length) {
    return `
      <div class="composer-slash-menu" role="listbox" aria-label="${escapeHtml(t("composer.slashMenu"))}">
        <div class="composer-slash-empty">${escapeHtml(t("composer.slashEmpty"))}</div>
      </div>
    `;
  }

  return `
    <div class="composer-slash-menu" role="listbox" aria-label="${escapeHtml(t("composer.slashMenu"))}">
      ${items.map((item, index) => renderComposerSlashMenuItem(item, index === detailState.slashActiveIndex)).join("")}
    </div>
  `;
}

function ensureSelectMeasureEl() {
  if (selectMeasureEl) {
    return selectMeasureEl;
  }

  selectMeasureEl = document.createElement("span");
  selectMeasureEl.style.position = "absolute";
  selectMeasureEl.style.visibility = "hidden";
  selectMeasureEl.style.pointerEvents = "none";
  selectMeasureEl.style.whiteSpace = "nowrap";
  selectMeasureEl.style.left = "-9999px";
  selectMeasureEl.style.top = "-9999px";
  document.body.appendChild(selectMeasureEl);
  return selectMeasureEl;
}

function syncSelectWidth(el) {
  if (!(el instanceof HTMLSelectElement)) {
    return;
  }

  const measureEl = ensureSelectMeasureEl();
  const computed = window.getComputedStyle(el);
  const selectedText = el.options[el.selectedIndex]?.text?.trim() || "";

  measureEl.style.fontFamily = computed.fontFamily;
  measureEl.style.fontSize = computed.fontSize;
  measureEl.style.fontWeight = computed.fontWeight;
  measureEl.style.fontStyle = computed.fontStyle;
  measureEl.style.fontVariant = computed.fontVariant;
  measureEl.style.letterSpacing = computed.letterSpacing;
  measureEl.style.textTransform = computed.textTransform;
  measureEl.textContent = selectedText;

  const textWidth = Math.ceil(measureEl.getBoundingClientRect().width);
  const paddingLeft = Number.parseFloat(computed.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(computed.paddingRight) || 0;
  const borderLeft = Number.parseFloat(computed.borderLeftWidth) || 0;
  const borderRight = Number.parseFloat(computed.borderRightWidth) || 0;
  const arrowAllowance = 18;
  const nextWidth = Math.ceil(
    textWidth + paddingLeft + paddingRight + borderLeft + borderRight + arrowAllowance,
  );

  el.style.width = `${nextWidth}px`;
}

function renderComposerQuotaPopover(detailState) {
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
  const summary = `${hourPercent} / ${weekPercent}`;

  return `
    <details class="input-popover-quota">
      <summary class="input-popover-quota-summary">
        <span>${escapeHtml(t("composer.quota.remaining"))}</span>
        <span class="input-popover-quota-summary-value">${escapeHtml(summary)}</span>
      </summary>
      <div class="input-popover-quota-body">
        <p class="input-popover-quota-line">${escapeHtml(t("composer.quota.hours", { percent: hourPercent, remain: hourRemain }))}</p>
        <p class="input-popover-quota-line">${escapeHtml(t("composer.quota.week", { percent: weekPercent, reset: weekReset }))}</p>
      </div>
    </details>
  `;
}

function ensureDetailCodexLaunch(detailState, uiOptions) {
  const current = detailState.codexLaunch ?? loadCodexLaunchPrefs();
  const normalized = normalizeCodexLaunchAgainstUi(current, uiOptions);

  if (
    !detailState.codexLaunch ||
    detailState.codexLaunch.modelId !== normalized.modelId ||
    detailState.codexLaunch.reasoningId !== normalized.reasoningId ||
    detailState.codexLaunch.profile !== normalized.profile
  ) {
    detailState.codexLaunch = normalized;
    persistCodexLaunchPrefs(normalized);
  }

  return detailState.codexLaunch;
}

function renderComposerEnvironmentPopover(detailState) {
  const hosts = Array.isArray(detailState.remoteHosts) ? detailState.remoteHosts : [];
  const activeHost = detailState.activeRemoteHost || "";

  return `
    <div class="input-popover" role="menu" aria-label="${escapeHtml(t("composer.environment"))}">
      <div class="input-popover-group">
        ${
          hosts.length > 0
            ? hosts
                .map(
                  (host) => `
                    <button
                      type="button"
                      class="input-popover-item ${activeHost === host ? "input-popover-item--active" : ""}"
                      data-remote-host="${escapeHtml(host)}"
                    >
                      <span class="input-popover-item-check">${activeHost === host ? "✓" : ""}</span>
                      <span class="input-popover-item-label">${escapeHtml(host)}</span>
                    </button>
                  `,
                )
                .join("")
            : `<div class="input-popover-item-label">${escapeHtml(t("composer.unsynced"))}</div>`
        }
      </div>
      <div class="input-popover-divider"></div>
      ${renderComposerQuotaPopover(detailState)}
    </div>
  `;
}

function setActiveRemoteHost(detailState, host) {
  detailState.activeRemoteHost = String(host || "").trim();
}

function closeComposerEnvironmentMenu(detailState, onRender) {
  if (!detailState.composerEnvironmentMenuOpen) {
    return;
  }

  detailState.composerEnvironmentMenuOpen = false;
  onRender();
}

function ensureComposerEnvironmentGlobalListeners() {
  if (window.__composerEnvironmentListenersBound) {
    return;
  }

  window.__composerEnvironmentListenersBound = true;

  document.addEventListener("click", (event) => {
    const context = activeComposerContext;
    if (!context?.detailState?.composerEnvironmentMenuOpen) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest(".input-container")) {
      return;
    }

    closeComposerEnvironmentMenu(context.detailState, context.onRender);
  });

  document.addEventListener("keydown", (event) => {
    const context = activeComposerContext;
    if (event.key === "Escape" && context?.detailState?.composerEnvironmentMenuOpen) {
      closeComposerEnvironmentMenu(context.detailState, context.onRender);
    }
  });
}

function bindComposerMetaControls(detailState) {
  ensureDetailCodexLaunch(detailState, detailState.codexUiOptions);

  document.querySelectorAll("[data-codex-pref]").forEach((el) => {
    const key = el.getAttribute("data-codex-pref");
    if (!key || (key !== "modelId" && key !== "reasoningId" && key !== "profile")) {
      return;
    }

    const onChange = () => {
      detailState.codexLaunch[key] = el.value;
      persistCodexLaunchPrefs(detailState.codexLaunch);
    };

    if (el.tagName === "SELECT") {
      syncSelectWidth(el);
      window.requestAnimationFrame(() => syncSelectWidth(el));
      if (document.fonts?.ready) {
        document.fonts.ready.then(() => syncSelectWidth(el)).catch(() => {});
      }
      el.onchange = () => {
        onChange();
        syncSelectWidth(el);
      };
      return;
    }

    el.oninput = onChange;
  });
}

function bindComposerEnvironmentControls(detailState, onRender) {
  ensureComposerEnvironmentGlobalListeners();

  const toggle = document.querySelector("#composer-env-toggle");
  if (toggle) {
    toggle.onclick = async () => {
      const nextOpen = !detailState.composerEnvironmentMenuOpen;
      detailState.composerEnvironmentMenuOpen = nextOpen;

      if (nextOpen) {
        if (!detailState.codexQuota && detailState.session?.sessionId) {
          try {
            detailState.codexQuota = await getCodexQuota(detailState.session.sessionId);
          } catch {
            detailState.codexQuota = null;
          }
        }

        try {
          const hostResult = await getCodexHosts();
          detailState.remoteHosts = Array.isArray(hostResult?.hosts)
            ? hostResult.hosts.filter((item) => typeof item === "string" && item.trim())
            : [];
          detailState.activeRemoteHost =
            typeof hostResult?.activeHost === "string" && hostResult.activeHost.trim()
              ? hostResult.activeHost.trim()
              : (detailState.remoteHosts[0] || "");
        } catch {
          detailState.remoteHosts = [];
          detailState.activeRemoteHost = "";
        }
      }

      onRender();
      window.requestAnimationFrame(() => positionComposerEnvironmentPopover());
    };
  }

  document.querySelectorAll("[data-remote-host]").forEach((el) => {
    el.onclick = () => {
      const next = el.getAttribute("data-remote-host");
      if (!next) {
        return;
      }

      setActiveRemoteHost(detailState, next);
      detailState.composerEnvironmentMenuOpen = false;
      onRender();
    };
  });
}

function isBusyStatus(status) {
  return ["starting", "running", "stopping"].includes(status);
}

function isSessionComposerBusy(session) {
  if (!session) {
    return false;
  }

  if (session.sourceKind === "imported_rollout") {
    return Boolean(session.liveBusy);
  }

  return isBusyStatus(session.status);
}

export function defaultCodexLaunch() {
  return {
    modelId: "",
    reasoningId: "medium",
    profile: "",
  };
}

export function loadCodexLaunchPrefs() {
  try {
    const raw = window.localStorage?.getItem(CODEX_LAUNCH_STORAGE_KEY);
    if (!raw) {
      return defaultCodexLaunch();
    }

    const parsed = JSON.parse(raw);
    const base = defaultCodexLaunch();

    let modelId = typeof parsed.modelId === "string" ? parsed.modelId : "";
    let reasoningId = typeof parsed.reasoningId === "string" ? parsed.reasoningId : "";

    if (!modelId && typeof parsed.model === "string" && parsed.model.trim()) {
      modelId = parsed.model.trim();
    }

    if (!reasoningId && typeof parsed.speed === "string") {
      if (parsed.speed === "fast") {
        reasoningId = "low";
      } else if (parsed.speed === "deep") {
        reasoningId = "high";
      } else {
        reasoningId = "medium";
      }
    }

    return {
      ...base,
      modelId,
      reasoningId: reasoningId || "medium",
      profile: typeof parsed.profile === "string" ? parsed.profile : "",
    };
  } catch {
    return defaultCodexLaunch();
  }
}

export function normalizeCodexLaunchAgainstUi(prefs, uiOptions) {
  const opts =
    uiOptions && Array.isArray(uiOptions.models) && uiOptions.models.length > 0
      ? uiOptions
      : CLIENT_FALLBACK_CODEX_UI_OPTIONS;
  const modelIds = new Set(opts.models.map((m) => m.id));
  const reasoningIds = new Set(opts.reasoningLevels.map((r) => r.id));
  let { modelId, reasoningId } = prefs;
  if (!modelId || !modelIds.has(modelId)) {
    modelId = opts.models[0]?.id || "";
  }
  if (!reasoningId || !reasoningIds.has(reasoningId)) {
    reasoningId = "medium";
  }
  return { ...prefs, modelId, reasoningId };
}

function persistCodexLaunchPrefs(prefs) {
  try {
    window.localStorage?.setItem(CODEX_LAUNCH_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function buildCodexLaunchPayload(launch, uiOptions) {
  if (!launch) {
    return undefined;
  }

  const opts =
    uiOptions && Array.isArray(uiOptions.models) && uiOptions.models.length > 0
      ? uiOptions
      : CLIENT_FALLBACK_CODEX_UI_OPTIONS;

  const codex = {};
  const modelId = String(launch.modelId || "").trim();
  if (modelId) {
    codex.model = modelId;
  }

  const profile = String(launch.profile || "").trim();
  if (profile) {
    codex.profile = profile;
  }

  const level = opts.reasoningLevels.find((r) => r.id === launch.reasoningId);
  const reasoningEffort = level?.launch?.reasoningEffort;
  if (
    reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high" ||
    reasoningEffort === "xhigh"
  ) {
    codex.reasoningEffort = reasoningEffort;
  }

  return Object.keys(codex).length ? codex : undefined;
}

export function renderComposerInput({ session, detailState, uiOptions }) {
  const opts =
    uiOptions && Array.isArray(uiOptions.models) && uiOptions.models.length > 0
      ? uiOptions
      : CLIENT_FALLBACK_CODEX_UI_OPTIONS;
  const launch = ensureDetailCodexLaunch(detailState, opts);
  const modelOptionsHtml = opts.models
    .map(
      (model) =>
        `<option value="${escapeHtml(model.id)}" ${launch.modelId === model.id ? "selected" : ""}>${escapeHtml(model.label)}</option>`,
    )
    .join("");
  const reasoningOptionsHtml = opts.reasoningLevels
    .map(
      (level) =>
        `<option value="${escapeHtml(level.id)}" ${launch.reasoningId === level.id ? "selected" : ""}>${escapeHtml(getReasoningLabel(level.id, level.label))}</option>`,
    )
    .join("");
  const activeHost = detailState.activeRemoteHost || "--";
  const isBusy = isSessionComposerBusy(session);

  return `
    <div class="input-container ${isBusy ? "input-container--busy" : ""}">
      <textarea
        name="content"
        class="input-area"
        rows="1"
        placeholder="${escapeHtml(t("composer.placeholder"))}"
        required
        autocomplete="off"
        autocorrect="on"
        aria-label="${escapeHtml(t("composer.aria.message"))}"
      >${escapeHtml(detailState.draft)}</textarea>
      <div id="composer-slash-slot"></div>
      <div class="toolbar">
        <div class="toolbar-center">
          <select class="toolbar-select" data-codex-pref="modelId" aria-label="${escapeHtml(t("composer.aria.model"))}">
            ${modelOptionsHtml}
          </select>
          <select class="toolbar-select" data-codex-pref="reasoningId" aria-label="${escapeHtml(t("composer.aria.reasoning"))}">
            ${reasoningOptionsHtml}
          </select>
          <div class="toolbar-host-wrap">
            <button
              type="button"
              id="composer-env-toggle"
              class="toolbar-env"
              aria-haspopup="menu"
              aria-expanded="${detailState.composerEnvironmentMenuOpen ? "true" : "false"}"
            >
              <span class="toolbar-env-label">${escapeHtml(activeHost)}</span>
            </button>
            ${
              detailState.composerEnvironmentMenuOpen
                ? renderComposerEnvironmentPopover(detailState)
                : ""
            }
          </div>
        </div>
        <div class="toolbar-right">
          <button
            type="button"
            id="composer-action"
            class="composer-action-fab ${isBusy ? "composer-action-fab--stop" : "composer-action-fab--send"}"
            aria-label="${escapeHtml(isBusy ? t("composer.aria.stop") : t("composer.aria.send"))}"
          >
            ${
              isBusy
                ? `<svg class="composer-action-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                  </svg>`
                : `<svg class="composer-action-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M3.4 20.4 21 12 3.4 3.6l-.8 6.2 12.2 2.2-12.2 2.2.8 6.2Z"
                    />
                  </svg>`
            }
          </button>
        </div>
      </div>
    </div>
  `;
}

export function bindComposerInputControls({ detailState, onRender }) {
  activeComposerContext = { detailState, onRender };
  bindComposerMetaControls(detailState);
  bindComposerEnvironmentControls(detailState, onRender);
  if (detailState.composerEnvironmentMenuOpen) {
    window.requestAnimationFrame(() => positionComposerEnvironmentPopover());
  }
}

export function adjustComposerHeight(el) {
  if (!el) {
    return;
  }

  const computed = window.getComputedStyle(el);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 24;
  const minPx = Math.ceil(lineHeight);
  const maxPx = 176;

  el.style.overflowY = "hidden";
  el.style.height = "auto";
  const targetHeight = Math.max(minPx, Math.min(el.scrollHeight, maxPx));
  el.style.height = `${targetHeight}px`;
  el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
}
