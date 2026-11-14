export function normalizeSessionStartingPrompt(value) {
  return String(value || "").trim();
}

export function composeMessageContentWithStartingPrompt(content, startingPrompt) {
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
