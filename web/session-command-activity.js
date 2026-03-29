import { formatInlineList, t } from "./i18n/index.js";

function stripShellWrapper(command) {
  let current = String(command || "").trim();

  while (true) {
    const match = current.match(
      /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/,
    );
    if (!match) {
      return current;
    }
    current = match[2].trim();
  }
}

function tokenizeShell(command) {
  const source = stripShellWrapper(command);
  const tokens = [];
  let current = "";
  let quote = "";
  let escapeNext = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function getCommandContext(command) {
  const normalized = stripShellWrapper(command);
  const tokens = tokenizeShell(command);
  let offset = 0;

  while (
    offset < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[offset] || "")
  ) {
    offset += 1;
  }

  if (tokens[offset] === "env") {
    offset += 1;
    while (
      offset < tokens.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[offset] || "")
    ) {
      offset += 1;
    }
  }

  const primary = tokens[offset] || "";
  const commandName = basename(primary);
  const subcommand = commandName === "git" ? tokens[offset + 1] || "" : "";

  return {
    normalized,
    tokens,
    offset,
    primary,
    commandName,
    subcommand,
  };
}

function isOptionToken(token) {
  return /^-/.test(token || "");
}

function isLikelyPathToken(token) {
  if (!token || isOptionToken(token)) {
    return false;
  }

  if (/^\d+$/.test(token)) {
    return false;
  }

  if (
    token === "|" ||
    token === "||" ||
    token === "&&" ||
    token === ">" ||
    token === ">>" ||
    token === "<"
  ) {
    return false;
  }

  return true;
}

function pushUnique(list, value) {
  if (!value || list.includes(value)) {
    return;
  }
  list.push(value);
}

function basename(path) {
  const value = String(path || "").replace(/\/+$/, "");
  if (!value) {
    return "";
  }
  const parts = value.split("/");
  return parts[parts.length - 1] || value;
}

function extractSearchFiles(tokens, startIndex, options = {}) {
  const consumingOptions = new Set(options.consumingOptions || []);
  const patternOptions = new Set(options.patternOptions || []);
  let patternConsumed = false;
  const files = [];
  let stopOptionParsing = false;

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (token === "--") {
      stopOptionParsing = true;
      continue;
    }

    if (!stopOptionParsing && isOptionToken(token)) {
      const optionName = token.includes("=") ? token.split("=")[0] : token;
      if (patternOptions.has(optionName)) {
        patternConsumed = true;
      }
      if (consumingOptions.has(optionName) && !token.includes("=")) {
        index += 1;
      }
      continue;
    }

    if (!patternConsumed) {
      patternConsumed = true;
      continue;
    }
    if (isLikelyPathToken(token)) {
      pushUnique(files, token);
    }
  }

  return files;
}

function extractBrowseFiles(context) {
  const { primary, tokens, offset } = context;
  const files = [];

  if (["sed", "cat", "head", "tail", "nl", "wc", "stat"].includes(primary)) {
    for (let index = tokens.length - 1; index > offset; index -= 1) {
      const token = tokens[index];
      if (isLikelyPathToken(token)) {
        pushUnique(files, token);
        break;
      }
    }
    return files;
  }

  if (primary === "ls" || primary === "tree") {
    for (let index = offset + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (isLikelyPathToken(token)) {
        pushUnique(files, token);
      }
    }
    return files;
  }

  return files;
}

function extractEditFiles(context) {
  const { primary, tokens, offset } = context;
  const files = [];

  if (primary === "touch") {
    for (let index = offset + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (isLikelyPathToken(token)) {
        pushUnique(files, token);
      }
    }
    return files;
  }

  if (primary === "sed" && tokens.includes("-i")) {
    for (let index = tokens.length - 1; index > offset; index -= 1) {
      const token = tokens[index];
      if (isLikelyPathToken(token)) {
        pushUnique(files, token);
        break;
      }
    }
    return files;
  }

  if (primary === "apply_patch") {
    return files;
  }

  return files;
}

