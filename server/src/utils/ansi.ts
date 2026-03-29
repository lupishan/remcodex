interface NormalizedTerminalOutput {
  content: string;
  rest: string;
}

export function stripAnsi(value: string): string {
  return normalizeTerminalOutput(value).content;
}

export function normalizeTerminalOutput(value: string): NormalizedTerminalOutput {
  const { content, rest } = stripTerminalSequences(value);
  return {
    content: applyTerminalControls(content),
    rest,
  };
}

function stripTerminalSequences(value: string): NormalizedTerminalOutput {
  let index = 0;
  let output = "";

  while (index < value.length) {
    const current = value.charCodeAt(index);

    if (current === 0x1b) {
      const nextIndex = consumeEscapeSequence(value, index);
      if (nextIndex === -1) {
        break;
      }

      index = nextIndex;
      continue;
    }

    if (current === 0x9b) {
      const nextIndex = consumeCsi(value, index + 1);
      if (nextIndex === -1) {
        break;
      }

      index = nextIndex;
      continue;
    }

    output += value[index];
    index += 1;
  }

  return {
    content: output,
    rest: value.slice(index),
  };
}

function consumeEscapeSequence(value: string, start: number): number {
  const next = value[start + 1];
  if (!next) {
    return -1;
  }

  switch (next) {
    case "[":
      return consumeCsi(value, start + 2);
    case "]":
      return consumeOsc(value, start + 2);
    case "P":
    case "^":
    case "_":
      return consumeStTerminated(value, start + 2);
    case "(":
    case ")":
    case "*":
    case "+":
    case "-":
    case ".":
    case "/":
      return start + 3 <= value.length ? start + 3 : -1;
    default:
      return start + 2;
  }
}

function consumeCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index + 1;
    }
  }

  return -1;
}

function consumeOsc(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x07) {
      return index + 1;
    }

    if (code === 0x1b) {
      if (index + 1 >= value.length) {
        return -1;
      }

      if (value[index + 1] === "\\") {
        return index + 2;
      }
    }
  }

  return -1;
}

function consumeStTerminated(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x9c) {
      return index + 1;
    }

    if (code === 0x1b) {
      if (index + 1 >= value.length) {
        return -1;
      }

      if (value[index + 1] === "\\") {
        return index + 2;
      }
    }
  }

  return -1;
}

function applyTerminalControls(value: string): string {
  const lines = [""];

  for (const char of value.replace(/\r\n/g, "\n")) {
    const lineIndex = lines.length - 1;

    switch (char) {
      case "\n":
        lines.push("");
        break;
      case "\r":
        lines[lineIndex] = "";
        break;
      case "\b":
        lines[lineIndex] = lines[lineIndex].slice(0, -1);
        break;
      case "\t":
        lines[lineIndex] += "\t";
        break;
      default: {
        const code = char.charCodeAt(0);
        if ((code >= 0x20 && code !== 0x7f) || code >= 0xa0) {
          lines[lineIndex] += char;
        }
      }
    }
  }

  return lines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
