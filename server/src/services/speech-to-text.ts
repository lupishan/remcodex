import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

import { resolveExecutable } from "../utils/command";

export interface SpeechToTextOptions {
  preferredBinary?: string;
  modelPath?: string;
}

export interface SpeechToTextSelfTestResult {
  ok: boolean;
  binaryPath: string | null;
  modelPath: string | null;
  details: string;
}

export interface SpeechToTextDiagnostics {
  inputBytes: number;
  mimeType: string | null;
  audioSuffix: string;
  binaryName: string;
  modelConfigured: boolean;
  transcriptLength: number;
  dotCount: number;
  dotRatio: number;
  whitespaceOnly: boolean;
}

export interface SpeechToTextResult {
  transcript: string;
  diagnostics: SpeechToTextDiagnostics;
}

const DEFAULT_BINARY_CANDIDATES = [
  "whisper",
  "whisper.cpp",
  "whisper-ctranslate2",
];

export class SpeechToTextService {
  private readonly modelPath: string | null;
  private readonly binaryCandidates: string[];
  private binaryIndex = 0;
  private binaryPath: string | null;

  constructor(options: SpeechToTextOptions = {}) {
    const preferredBinary = String(options.preferredBinary || "").trim();
    this.binaryCandidates = preferredBinary
      ? [
          preferredBinary,
          ...DEFAULT_BINARY_CANDIDATES.filter((candidate) => candidate !== preferredBinary),
        ]
      : [...DEFAULT_BINARY_CANDIDATES];
    this.modelPath = String(options.modelPath || "").trim() || null;
    this.binaryPath = this.discoverBinary();
  }

  isAvailable(): boolean {
    return Boolean(this.binaryPath);
  }

  getBinaryPath(): string | null {
    return this.binaryPath;
  }

  getModelPath(): string | null {
    return this.modelPath;
  }

  async transcribe(audioBytes: Buffer, mimeType?: string | null, filename?: string | null): Promise<string> {
    return (await this.transcribeDetailed(audioBytes, mimeType, filename)).transcript;
  }

