#!/usr/bin/env node

const path = require("node:path");

const Database = require("better-sqlite3");

const MAX_PERSISTED_COMMAND_STREAM_CHARS = 80 * 1024;
const COMMAND_STREAM_TRUNCATION_NOTICE = "\n\n[command output truncated]\n";

function parseArgs(argv) {
  const options = {
    databasePath: "",
    sessionId: "",
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--db" || token === "--database") {
      options.databasePath = path.resolve(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (token === "--session") {
      options.sessionId = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
  }

  if (!options.databasePath) {
    throw new Error("Missing required --db <path>.");
  }

  return options;
}

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function capTextValue(text) {
  const safeText = String(text || "");
  const contentLimit = Math.max(
    0,
    MAX_PERSISTED_COMMAND_STREAM_CHARS - COMMAND_STREAM_TRUNCATION_NOTICE.length,
  );
  if (safeText.length <= contentLimit) {
    return {
      text: safeText,
      truncated: false,
    };
  }

  return {
    text: `${safeText.slice(0, contentLimit)}${COMMAND_STREAM_TRUNCATION_NOTICE}`,
    truncated: true,
  };
}

function aggregateCommandOutput(rows) {
  let stdout = "";
  let stderr = "";

  for (const row of rows) {
    const payload = safeJsonParse(row.payload_json, {});
    const textDelta = String(payload.textDelta || payload.text_delta || payload.text || "");
    if (!textDelta) {
      continue;
    }
    if (row.stream === "stderr") {
      stderr += textDelta;
    } else {
      stdout += textDelta;
    }
  }

  const cappedStdout = capTextValue(stdout);
  const cappedStderr = capTextValue(stderr);

  return {
    stdout: cappedStdout.text || null,
    stderr: cappedStderr.text || null,
    aggregatedOutput: cappedStdout.text || cappedStderr.text || null,
    stdoutTruncated: cappedStdout.truncated || undefined,
    stderrTruncated: cappedStderr.truncated || undefined,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(options.databasePath);

  const selectCalls = db.prepare(`
    SELECT
      session_id,
      call_id,
      COUNT(*) AS delta_count,
      COALESCE(SUM(LENGTH(payload_json)), 0) AS delta_bytes
    FROM session_events
    WHERE event_type = 'command.output.delta'
      AND call_id IS NOT NULL
      ${options.sessionId ? "AND session_id = @session_id" : ""}
    GROUP BY session_id, call_id
    ORDER BY delta_bytes DESC
  `);

  const selectDeltaRows = db.prepare(`
    SELECT id, stream, payload_json, created_at
    FROM session_events
    WHERE session_id = ?
      AND call_id = ?
      AND event_type = 'command.output.delta'
    ORDER BY seq ASC
  `);

  const selectCommandStart = db.prepare(`
    SELECT payload_json
    FROM session_events
    WHERE session_id = ?
      AND call_id = ?
      AND event_type = 'command.start'
    ORDER BY seq ASC
    LIMIT 1
  `);

  const selectCommandEnd = db.prepare(`
    SELECT id, payload_json
    FROM session_events
    WHERE session_id = ?
      AND call_id = ?
      AND event_type = 'command.end'
    ORDER BY seq DESC
    LIMIT 1
  `);

  const updateCommandEnd = db.prepare(`
    UPDATE session_events
    SET payload_json = ?
    WHERE id = ?
  `);

  const convertDeltaToCommandEnd = db.prepare(`
    UPDATE session_events
    SET event_type = 'command.end',
        stream = NULL,
        payload_json = ?
    WHERE id = ?
  `);

  const deleteDeltas = db.prepare(`
    DELETE FROM session_events
    WHERE session_id = ?
      AND call_id = ?
      AND event_type = 'command.output.delta'
  `);

  const candidates = selectCalls.all(
    options.sessionId ? { session_id: options.sessionId } : {},
  );

  let compactedCalls = 0;
  let deletedRows = 0;
  let reclaimedBytes = 0;
  let skippedCalls = 0;

  const run = db.transaction(() => {
    for (const candidate of candidates) {
      const commandEnd = selectCommandEnd.get(candidate.session_id, candidate.call_id);
      if (!commandEnd) {
        const deltaRows = selectDeltaRows.all(candidate.session_id, candidate.call_id);
        if (!deltaRows.length) {
          skippedCalls += 1;
          continue;
        }

        const commandStart = selectCommandStart.get(candidate.session_id, candidate.call_id);
        const startPayload = safeJsonParse(commandStart?.payload_json, {});
        const mergedPayload = {
          command: startPayload.command || null,
          cwd: startPayload.cwd || null,
          status: "completed",
          exitCode: null,
          durationMs: null,
          rejected: false,
          synthetic: true,
          ...aggregateCommandOutput(deltaRows),
        };
        const lastDelta = deltaRows[deltaRows.length - 1];

        if (!options.dryRun) {
          convertDeltaToCommandEnd.run(JSON.stringify(mergedPayload), lastDelta.id);
          db.prepare(
            `
              DELETE FROM session_events
              WHERE session_id = ?
                AND call_id = ?
                AND event_type = 'command.output.delta'
                AND id <> ?
            `,
          ).run(candidate.session_id, candidate.call_id, lastDelta.id);
        }

        compactedCalls += 1;
        deletedRows += Math.max(0, Number(candidate.delta_count || 0) - 1);
        reclaimedBytes += Number(candidate.delta_bytes || 0);
        continue;
      }

      const deltaRows = selectDeltaRows.all(candidate.session_id, candidate.call_id);
      if (!deltaRows.length) {
        continue;
      }

      const mergedPayload = {
        ...safeJsonParse(commandEnd.payload_json, {}),
        ...aggregateCommandOutput(deltaRows),
      };

      if (!options.dryRun) {
        updateCommandEnd.run(JSON.stringify(mergedPayload), commandEnd.id);
        deleteDeltas.run(candidate.session_id, candidate.call_id);
      }

      compactedCalls += 1;
      deletedRows += Number(candidate.delta_count || 0);
      reclaimedBytes += Number(candidate.delta_bytes || 0);
    }
  });

  run();
  db.close();

  console.log(
    JSON.stringify(
      {
        databasePath: options.databasePath,
        sessionId: options.sessionId || null,
        dryRun: options.dryRun,
        compactedCalls,
        skippedCalls,
        deletedRows,
        reclaimedBytes,
      },
      null,
      2,
    ),
  );
}

main();