function countPatchStatsFromText(text) {
  const lines = String(text || "").split("\n");
  let added = 0;
  let removed = 0;

  lines.forEach((line) => {
    if (line.startsWith("+++")) {
      return;
    }
    if (line.startsWith("---")) {
      return;
    }
    if (line.startsWith("+")) {
      added += 1;
      return;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  });

  return { added, removed };
}

function collectPatchFileStats(item) {
  const changes =
    item?.changes && typeof item.changes === "object" ? item.changes : {};
  const fileStats = [];

  Object.entries(changes).forEach(([path, change]) => {
    const added = Number(change?.added || 0);
    const removed = Number(change?.removed || 0);
    fileStats.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
    });
  });

  if (fileStats.length > 0) {
    return fileStats;
  }

  const patchText = String(item?.patchText || "");
  if (!patchText) {
    return [];
  }

  const fileMap = new Map();
  let currentPath = null;

  function ensureFile(path) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath || normalizedPath === "/dev/null") {
      return null;
    }
    const existing = fileMap.get(normalizedPath) || {
      path: normalizedPath,
      added: 0,
      removed: 0,
    };
    fileMap.set(normalizedPath, existing);
    return existing;
  }

  patchText.split("\n").forEach((line) => {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      currentPath = diffMatch[2];
      ensureFile(currentPath);
      return;
    }

    const nextFileMatch = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (nextFileMatch && nextFileMatch[1] !== "/dev/null") {
      currentPath = nextFileMatch[1];
      ensureFile(currentPath);
      return;
    }

    if (line.startsWith("@@")) {
      ensureFile(currentPath);
      return;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const current = ensureFile(currentPath);
      if (current) {
        current.added += 1;
      }
      return;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      const current = ensureFile(currentPath);
      if (current) {
        current.removed += 1;
      }
    }
  });

  if (fileMap.size === 0) {
    currentPath = null;
    patchText.split("\n").forEach((line) => {
      const patchFileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
      if (patchFileMatch) {
        currentPath = patchFileMatch[1].trim();
        ensureFile(currentPath);
        return;
      }

      if (!currentPath) {
        return;
      }

      if (line.startsWith("*** ")) {
        currentPath = null;
        return;
      }

      if (line.startsWith("+")) {
        const current = ensureFile(currentPath);
        if (current) {
          current.added += 1;
        }
        return;
      }

      if (line.startsWith("-")) {
        const current = ensureFile(currentPath);
        if (current) {
          current.removed += 1;
        }
      }
    });
  }

  return Array.from(fileMap.values());
}

function collectPatchFileStatsFromOutput(item) {
  const output = String(item?.output || item?.stdout || "");
  if (!output) {
    return [];
  }

  const fileMap = new Map();
  const lines = output.split("\n");
  lines.forEach((line) => {
    const match = line.match(/^[AMD]\s+(.+)$/);
    if (!match) {
      return;
    }
    const path = match[1].trim();
    if (!path) {
      return;
    }
    fileMap.set(path, {
      path,
      added: 0,
      removed: 0,
    });
  });

  return Array.from(fileMap.values());
}

function collectFileStatsForItem(item, classification) {
  if (item?.type === "patch" || classification.kind === "edit") {
    const fileStats = collectPatchFileStats(item);
    if (fileStats.length > 0) {
      return fileStats;
    }
    const outputFileStats = collectPatchFileStatsFromOutput(item);
    if (outputFileStats.length > 0) {
      return outputFileStats;
    }
  }

  return (classification.files || []).map((path) => ({
    path,
    added: 0,
    removed: 0,
  }));
}

function getOutputLength(item) {
  return [
    item?.output,
    item?.stdout,
    item?.stderr,
    item?.patchText,
  ]
    .map((value) => String(value || ""))
    .join("")
    .length;
}

function hasFailureLikeOutput(item) {
  const output = [item?.output, item?.stdout, item?.stderr, item?.patchText]
    .map((value) => String(value || ""))
    .join("\n");

  if (!output.trim()) {
    return false;
  }

  return false;
}

function getDurationMs(item) {
  const value = Number(item?.durationMs ?? item?.duration ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1000) {
    return value;
  }
  return value * 1000;
}

