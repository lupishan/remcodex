#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const playwrightCorePath = process.env.PLAYWRIGHT_CORE_PATH || "playwright-core";
const { chromium } = require(playwrightCorePath);

const baseUrl = process.env.REMCODEX_BASE_URL || "http://127.0.0.1:18840";
const chromiumBin = process.env.CHROMIUM_BIN || "chromium";
const turnCount = readPositiveInt(process.env.REMCODEX_TURN_COUNT, 150);
const timeoutMs = readPositiveInt(process.env.REMCODEX_REPLY_TIMEOUT_MS, 12000);
const artifactDir = process.env.REMCODEX_ARTIFACT_DIR || "/tmp/remcodex-debug-output";
const projectPath = process.env.REMCODEX_PROJECT_PATH || "/workspace/e2e-project";
const projectName = process.env.REMCODEX_PROJECT_NAME || "remcodex-e2e";
const expectedStreamMode = process.env.REMCODEX_EXPECT_STREAM_MODE || "delta";

async function main() {
  await fs.mkdir(artifactDir, { recursive: true });
  const health = await requestJson("/health");
  await writeJson("health.json", health);

  const project = await requestJson("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: projectName,
      path: projectPath,
      createMissing: true,
    }),
  });
  const session = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: project.projectId,
      title: "Debug output e2e session",
    }),
  });

  const browser = await chromium.launch({
    executablePath: chromiumBin,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();
  const consoleLines = [];
  const pageErrors = [];

  page.on("console", (message) => {
    consoleLines.push(`[${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(String(error && error.stack ? error.stack : error));
  });

  try {
    await page.goto(`${baseUrl}/#/sessions/${session.sessionId}`, {
      waitUntil: "networkidle",
      timeout: timeoutMs,
    });
    await page.waitForSelector('textarea[name="content"]', { timeout: timeoutMs });

    const prompts = [];

    for (let index = 1; index <= turnCount; index += 1) {
      const marker = `turn-${index}-marker-${String(index).padStart(4, "0")}`;
      const prompt = `Repeated reply visibility check ${marker}`;
      const expectedReply = `Mock reply mock-turn-${index}: ${prompt}`;
      prompts.push({ index, prompt, expectedReply });

      await page.fill('textarea[name="content"]', prompt);
      await page.waitForFunction(() => {
        const action = document.querySelector("#composer-action");
        return action instanceof HTMLButtonElement && !action.disabled;
      }, { timeout: timeoutMs });
      await page.click("#composer-action");

      try {
        await page.waitForFunction(
          (replyText) => document.body.innerText.includes(replyText),
          expectedReply,
          { timeout: timeoutMs },
        );
        await page.waitForFunction(
          (expectedReplies) => {
            const rows = Array.from(document.querySelectorAll(".timeline-row-final .msg-bubble-body"));
            const texts = rows
              .map((row) => String(row.textContent || "").replace(/\s+/g, " ").trim())
              .filter(Boolean);
            if (texts.length < expectedReplies.length) {
              return false;
            }
            return expectedReplies.every((reply, index) => texts[index] === reply);
          },
          prompts.map((entry) => entry.expectedReply),
          { timeout: timeoutMs },
        );
      } catch (error) {
        await captureFailure(page, consoleLines, pageErrors, {
          status: "missing-reply",
          failedTurn: index,
          prompt,
          expectedReply,
          prompts,
          error: String(error && error.stack ? error.stack : error),
        });
        throw error;
      }

      await page.waitForFunction(() => {
        const action = document.querySelector("#composer-action");
        return (
          action instanceof HTMLButtonElement &&
          action.classList.contains("composer-action-fab--send") &&
          action.getAttribute("aria-label") === "Send"
        );
      }, { timeout: timeoutMs });
    }

    const timeline = await requestJson(`/api/sessions/${session.sessionId}/timeline?limit=1000`);
    const finalReplies = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".timeline-row-final .msg-bubble-body"))
        .map((row) => String(row.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    );
    await writeJson("summary.json", {
      status: "ok",
      expectedStreamMode,
      turnCount,
      sessionId: session.sessionId,
      projectId: project.projectId,
      projectPath,
      timelineCount: Array.isArray(timeline.items) ? timeline.items.length : 0,
      prompts,
      finalReplies,
      consoleLines,
      pageErrors,
    });
  } finally {
    await browser.close();
  }
}

async function captureFailure(page, consoleLines, pageErrors, summary) {
  await writeJson("summary.json", {
    ...summary,
    consoleLines,
    pageErrors,
  });
  await fs.writeFile(path.join(artifactDir, "page.html"), await page.content(), "utf8");
  await page.screenshot({
    path: path.join(artifactDir, "failure.png"),
    fullPage: true,
  });
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data && data.error ? data.error : `Request failed for ${pathname}: ${response.status}`);
  }

  return data;
}

function readPositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function writeJson(name, value) {
  await fs.writeFile(
    path.join(artifactDir, name),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

main().catch(async (error) => {
  await writeJson("fatal.json", {
    error: String(error && error.stack ? error.stack : error),
  }).catch(() => null);
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
