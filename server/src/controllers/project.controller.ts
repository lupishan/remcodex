import { Router } from "express";

import { ProjectManager } from "../services/project-manager";

export function createProjectRouter(projectManager: ProjectManager): Router {
  const router = Router();

  router.get("/", (_request, response) => {
    const items = projectManager.listProjects().map((project) => ({
      projectId: project.id,
      name: project.name,
      path: project.path,
      createdAt: project.created_at,
    }));

    response.json({ items });
  });

  router.post("/", (request, response, next) => {
    try {
      const body = request.body as { name?: string; path?: string; createMissing?: boolean };
      const project = projectManager.createProject({
        name: body.name ?? "",
        path: body.path ?? "",
        createMissing: body.createMissing === true,
      });

      response.status(201).json({
        projectId: project.id,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/browse", (request, response, next) => {
    try {
      const targetPath =
        typeof request.query.path === "string" && request.query.path.trim()
          ? request.query.path
          : null;
      response.json(projectManager.browseDirectories(targetPath));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
