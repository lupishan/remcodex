import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { DatabaseClient } from "../db/client";
import type { ProjectRecord } from "../types/models";
import { AppError } from "../utils/errors";
import { createId } from "../utils/ids";

export class ProjectManager {
  private readonly allowedRoots: string[];

  constructor(
    private readonly db: DatabaseClient,
    projectRootsEnv: string | undefined,
    repoRoot: string,
  ) {
    this.allowedRoots = (projectRootsEnv ?? homedir())
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(item));
  }

  listProjects(): ProjectRecord[] {
    return this.db
      .prepare(
        `
          SELECT id, name, path, created_at
          FROM projects
          ORDER BY created_at DESC
        `,
      )
      .all() as ProjectRecord[];
  }

  getProject(projectId: string): ProjectRecord | null {
    return (
      (this.db
        .prepare(
          `
            SELECT id, name, path, created_at
            FROM projects
            WHERE id = ?
          `,
        )
        .get(projectId) as ProjectRecord | undefined) ?? null
    );
  }

  createProject(input: { name: string; path: string; createMissing?: boolean }): ProjectRecord {
    const name = input.name.trim();
    const resolvedPath = path.resolve(input.path.trim());

    if (!name) {
      throw new AppError(400, "Project name is required.");
    }

    if (!input.path.trim()) {
      throw new AppError(400, "Project path is required.");
    }

    if (!existsSync(resolvedPath) && input.createMissing) {
      mkdirSync(resolvedPath, { recursive: true });
    }

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      throw new AppError(400, "Project path does not exist or is not a directory.");
    }

    if (!this.isAllowed(resolvedPath)) {
      throw new AppError(
        400,
        `Project path is outside allowed roots: ${this.allowedRoots.join(", ")}`,
      );
    }

    const duplicated = this.db
      .prepare(
        `
          SELECT id
          FROM projects
          WHERE path = ?
        `,
      )
      .get(resolvedPath) as { id: string } | undefined;

    if (duplicated) {
      throw new AppError(409, "Project path is already registered.");
    }

    const project: ProjectRecord = {
      id: createId("proj"),
      name,
      path: resolvedPath,
      created_at: new Date().toISOString(),
    };

    this.db
      .prepare(
        `
          INSERT INTO projects (id, name, path, created_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(project.id, project.name, project.path, project.created_at);

    return project;
  }

  listAllowedRoots(): string[] {
    return [...this.allowedRoots];
  }

  browseDirectories(targetPath?: string | null): {
    currentPath: string | null;
    parentPath: string | null;
    items: Array<{ name: string; path: string }>;
  } {
    const rawTarget = String(targetPath || "").trim();
    if (!rawTarget) {
      return {
        currentPath: null,
        parentPath: null,
        items: this.allowedRoots.map((root) => ({
          name: path.basename(root) || root,
          path: root,
        })),
      };
    }

    const resolvedPath = path.resolve(rawTarget);
    const root = this.findAllowedRoot(resolvedPath);
    if (!root) {
      throw new AppError(
        400,
        `Project path is outside allowed roots: ${this.allowedRoots.join(", ")}`,
      );
    }

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      throw new AppError(400, "Project path does not exist or is not a directory.");
    }

    const items = readdirSync(resolvedPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolvedPath, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

    const parentPath = resolvedPath === root ? null : path.dirname(resolvedPath);

    return {
      currentPath: resolvedPath,
      parentPath,
      items,
    };
  }

  private isAllowed(targetPath: string): boolean {
    return Boolean(this.findAllowedRoot(targetPath));
  }

  private findAllowedRoot(targetPath: string): string | null {
    return (
      this.allowedRoots.find((root) => {
        const relative = path.relative(root, targetPath);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      }) ?? null
    );
  }
}
