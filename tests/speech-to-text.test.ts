import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SpeechToTextService } from "../server/src/services/speech-to-text";

test("voice transcription diagnostics identify dot-heavy output without recording transcript text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-stt-test-"));
  const binary = path.join(root, "fake-whisper");
  fs.writeFileSync(
    binary,
    "#!/bin/sh\nfor input do :; done\nprintf '%s' '....' > \"${input%.*}.txt\"\n",
    { mode: 0o755 },
  );
  const service = new SpeechToTextService({ preferredBinary: binary });

  const result = await service.transcribeDetailed(Buffer.from("audio-bytes"), "audio/webm;codecs=opus", "note.webm");

  assert.equal(result.transcript, "....");
  assert.deepEqual(result.diagnostics, {
    inputBytes: 11,
    mimeType: "audio/webm;codecs=opus",
    audioSuffix: ".webm",
    binaryName: "fake-whisper",
    modelConfigured: false,
    transcriptLength: 4,
    dotCount: 4,
    dotRatio: 1,
    whitespaceOnly: false,
  });
  assert.equal("audio-bytes" in result.diagnostics, false);
  assert.equal("transcript" in result.diagnostics, false);
});
