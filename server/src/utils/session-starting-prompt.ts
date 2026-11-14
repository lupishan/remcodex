export function normalizeSessionStartingPrompt(value: string | null | undefined): string {
  return String(value || "").trim();
}

export function composeMessageContentWithStartingPrompt(
  content: string | null | undefined,
  startingPrompt: string | null | undefined,
): string {
  const prompt = normalizeSessionStartingPrompt(startingPrompt);
  const userContent = String(content || "").trim();
  if (!prompt) {
    return userContent;
  }
  if (!userContent) {
    return prompt;
  }
  return `${prompt}\n\n${userContent}`;
}
