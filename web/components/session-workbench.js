import { t } from "../i18n/index.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getCompactMobileTitle(title) {
  const text = String(title || "").trim();
  if (!text) {
    return t("session.current");
  }
  return text.length > 10 ? `${text.slice(0, 10)}…` : text;
}

export function renderSessionTopBar({
  title,
  statusCode = "",
  statusLabel,
  statusClass,
  activityBadges = [],
  host,
  model,
  reasoning,
  sessionElapsedLabel,
  activeElapsedLabel,
  inspectOpen,
  showInspectAction = true,
  backHref = "",
}) {
  const mobilePrimaryLabel =
    statusCode === "waiting_input" || statusCode === "idle" || statusCode === "completed"
      ? getCompactMobileTitle(title)
      : statusLabel || t("session.status.unknown");

  return `
    <section class="session-topbar" aria-label="${escapeHtml(t("generic.status"))}">
      <div class="session-topbar-mobile-bar">
        ${
          backHref
            ? `<a href="${escapeHtml(backHref)}" class="session-topbar-mobile-back">${escapeHtml(t("session.back"))}</a>`
            : `<span class="session-topbar-mobile-back session-topbar-mobile-back-placeholder"></span>`
        }
        <div class="session-topbar-mobile-center">
          <div class="session-topbar-mobile-status-row">
            <div class="session-topbar-mobile-status">${escapeHtml(mobilePrimaryLabel)}</div>
              ${
                activeElapsedLabel
                ? `<div id="session-mobile-active-elapsed" class="session-topbar-mobile-elapsed">${escapeHtml(activeElapsedLabel)}</div>`
                : ""
              }
          </div>
        </div>
        ${
          showInspectAction
            ? `
              <button
                id="inspect-drawer-toggle"
                type="button"
                class="secondary-button session-topbar-mobile-action ${inspectOpen ? "session-topbar-action-active" : ""}"
                aria-expanded="${inspectOpen ? "true" : "false"}"
                aria-controls="inspect-drawer"
              >
                Inspect
              </button>
            `
            : `<span class="session-topbar-mobile-action session-topbar-mobile-action-placeholder"></span>`
        }
      </div>
      <div class="session-topbar-main">
        <h2 class="session-topbar-title">${escapeHtml(title || t("workspace.session.untitled"))}</h2>
        <div class="session-topbar-statuses">
          <span class="pill ${escapeHtml(statusClass || "pill-neutral")}">${escapeHtml(statusLabel || t("session.status.unknown"))}</span>
          ${activityBadges
            .map(
              (badge) => `
                <span class="session-topbar-live-badge session-topbar-live-badge-${escapeHtml(badge.tone || "neutral")}">
                  ${escapeHtml(badge.label || "")}
                </span>
              `,
            )
            .join("")}
        </div>
      </div>
      <div class="session-topbar-meta">
        <span class="session-topbar-chip">${escapeHtml(host || t("session.host.unsynced"))}</span>
        <span class="session-topbar-chip">${escapeHtml(model || t("session.model.unsynced"))}</span>
        <span class="session-topbar-chip">${escapeHtml(reasoning || t("session.reasoning.unsynced"))}</span>
        <span id="session-elapsed-chip" class="session-topbar-chip">
          ${escapeHtml(sessionElapsedLabel || t("session.elapsed", { value: "--" }))}
        </span>
        ${
          activeElapsedLabel
            ? `
              <span id="session-active-elapsed-chip" class="session-topbar-chip session-topbar-chip-active">
                ${escapeHtml(activeElapsedLabel)}
              </span>
            `
            : ""
        }
      </div>
      ${
        showInspectAction
          ? `
            <button
              id="inspect-drawer-toggle"
              type="button"
              class="secondary-button session-topbar-action ${inspectOpen ? "session-topbar-action-active" : ""}"
              aria-expanded="${inspectOpen ? "true" : "false"}"
              aria-controls="inspect-drawer"
            >
              Inspect
            </button>
          `
          : ""
      }
    </section>
  `;
}

export function renderInspectDrawer({
  open,
  selectionTitle,
  searchSectionHtml,
  detailsSectionHtml,
  sessionSectionHtml,
}) {
  return `
    <div
      id="inspect-drawer-overlay"
      class="inspect-drawer-overlay ${open ? "inspect-drawer-overlay-open" : ""}"
      ${open ? "" : "hidden"}
    ></div>
    <aside
      id="inspect-drawer"
      class="inspect-drawer ${open ? "inspect-drawer-open" : ""}"
      aria-label="Inspect"
      ${open ? "" : "hidden"}
    >
      <div class="inspect-drawer-head">
        <div>
          <p class="inspect-drawer-eyebrow">Inspect</p>
          <h3 class="inspect-drawer-title">${escapeHtml(selectionTitle || t("inspect.selectionTitle"))}</h3>
        </div>
        <button id="inspect-drawer-close" type="button" class="secondary-button">${escapeHtml(t("inspect.close"))}</button>
      </div>
      <div class="inspect-drawer-body">
        <section class="inspect-drawer-section">
          <div class="inspect-section-head">
            <span class="inspect-section-title">Search</span>
          </div>
          ${searchSectionHtml}
        </section>
        <section class="inspect-drawer-section">
          <div class="inspect-section-head">
            <span class="inspect-section-title">Details</span>
          </div>
          ${detailsSectionHtml}
        </section>
        <section class="inspect-drawer-section">
          <div class="inspect-section-head">
            <span class="inspect-section-title">Session</span>
          </div>
          ${sessionSectionHtml}
        </section>
      </div>
    </aside>
  `;
}
