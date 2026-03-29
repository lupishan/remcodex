import type { IPty } from "node-pty";
import { spawn } from "node-pty";

import { ensureNodePtyHelperExecutable } from "../utils/node-pty";

export class PtyRunner {
  private process: IPty | null = null;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private stopTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
  ) {}

  start(): number {
    ensureNodePtyHelperExecutable();

    const shell = process.env.SHELL ?? "/bin/zsh";

    this.process = spawn(shell, ["-lc", this.command], {
      cwd: this.cwd,
      cols: 120,
      rows: 30,
      name: "xterm-256color",
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });

    this.process.onData((chunk) => {
      this.dataListeners.forEach((listener) => listener(chunk));
    });

    this.process.onExit(({ exitCode }) => {
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }

      this.process = null;
      this.exitListeners.forEach((listener) => listener(exitCode));
    });

    return this.process.pid;
  }

  write(input: string): void {
    this.process?.write(input);
  }

  stop(): void {
    if (!this.process) {
      return;
    }

    this.process.write("\u0003");
    this.stopTimer = setTimeout(() => {
      this.process?.kill();
    }, 1500);
    this.stopTimer.unref();
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  isAlive(): boolean {
    return this.process !== null;
  }
}
