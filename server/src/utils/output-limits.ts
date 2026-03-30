export const MAX_PERSISTED_COMMAND_STREAM_CHARS = 80 * 1024;
export const COMMAND_STREAM_TRUNCATION_NOTICE = "\n\n[command output truncated]\n";

interface AppendCappedTextOptions {
  maxChars?: number;
  notice?: string;
}

export interface AppendCappedTextResult {
  nextText: string;
  appendedText: string;
  truncated: boolean;
}

function normalizeMaxChars(maxChars: number | undefined, notice: string): number {
  const numeric = Number(maxChars || MAX_PERSISTED_COMMAND_STREAM_CHARS);
  if (!Number.isFinite(numeric) || numeric <= notice.length + 1) {
    return MAX_PERSISTED_COMMAND_STREAM_CHARS;
  }
  return Math.trunc(numeric);
}

export function appendCappedText(
  currentText: string,
  nextDelta: string,
  options: AppendCappedTextOptions = {},
): AppendCappedTextResult {
  const notice = String(options.notice || COMMAND_STREAM_TRUNCATION_NOTICE);
  const safeCurrent = String(currentText || "");
  const safeDelta = String(nextDelta || "");
  if (!safeDelta) {
    return {
      nextText: safeCurrent,
      appendedText: "",
      truncated: false,
    };
  }

  const maxChars = normalizeMaxChars(options.maxChars, notice);
  const contentLimit = Math.max(0, maxChars - notice.length);

  if (safeCurrent.endsWith(notice) || safeCurrent.length >= maxChars) {
    return {
      nextText: safeCurrent.length > maxChars ? safeCurrent.slice(0, maxChars) : safeCurrent,
      appendedText: "",
      truncated: true,
    };
  }

  if (safeCurrent.length >= contentLimit) {
    return {
      nextText: `${safeCurrent.slice(0, contentLimit)}${notice}`,
      appendedText: notice,
      truncated: true,
    };
  }

  if (safeCurrent.length + safeDelta.length <= contentLimit) {
    return {
      nextText: safeCurrent + safeDelta,
      appendedText: safeDelta,
      truncated: false,
    };
  }

  const available = Math.max(0, contentLimit - safeCurrent.length);
  const preserved = safeDelta.slice(0, available);
  const appendedText = `${preserved}${notice}`;
  return {
    nextText: `${safeCurrent}${appendedText}`,
    appendedText,
    truncated: true,
  };
}

export function capTextValue(
  text: string,
  options: AppendCappedTextOptions = {},
): {
  text: string;
  truncated: boolean;
} {
  const notice = String(options.notice || COMMAND_STREAM_TRUNCATION_NOTICE);
  const safeText = String(text || "");
  const maxChars = normalizeMaxChars(options.maxChars, notice);
  const contentLimit = Math.max(0, maxChars - notice.length);

  if (safeText.length <= contentLimit) {
    return {
      text: safeText,
      truncated: false,
    };
  }

  return {
    text: `${safeText.slice(0, contentLimit)}${notice}`,
    truncated: true,
  };
}
