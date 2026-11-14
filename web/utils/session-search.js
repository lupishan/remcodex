export function normalizeSessionSearchKeyword(value) {
  return String(value || "").trim().toLowerCase();
}

export function sessionMatchesSearch(session, project, keyword) {
  const normalizedKeyword = normalizeSessionSearchKeyword(keyword);
  if (!normalizedKeyword) {
    return true;
  }

  const haystacks = [
    session?.title,
    session?.projectId,
    project?.name,
    session?.status,
    session?.lastAssistantContent,
    session?.lastCommand,
    session?.codexThreadId,
  ];

  return haystacks.some((value) => String(value || "").toLowerCase().includes(normalizedKeyword));
}
