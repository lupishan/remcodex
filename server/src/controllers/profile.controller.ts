import { Router } from "express";

import { AgentProfileManager } from "../services/agent-profile-manager";

export function createProfileRouter(profileManager: AgentProfileManager): Router {
  const router = Router();

  router.get("/", (_request, response) => {
    response.json({ items: profileManager.listProfiles() });
  });

  router.get("/:profileId", (request, response) => {
    const profile = profileManager.getProfile(request.params.profileId);
    if (!profile) {
      response.status(404).json({ error: "Profile not found." });
      return;
    }
    response.json(profile);
  });

  router.post("/", (request, response, next) => {
    try {
      const body = request.body as {
        name?: string;
        startingPrompt?: string;
        defaultDirectory?: string;
        agentEnvironment?: string | null;
      };
      const profile = profileManager.createProfile({
        name: body.name ?? "",
        startingPrompt: body.startingPrompt ?? "",
        defaultDirectory: body.defaultDirectory ?? "",
        agentEnvironment: body.agentEnvironment,
      });
      response.status(201).json(profile);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
