import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskResultMode } from "./contracts";
import type { TaskDraftUpdatePatch } from "./task-draft-store";

export interface ProjectProfile {
  schemaVersion: 1;
  id: string;
  repoRoot: string;
  setupCommands: string[];
  verifyCommands: string[];
  forbiddenChanges: string[];
  defaultRemoteScopeId?: string;
  remoteScopes?: ProjectRemoteScope[];
}

export interface ProjectRemoteScope {
  id: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
  targetFiles: string[];
  setupCommands?: string[];
  verifyCommands?: string[];
  forbiddenChanges?: string[];
  resultMode?: TaskResultMode;
  keywords?: string[];
  planSteps: string[];
  successCriteria: string[];
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

export function selectProjectRemoteScope(
  profile: ProjectProfile,
  input: { requestedScopeId?: string; requestText?: string } = {},
): ProjectRemoteScope | undefined {
  const scopes = profile.remoteScopes ?? [];
  if (scopes.length === 0) return undefined;

  if (input.requestedScopeId) {
    const requested = scopes.find((scope) => scope.id === input.requestedScopeId);
    if (!requested) throw new Error(`remote scope not found: ${input.requestedScopeId}`);
    return requested;
  }

  const text = input.requestText?.toLowerCase() ?? "";
  const scored = scopes
    .map((scope) => ({
      scope,
      score: (scope.keywords ?? []).filter((keyword) => text.includes(keyword.toLowerCase())).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].scope;

  if (profile.defaultRemoteScopeId) {
    const defaultScope = scopes.find((scope) => scope.id === profile.defaultRemoteScopeId);
    if (!defaultScope) throw new Error(`default remote scope not found: ${profile.defaultRemoteScopeId}`);
    return defaultScope;
  }

  return scopes[0];
}

export function applyProjectRemoteScopeDefaults(
  patch: TaskDraftUpdatePatch,
  profile: ProjectProfile,
  scope: ProjectRemoteScope | undefined,
): TaskDraftUpdatePatch {
  return applyProjectDefaults(
    {
      ...patch,
      targetFiles: patch.targetFiles ?? scope?.targetFiles,
      forbiddenChanges: patch.forbiddenChanges ?? scope?.forbiddenChanges,
      setupCommands: patch.setupCommands ?? scope?.setupCommands,
      verifyCommands: patch.verifyCommands ?? scope?.verifyCommands,
      resultMode: patch.resultMode ?? scope?.resultMode,
    },
    profile,
  );
}