  async transcribeDetailed(
    audioBytes: Buffer,
    mimeType?: string | null,
    filename?: string | null,
  ): Promise<SpeechToTextResult> {
    if (!this.binaryPath) {
      throw new Error("No speech-to-text backend is available. Install a whisper CLI to enable voice notes.");
    }

    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "remcodex-stt-"));
    try {
      const suffix = guessAudioSuffix(mimeType, filename);
      const inputPath = path.join(tmpRoot, `audio${suffix}`);
      writeFileSync(inputPath, audioBytes);

      let outputPath = replaceExtension(inputPath, ".txt");
      let runResult = await this.runBinaryAsync(this.binaryPath, inputPath);
      if (!runResult.ok) {
        const previousBinary = this.binaryPath;
        const stderr = runResult.stderr;
        this.fallbackToNextBinary();
        if (this.binaryPath && this.binaryPath !== previousBinary) {
          outputPath = replaceExtension(inputPath, ".txt");
          runResult = await this.runBinaryAsync(this.binaryPath, inputPath);
        }
        if (!runResult.ok) {
          throw new Error(
            `Transcription failed (exit ${runResult.exitCode}): ${runResult.stderr || stderr || "unknown error"}`,
          );
        }
      }

      if (!fileExists(outputPath)) {
        const candidate = findTranscriptFile(tmpRoot);
        if (candidate) {
          outputPath = candidate;
        }
      }
      if (!fileExists(outputPath)) {
        throw new Error("Transcription completed but no transcript file was produced.");
      }

      const transcript = readFileSync(outputPath, "utf8").trim();
      if (!transcript) {
        throw new Error("Transcription produced an empty result.");
      }
      const dotCount = [...transcript].filter((character) => character === ".").length;
      return {
        transcript,
        diagnostics: {
          inputBytes: audioBytes.length,
          mimeType: String(mimeType || "").trim() || null,
          audioSuffix: suffix,
          binaryName: path.basename(this.binaryPath),
          modelConfigured: Boolean(this.modelPath),
          transcriptLength: transcript.length,
          dotCount,
          dotRatio: transcript.length > 0 ? dotCount / transcript.length : 0,
          whitespaceOnly: transcript.trim().length === 0,
        },
      };
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  selfTest(): SpeechToTextSelfTestResult {
    if (!this.binaryPath) {
      return {
        ok: false,
        binaryPath: null,
        modelPath: this.modelPath,
        details: "No speech-to-text backend is available.",
      };
    }

    if (this.modelPath && !existsSync(this.modelPath)) {
      return {
        ok: false,
        binaryPath: this.binaryPath,
        modelPath: this.modelPath,
        details: `Configured model path does not exist: ${this.modelPath}`,
      };
    }

    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "remcodex-stt-self-test-"));
    try {
      const inputPath = path.join(tmpRoot, "self-test.wav");
      writeFileSync(inputPath, createSilentWavBuffer());

      const result = this.runBinary(this.binaryPath, inputPath);
      const transcriptPath = replaceExtension(inputPath, ".txt");
      const transcriptExists =
        fileExists(transcriptPath) || Boolean(findTranscriptFile(tmpRoot));

      if (result.ok) {
        return {
          ok: true,
          binaryPath: this.binaryPath,
          modelPath: this.modelPath,
          details: transcriptExists
            ? "STT backend accepted the invocation and produced a transcript artifact."
            : "STT backend accepted the invocation.",
        };
      }

      const stderr = String(result.stderr || "").trim();
      const invocationLooksWrong =
        /usage:|unrecognized arguments|invalid choice|no such option|error:/i.test(stderr);

      return {
        ok: false,
        binaryPath: this.binaryPath,
        modelPath: this.modelPath,
        details: invocationLooksWrong
          ? `STT backend rejected the invocation: ${stderr || "unknown error"}`
          : `STT backend failed during test transcription (exit ${result.exitCode}): ${stderr || "unknown error"}`,
      };
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  private discoverBinary(): string | null {
    for (let index = this.binaryIndex; index < this.binaryCandidates.length; index += 1) {
      const candidate = this.binaryCandidates[index];
      const resolved = resolveExecutable(candidate);
      if (resolved && isExecutableBinary(resolved)) {
        this.binaryIndex = index;
        return resolved;
      }
    }
    return null;
  }

  private fallbackToNextBinary(): void {
    this.binaryIndex += 1;
    this.binaryPath = this.discoverBinary();
  }

  private runBinaryAsync(binaryPath: string, inputPath: string): Promise<{ ok: boolean; exitCode: number; stderr: string }> {
    return new Promise(resolve => {
      execFile(binaryPath, buildTranscriptionArgs(binaryPath, inputPath, this.modelPath), {
        cwd: path.dirname(inputPath), timeout: 60_000, maxBuffer: 1024 * 1024,
      }, (error, _stdout, stderr) => resolve({ ok: !error, exitCode: error ? 1 : 0, stderr: String(stderr).slice(-4096) }));
    });
  }

  private runBinary(binaryPath: string, inputPath: string): { ok: boolean; exitCode: number; stderr: string } {
    const args = buildTranscriptionArgs(binaryPath, inputPath, this.modelPath);
    try {
      execFileSync(binaryPath, args, {
        cwd: path.dirname(inputPath),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      return { ok: true, exitCode: 0, stderr: "" };
    } catch (error) {
      const exitCode =
        typeof (error as { status?: unknown }).status === "number"
          ? Number((error as { status: number }).status)
          : 1;
      const stderr = Buffer.isBuffer((error as { stderr?: unknown }).stderr)
        ? (error as { stderr: Buffer }).stderr.toString("utf8").trim()
        : String((error as { stderr?: unknown }).stderr || "").trim();
      return { ok: false, exitCode, stderr };
    }
  }
}

function buildTranscriptionArgs(binaryPath: string, inputPath: string, modelPath: string | null): string[] {
  const args: string[] = [];
  const binaryName = path.basename(binaryPath).toLowerCase();
  if (binaryName.includes("ctranslate2")) {
    if (modelPath) {
      args.push("--model_directory", modelPath);
    }
    args.push("--output_dir", path.dirname(inputPath));
    args.push("--output_format", "txt");
    args.push("--verbose", "False");
  } else if (modelPath) {
    args.push("-m", modelPath);
  }
  args.push(inputPath);
  return args;
}

function replaceExtension(filePath: string, extension: string): string {
  return /\.[^.]+$/.test(filePath) ? filePath.replace(/\.[^.]+$/, extension) : `${filePath}${extension}`;
}

function createSilentWavBuffer(durationMs = 800, sampleRate = 16000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const dataSize = sampleCount * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function guessAudioSuffix(mimeType?: string | null, filename?: string | null): string {
  const trimmedFilename = String(filename || "").trim();
  if (trimmedFilename) {
    const parsed = path.parse(trimmedFilename);
    if (parsed.ext) {
      return parsed.ext;
    }
  }

  const normalizedType = String(mimeType || "").trim().toLowerCase();
  switch (normalizedType) {
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/opus":
      return ".opus";
    case "audio/webm":
      return ".webm";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/flac":
      return ".flac";
    default:
      return ".wav";
  }
}

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

function isExecutableBinary(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findTranscriptFile(dirPath: string): string | null {
  try {
    const candidates = readdirSync(dirPath);
    const transcript = candidates.find((name) => name.toLowerCase().endsWith(".txt"));
    return transcript ? path.join(dirPath, transcript) : null;
  } catch {
    return null;
  }
}
