import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDraftUpdatePatch } from "./task-draft-store";

export interface ProjectProfile {
  schemaVersion: 1;
  id: string;
  repoRoot: string;
  setupCommands: string[];
  verifyCommands: string[];
  forbiddenChanges: string[];
}

export async function loadProjectProfiles(dir: string): Promise<ProjectProfile[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(join(dir, file), "utf8")) as ProjectProfile));
}

export async function loadProjectProfile(dir: string, id: string): Promise<ProjectProfile> {
  const profile = (await loadProjectProfiles(dir)).find((item) => item.id === id);
  if (!profile) throw new Error(`project profile not found: ${id}`);
  return profile;
}

export function applyProjectDefaults(
  patch: TaskDraftUpdatePatch,
  profile: ProjectProfile,
): TaskDraftUpdatePatch {
  return {
    ...patch,
    projectId: patch.projectId ?? profile.id,
    repoRoot: patch.repoRoot ?? profile.repoRoot,
    forbiddenChanges: patch.forbiddenChanges ?? profile.forbiddenChanges,
    setupCommands: patch.setupCommands ?? profile.setupCommands,
    verifyCommands: patch.verifyCommands ?? profile.verifyCommands,
  };
}
