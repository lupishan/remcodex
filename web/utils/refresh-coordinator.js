export function shouldRefreshVisibleDetail(now, lastRefreshAt, minimumIntervalMs = 900) {
  return Number(now) - Number(lastRefreshAt || 0) >= minimumIntervalMs;
}

export function hasWarmWorkspaceCache(sessions, projects) {
  return Array.isArray(sessions) && Array.isArray(projects) && (sessions.length > 0 || projects.length > 0);
}
