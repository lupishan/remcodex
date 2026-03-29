import Database from "better-sqlite3";

export type DatabaseClient = InstanceType<typeof Database>;

export function createDatabase(file: string): DatabaseClient {
  return new Database(file);
}
