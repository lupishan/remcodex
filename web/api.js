const headers = {
  "Content-Type": "application/json",
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const data = await safeJson(response);
    throw new Error(data?.error ?? `Request failed: ${response.status}`);
  }

  return safeJson(response);
}

async function safeJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function getProjects() {
  return request("/api/projects");
}

export function createProject(payload) {
  return request("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function browseProjectDirectories(pathValue = "") {
  const query = pathValue ? `?path=${encodeURIComponent(pathValue)}` : "";
  return request(`/api/projects/browse${query}`);
}

export function getSessions() {
  return request("/api/sessions");
}

export function createSession(payload) {
  return request("/api/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function importCodexSession(payload) {
  return request("/api/sessions/import-codex", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getSession(sessionId) {
  return request(`/api/sessions/${sessionId}`);
}

export function syncImportedSession(sessionId) {
  return request(`/api/sessions/${sessionId}/sync`, {
    method: "POST",
  });
}

export function getSessionEvents(sessionId, options = 0) {
  const search = new URLSearchParams();

  if (typeof options === "number") {
    if (options > 0) {
      search.set("after", String(options));
    }
  } else if (options && typeof options === "object") {
    if (options.after) {
      search.set("after", String(options.after));
    }
    if (options.before) {
      search.set("before", String(options.before));
    }
    if (options.limit) {
      search.set("limit", String(options.limit));
    }
  }

  const query = search.toString();
  return request(`/api/sessions/${sessionId}/events${query ? `?${query}` : ""}`);
}

export function getSessionTimeline(sessionId, options = 0) {
  const search = new URLSearchParams();

  if (typeof options === "number") {
    if (options > 0) {
      search.set("after", String(options));
    }
  } else if (options && typeof options === "object") {
    if (options.after) {
      search.set("after", String(options.after));
    }
    if (options.before) {
      search.set("before", String(options.before));
    }
    if (options.limit) {
      search.set("limit", String(options.limit));
    }
  }

  const query = search.toString();
  return request(`/api/sessions/${sessionId}/timeline${query ? `?${query}` : ""}`);
}

export function getSessionTimelineEvents(sessionId, options = 0) {
  return getSessionTimeline(sessionId, options);
}

export function sendMessage(sessionId, payload) {
  return request(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function stopSession(sessionId) {
  return request(`/api/sessions/${sessionId}/stop`, {
    method: "POST",
  });
}

export function resolveSessionApproval(sessionId, requestId, decision) {
  return request(`/api/sessions/${sessionId}/approvals/${encodeURIComponent(requestId)}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}

export function getHealth() {
  return request("/health");
}

export function getCodexUiOptions() {
  return request("/api/codex/mode");
}

export function getCodexStatus(params = {}) {
  const search = new URLSearchParams();
  if (params.sessionId) {
    search.set("sessionId", params.sessionId);
  }
  if (params.threadId) {
    search.set("threadId", params.threadId);
  }
  if (params.cwd) {
    search.set("cwd", params.cwd);
  }

  const query = search.toString();
  return request(`/api/codex/status${query ? `?${query}` : ""}`);
}

export function getCodexQuota(sessionId) {
  return request(`/api/codex/quota?sessionId=${encodeURIComponent(sessionId)}`);
}

export function getCodexHosts() {
  return request("/api/codex/hosts");
}

export function getImportableCodexSessions() {
  return request("/api/codex/importable-sessions");
}