export function extractCommandFiles(command) {
  const context = getCommandContext(command);
  const { primary, commandName, subcommand, offset, tokens } = context;

  if (!primary) {
    return [];
  }

  if (commandName === "git" && subcommand === "grep") {
    return extractSearchFiles(tokens, offset + 2, {
      consumingOptions: [
        "-e",
        "-f",
        "-m",
        "-A",
        "-B",
        "-C",
        "--exclude",
        "--exclude-from",
        "--exclude-dir",
        "--include",
      ],
      patternOptions: ["-e", "-f"],
    });
  }

  if (["rg", "grep", "fd"].includes(commandName)) {
    return extractSearchFiles(tokens, offset + 1, {
      consumingOptions:
        commandName === "fd"
          ? ["-e", "-E", "-x", "-X", "-g", "-t", "-T", "--glob", "--type", "--exclude"]
          : [
              "-e",
              "-f",
              "-g",
              "-t",
              "-T",
              "-m",
              "-M",
              "--glob",
              "--type",
              "--type-not",
              "--max-count",
              "--max-filesize",
              "--ignore-file",
              "--pre",
              "--replace",
              "--sort",
              "--sortr",
              "--colors",
            ],
      patternOptions:
        commandName === "fd" ? ["-g", "--glob"] : ["-e", "-f"],
    });
  }

  if (commandName === "find") {
    for (let index = offset + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (isLikelyPathToken(token) && !isOptionToken(token)) {
        return [token];
      }
    }
    return [];
  }

  if (
    ["sed", "cat", "head", "tail", "nl", "wc", "stat", "ls", "tree"].includes(commandName)
  ) {
    return extractBrowseFiles(context);
  }

  if (["touch"].includes(commandName) || (commandName === "sed" && tokens.includes("-i"))) {
    return extractEditFiles(context);
  }

  return [];
}

export function classifyCommandActivity(item) {
  if (!item) {
    return {
      kind: "unknown",
      important: true,
      files: [],
      searchCount: 0,
      browseCount: 0,
      summaryLabel: "",
      stats: { added: 0, removed: 0 },
    };
  }

  if (item.type === "patch") {
    const fileStats =
      collectPatchFileStats(item).length > 0
        ? collectPatchFileStats(item)
        : collectPatchFileStatsFromOutput(item);
    const files = fileStats.map((entry) => entry.path);
    const stats = fileStats.reduce(
      (acc, entry) => ({
        added: acc.added + entry.added,
        removed: acc.removed + entry.removed,
      }),
      { added: 0, removed: 0 },
    );
    const classification = {
      kind: "edit",
      important: false,
      files,
      searchCount: 0,
      browseCount: 0,
      summaryLabel:
        files.length > 1
          ? t("activity.edit.multiple", { count: files.length })
          : t("activity.edit.single"),
      stats,
    };
    classification.important = isImportantCommandActivity(item, classification);
    return classification;
  }

  const context = getCommandContext(item.command || "");
  const { primary, commandName, subcommand, normalized, tokens, offset } = context;
  const files = extractCommandFiles(item.command || "");
  let kind = "unknown";
  let searchCount = 0;
  let browseCount = 0;
  let summaryLabel = "";
  let stats = { added: 0, removed: 0 };

  if (commandName === "git" && subcommand === "grep") {
    kind = "search";
  } else if (["rg", "grep", "fd"].includes(commandName)) {
    kind = "search";
  } else if (commandName === "find" && /(?:^|\s)find(?:\s|$)/.test(normalized)) {
    kind = "search";
  } else if (
    ["sed", "cat", "head", "tail", "nl", "ls", "tree", "wc", "stat"].includes(commandName)
  ) {
    kind = "browse";
  } else if (
    (commandName === "node" && tokens.includes("--check")) ||
    (commandName === "tsc" && tokens.includes("--noEmit")) ||
    commandName === "eslint" ||
    (commandName === "prettier" && tokens.includes("--check")) ||
    commandName === "vitest" ||
    commandName === "jest" ||
    ((commandName === "npm" || commandName === "pnpm") && tokens[offset + 1] === "test")
  ) {
    kind = "validation";
  } else if (commandName === "apply_patch") {
    kind = "edit";
  } else if (commandName === "touch" || (commandName === "sed" && tokens.includes("-i"))) {
    kind = "edit";
  } else if (commandName === "git") {
    kind = "git";
  } else if (primary) {
    kind = "run";
  }

  if (kind === "search") {
    searchCount = 1;
    summaryLabel = t("activity.search");
  } else if (kind === "browse") {
    browseCount = files.length || 1;
    summaryLabel =
      files.length > 1
        ? t("activity.browse.multiple", { count: files.length })
        : t("activity.browse.single");
  } else if (kind === "edit") {
    const fileStats = collectFileStatsForItem(item, { kind, files });
    files.splice(0, files.length, ...fileStats.map((entry) => entry.path));
    stats = fileStats.reduce(
      (acc, entry) => ({
        added: acc.added + entry.added,
        removed: acc.removed + entry.removed,
      }),
      { added: 0, removed: 0 },
    );
    summaryLabel =
      files.length > 1
        ? t("activity.edit.multiple", { count: files.length })
        : t("activity.edit.single");
  } else if (kind === "validation") {
    summaryLabel = t("activity.validation.completed");
  }

  const classification = {
    kind,
    important: false,
    files,
    searchCount,
    browseCount,
    summaryLabel,
    stats,
  };
  classification.important = isImportantCommandActivity(item, classification);
  return classification;
}

