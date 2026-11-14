const list = document.querySelector("#directory-list");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderInstances(instances) {
  if (!instances.length) {
    list.innerHTML = '<p class="directory-message">No RemCodex workspaces are configured.</p>';
    return;
  }

  list.innerHTML = instances
    .map(
      (instance) => `
        <a class="directory-card" href="${escapeHtml(instance.url)}">
          <div class="directory-card-mark" aria-hidden="true">↗</div>
          <div class="directory-card-copy">
            <h2>${escapeHtml(instance.name)}</h2>
            ${instance.description ? `<p>${escapeHtml(instance.description)}</p>` : ""}
            <span>${escapeHtml(instance.url)}</span>
          </div>
        </a>
      `,
    )
    .join("");
}

async function loadDirectory() {
  try {
    const response = await fetch("/api/directory/instances");
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    const payload = await response.json();
    renderInstances(Array.isArray(payload.items) ? payload.items : []);
  } catch (error) {
    list.innerHTML = `<p class="directory-message directory-message-error">Unable to load the RemCodex directory.</p>`;
    console.error(error);
  }
}

loadDirectory();
