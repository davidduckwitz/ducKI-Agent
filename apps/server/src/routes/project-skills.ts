import { Router, type IRouter } from "express";
import { createApiResponse } from "@ducki/shared";
import { projectSkills } from "../lib/project-skills-service.js";

export const projectSkillsRouter: IRouter = Router();

/** GET /api/project-skills - returns discovered project-local skills with trust status */
projectSkillsRouter.get("/", (_req, res) => {
  try {
    const root = projectSkills.findProjectRoot();
    if (!root) {
      res.json(createApiResponse({ projectRoot: null, trusted: false, skills: [] }));
      return;
    }

    const trusted = projectSkills.isTrusted(root);
    const skills = trusted ? projectSkills.discoverProjectSkills(root) : [];

    res.json(
      createApiResponse({
        projectRoot: root,
        trusted,
        skills: skills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          path: s.path,
        })),
      })
    );
  } catch (error) {
    // Never fail - just return empty. The banner is informational.
    res.json(createApiResponse({ projectRoot: null, trusted: false, skills: [], error: error instanceof Error ? error.message : String(error) }));
  }
});

/** POST /api/project-skills/trust - trust the current git repo for local skills */
projectSkillsRouter.post("/trust", (_req, res) => {
  try {
    const root = projectSkills.findProjectRoot();
    if (!root) {
      res.status(400).json(createApiResponse({ trusted: false, error: "No git repository found" }));
      return;
    }

    projectSkills.trustProject(root);

    // Return newly discovered skills so the UI can show them immediately.
    const skills = projectSkills.discoverProjectSkills(root);

    res.json(
      createApiResponse({
        trusted: true,
        projectRoot: root,
        skills: skills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
        })),
      })
    );
  } catch (error) {
    res.status(500).json(createApiResponse({ trusted: false, error: error instanceof Error ? error.message : String(error) }));
  }
});

/** POST /api/project-skills/untrust - revoke trust for the current git repo */
projectSkillsRouter.post("/untrust", (_req, res) => {
  try {
    const root = projectSkills.findProjectRoot();
    if (!root) {
      res.status(400).json(createApiResponse({ untrusted: false, error: "No git repository found" }));
      return;
    }

    projectSkills.untrustProject(root);

    res.json(createApiResponse({ untrusted: true, projectRoot: root }));
  } catch (error) {
    res.status(500).json(createApiResponse({ untrusted: false, error: error instanceof Error ? error.message : String(error) }));
  }
});