export function isImportantCommandActivity(item, classification) {
  if (!item) {
    return true;
  }

  if (
    item.status === "running" ||
    item.outputStatus === "streaming" ||
    item.status === "awaiting_approval"
  ) {
    return true;
  }

  if (
    item.status === "failed" ||
    item.status === "rejected" ||
    item.success === false
  ) {
    return true;
  }

  if (Number.isFinite(Number(item.exitCode)) && Number(item.exitCode) !== 0) {
    return true;
  }

  if (String(item.stderr || "").trim()) {
    return true;
  }

  if (classification?.kind === "edit") {
    return classification.files.length === 0;
  }

  if (getOutputLength(item) > 800) {
    return true;
  }

  if (getDurationMs(item) > 8000) {
    return true;
  }

  if (!classification || ["unknown", "run", "git"].includes(classification.kind)) {
    return true;
  }

  return false;
}

function resolveDisplayState(item) {
  if (
    item?.status === "running" ||
    item?.outputStatus === "streaming" ||
    item?.status === "awaiting_approval"
  ) {
    return "running";
  }

  if (
    item?.status === "failed" ||
    item?.status === "rejected" ||
    item?.success === false ||
    hasFailureLikeOutput(item) ||
    String(item?.stderr || "").trim() ||
    (Number.isFinite(Number(item?.exitCode)) && Number(item.exitCode) !== 0)
  ) {
    return "failed";
  }

  return "completed";
}

function summarizePaths(paths) {
  const values = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0];
  }
  return `${values[0]} ${t("timeline.summary.moreItems", { count: values.length })}`;
}

export function resolveActivityDisplay(item, classification) {
  const kind = classification?.kind || "unknown";
  const state = resolveDisplayState(item);
  const titleMap = {
    edit: {
      running: t("activity.running.edit"),
      failed: t("activity.failed.edit"),
      completed: t("activity.completed.edit"),
    },
    search: {
      running: t("activity.running.search"),
      failed: t("activity.failed.search"),
      completed: t("activity.completed.search"),
    },
    browse: {
      running: t("activity.running.browse"),
      failed: t("activity.failed.browse"),
      completed: t("activity.completed.browse"),
    },
    validation: {
      running: t("activity.running.validation"),
      failed: t("activity.failed.validation"),
      completed: t("activity.completed.validation"),
    },
    git: {
      running: t("activity.running.git"),
      failed: t("activity.failed.git"),
      completed: t("activity.completed.git"),
    },
    run: {
      running: t("activity.running.run"),
      failed: t("activity.failed.run"),
      completed: t("activity.completed.run"),
    },
    unknown: {
      running: t("activity.running.run"),
      failed: t("activity.failed.run"),
      completed: t("activity.completed.run"),
    },
  };

  let subtitle = "";
  if (kind === "search") {
    subtitle = summarizePaths(classification?.files || []) || item?.cwd || "";
  } else if (kind === "browse" || kind === "edit") {
    subtitle = summarizePaths(classification?.files || []);
  } else if (kind === "validation") {
    subtitle = item?.cwd || "";
  }

  return {
    title: titleMap[kind]?.[state] || titleMap.unknown[state],
    subtitle,
    showRawCommandAsBody: item?.type === "command",
  };
}

