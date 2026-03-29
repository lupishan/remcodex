declare module "better-sqlite3" {
  class Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  class Database {
    constructor(filename: string);
    exec(sql: string): this;
    prepare(sql: string): Statement;
  }

  export = Database;
}

declare module "node-pty" {
  export interface IExitEvent {
    exitCode: number;
    signal?: number;
  }

  export interface IPty {
    pid: number;
    write(data: string): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: IExitEvent) => void): void;
  }

  export interface IPtyForkOptions {
    cols?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    name?: string;
    rows?: number;
  }

  export function spawn(
    file: string,
    args?: string[],
    options?: IPtyForkOptions,
  ): IPty;
}
