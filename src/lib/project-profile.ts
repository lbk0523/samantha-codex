import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskResultMode } from "./contracts";
import type { TaskDraftUpdatePatch } from "./task-draft-store";

export interface ProjectProfile {
  schemaVersion: 1;
  id: string;
  repoRoot: string;
  keywords?: string[];
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

export type RemoteRequestIntent = "implementation" | "planning_report";

const implementationOverridePhrases = [
  "계획대로 구현",
  "계획대로 진행",
  "계획대로 반영",
  "위 계획 구현",
  "위 계획 진행",
  "위 계획 반영",
  "계획 반영",
  "구현 시작",
  "작업 시작",
  "바로 구현",
  "수정 시작",
  "진행 바람",
  "진행해",
  "처리 바람",
];

const planningPhrases = [
  "계획 보고",
  "작업 계획",
  "구현 계획",
  "개선 계획",
  "수정 계획",
  "다음 작업 계획",
  "상태 확인",
  "우선순위",
];

const implementationTerms = [
  "구현",
  "수정",
  "고쳐",
  "개선",
  "추가",
  "삭제",
  "반영",
  "적용",
  "처리",
  "만들",
  "작업해",
  "해줘",
  "fix",
  "implement",
  "build",
  "add",
  "change",
  "remove",
];

const planningTerms = [
  "계획",
  "보고",
  "검토",
  "분석",
  "제안",
  "정리",
  "리뷰",
  "확인",
  "plan",
  "report",
  "review",
];

function normalizedRequestText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function countTerms(text: string, terms: string[]): number {
  return terms.filter((term) => text.includes(term)).length;
}

export function classifyRemoteRequestIntent(requestText: string): RemoteRequestIntent | undefined {
  const text = normalizedRequestText(requestText);
  if (!text) return undefined;

  if (implementationOverridePhrases.some((phrase) => text.includes(phrase))) return "implementation";
  if (planningPhrases.some((phrase) => text.includes(phrase))) return "planning_report";

  const implementationScore = countTerms(text, implementationTerms);
  const planningScore = countTerms(text, planningTerms);
  if (implementationScore > 0 && planningScore === 0) return "implementation";
  if (text.includes("다음 작업") && implementationScore === 0) return "planning_report";
  if (planningScore > 0 && implementationScore === 0) return "planning_report";
  if (implementationScore > 0 && planningScore > 0) return "implementation";

  return undefined;
}

function scopeForIntent(scopes: ProjectRemoteScope[], intent: RemoteRequestIntent | undefined): ProjectRemoteScope | undefined {
  if (!intent) return undefined;
  if (intent === "planning_report") {
    return (
      scopes.find((scope) => scope.id === "planning_report") ??
      scopes.find((scope) => scope.resultMode === "report")
    );
  }
  return (
    scopes.find((scope) => scope.id === "implementation") ??
    scopes.find((scope) => scope.resultMode === "write")
  );
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

export function inferProjectProfile(
  profiles: ProjectProfile[],
  input: { requestText?: string } = {},
): ProjectProfile | undefined {
  const text = normalizedRequestText(input.requestText ?? "");
  if (!text) return undefined;

  const scored = profiles
    .map((profile) => {
      const keywords = [profile.id, ...(profile.keywords ?? [])];
      const score = keywords.filter((keyword) => text.includes(normalizedRequestText(keyword))).length;
      return { profile, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id));

  const top = scored[0];
  if (!top) return undefined;
  if (scored[1] && scored[1].score === top.score) return undefined;
  return top.profile;
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
  const intentScope = scopeForIntent(scopes, classifyRemoteRequestIntent(text));
  if (intentScope) return intentScope;

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