function createActivityGroup(item, classification) {
  return {
    groupType: classification.kind === "edit" ? "file_change_summary" : "activity_summary",
    turnId: item.turnId || null,
    seq: item.seq,
    timestamp: item.timestamp,
    rawItems: [],
    browseFiles: [],
    browseCommandCount: 0,
    searchTargets: [],
    searchCount: 0,
    validationCount: 0,
    commandsCount: 0,
    files: [],
    fileMap: new Map(),
  };
}

function addToActivityGroup(group, item, classification) {
  group.rawItems.push(item);
  group.commandsCount += 1;

  if (group.groupType === "activity_summary") {
    if (classification.kind === "browse") {
      group.browseCommandCount += 1;
      classification.files.forEach((path) => pushUnique(group.browseFiles, path));
    }
    if (classification.kind === "search") {
      group.searchCount += Math.max(1, classification.searchCount || 0);
      const targets =
        classification.files.length > 0
          ? classification.files
          : item.cwd
            ? [item.cwd]
            : [];
      targets.forEach((path) => pushUnique(group.searchTargets, path));
    }
    if (classification.kind === "validation") {
      group.validationCount += 1;
      if (item.cwd) {
        pushUnique(group.searchTargets, item.cwd);
      }
    }
    return;
  }

  collectFileStatsForItem(item, classification).forEach((entry) => {
    const current = group.fileMap.get(entry.path) || {
      path: entry.path,
      added: 0,
      removed: 0,
    };
    current.added += entry.added;
    current.removed += entry.removed;
    group.fileMap.set(entry.path, current);
    if (!group.files.includes(entry.path)) {
      group.files.push(entry.path);
    }
  });
}

function buildActivitySummaryItem(group) {
  const browseCount = group.browseFiles.length || group.browseCommandCount;
  const titleParts = [];
  if (browseCount > 0) {
    titleParts.push(t("timeline.browse.completed", { count: browseCount }));
  }
  if (group.searchCount > 0) {
    titleParts.push(t("timeline.search.completed", { count: group.searchCount }));
  }
  if (group.validationCount > 0) {
    titleParts.push(t("timeline.validation.completed", { count: group.validationCount }));
  }
  let title = formatInlineList(titleParts);
  if (!title) {
    title = t("timeline.executedActivities", { count: group.commandsCount });
  }

  return {
    id: `activity-summary:${group.turnId || "none"}:${group.seq}`,
    type: "activity_summary",
    turnId: group.turnId,
    seq: group.seq,
    timestamp: group.timestamp,
    summary: {
      browseFiles: group.browseFiles,
      browseCount,
      searchTargets: group.searchTargets,
      searchCount: group.searchCount,
      validationCount: group.validationCount,
      commandsCount: group.commandsCount,
      title,
    },
    rawItems: group.rawItems,
  };
}

function buildFileChangeSummaryItem(group) {
  const files = group.files
    .map((path) => group.fileMap.get(path))
    .filter(Boolean);

  return {
    id: `file-change-summary:${group.turnId || "none"}:${group.seq}`,
    type: "file_change_summary",
    turnId: group.turnId,
    seq: group.seq,
    timestamp: group.timestamp,
    files,
    title: t("timeline.edit.completed", { count: files.length }),
    rawItems: group.rawItems,
  };
}

function flushGroup(result, group) {
  if (!group || group.rawItems.length === 0) {
    return;
  }

  if (group.groupType === "activity_summary") {
    result.push(buildActivitySummaryItem(group));
    return;
  }

  result.push(buildFileChangeSummaryItem(group));
}

export function groupTimelineActivities(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const result = [];
  let group = null;

  items.forEach((item) => {
    if (item?.type !== "command" && item?.type !== "patch") {
      flushGroup(result, group);
      group = null;
      result.push(item);
      return;
    }

    const classification = classifyCommandActivity(item);
    if (classification.important) {
      flushGroup(result, group);
      group = null;
      result.push(item);
      return;
    }

    const nextGroupType =
      classification.kind === "edit" ? "file_change_summary" : "activity_summary";

    if (
      !group ||
      group.groupType !== nextGroupType ||
      group.turnId !== (item.turnId || null)
    ) {
      flushGroup(result, group);
      group = createActivityGroup(item, classification);
    }

    addToActivityGroup(group, item, classification);
  });

  flushGroup(result, group);
  return result;
}

export { basename };
