import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { TaskResultMode } from "./contracts";
import {
  projectEffectiveForbiddenChanges,
  projectRemoteScopeAllowed,
  projectRemoteScopeRisk,
  validateProjectSafetyPolicyOverlay,
  type ProjectSafetyPolicyOverlay,
} from "./project-safety-policy";
import type { TaskDraftUpdatePatch } from "./task-draft-store";

export interface ProjectProfile {
  schemaVersion: 1;
  id: string;
  repoRoot: string;
  repoRootExpression?: string;
  keywords?: string[];
  setupCommands: string[];
  verifyCommands: string[];
  forbiddenChanges: string[];
  defaultRemoteScopeId?: string;
  remoteScopes?: ProjectRemoteScope[];
  safetyPolicy?: ProjectSafetyPolicyOverlay;
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

export type RemoteRequestIntent =
  | "implementation"
  | "planning_report"
  | "review"
  | "spec"
  | "evaluation"
  | "recovery"
  | "ambiguity_heavy";

export interface RemoteRequestClassification {
  intent: RemoteRequestIntent;
  resultMode?: TaskResultMode;
  preferredAgentId?: "codex-worker" | "codex-reviewer" | "codex-evaluator" | "codex-spec";
  safeHandling: "implementation_plan" | "report_only" | "questions_first" | "recovery_plan";
  reasons: string[];
}

export interface ProjectProfileLoadOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

interface ProjectProfileValidationInput {
  source?: string;
  profile: ProjectProfile;
}

const classificationDefaults: Record<RemoteRequestIntent, Omit<RemoteRequestClassification, "intent" | "reasons">> = {
  implementation: {
    resultMode: "write",
    preferredAgentId: "codex-worker",
    safeHandling: "implementation_plan",
  },
  planning_report: {
    resultMode: "report",
    preferredAgentId: "codex-spec",
    safeHandling: "report_only",
  },
  review: {
    resultMode: "report",
    preferredAgentId: "codex-reviewer",
    safeHandling: "report_only",
  },
  spec: {
    resultMode: "report",
    preferredAgentId: "codex-spec",
    safeHandling: "report_only",
  },
  evaluation: {
    resultMode: "report",
    preferredAgentId: "codex-evaluator",
    safeHandling: "report_only",
  },
  recovery: {
    resultMode: "write",
    preferredAgentId: "codex-worker",
    safeHandling: "recovery_plan",
  },
  ambiguity_heavy: {
    resultMode: "report",
    safeHandling: "questions_first",
  },
};

function buildClassification(
  intent: RemoteRequestIntent,
  reasons: string[],
  patch: Partial<Omit<RemoteRequestClassification, "intent" | "reasons">> = {},
): RemoteRequestClassification {
  return {
    intent,
    ...classificationDefaults[intent],
    ...patch,
    reasons,
  };
}

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

const noEditPhrases = [
  "복구 실행 없이",
  "수정하지 말고",
  "변경하지 말고",
  "구현하지 말고",
  "코드 변경 없이",
  "읽기 전용",
  "보고만",
  "리포트만",
  "계획만",
  "no edits",
  "no code changes",
  "without editing",
  "read-only",
  "report only",
];

const ambiguityPhrases = [
  "알아서",
  "대충",
  "적당히",
  "뭔가",
  "아무거나",
  "범위 모르",
  "프로젝트 모르",
  "어떻게든",
  "not sure",
  "unclear",
  "whatever",
  "somehow",
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
  "작업해",
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

const reviewTerms = [
  "리뷰",
  "검토",
  "감사",
  "점검",
  "audit",
  "inspect",
  "review",
];

const specTerms = [
  "스펙",
  "명세",
  "요구사항",
  "수용 기준",
  "acceptance criteria",
  "requirements",
  "spec",
  "scope",
];

const evaluationTerms = [
  "검증",
  "평가",
  "테스트 전략",
  "결과 평가",
  "validate",
  "validation",
  "evaluate",
  "evaluation",
  "test strategy",
];

const recoveryTerms = [
  "복구",
  "회복",
  "실패한 plan",
  "실패 계획",
  "failed plan",
  "recover",
  "recovery",
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
  return classifyRemoteRequest(requestText).intent;
}

export function classifyRemoteRequest(requestText: string): RemoteRequestClassification {
  const text = normalizedRequestText(requestText);
  if (!text) {
    return buildClassification("ambiguity_heavy", ["empty request text"]);
  }

  const reasons: string[] = [];
  const noEditScore = countTerms(text, noEditPhrases);
  const ambiguityScore = countTerms(text, ambiguityPhrases);
  const recoveryScore = countTerms(text, recoveryTerms);
  const evaluationScore = countTerms(text, evaluationTerms);
  const specScore = countTerms(text, specTerms);
  const reviewScore = countTerms(text, reviewTerms);
  const planningPhraseScore = countTerms(text, planningPhrases);
  const implementationOverrideScore = countTerms(text, implementationOverridePhrases);

  const implementationScore = countTerms(text, implementationTerms);
  const planningScore = countTerms(text, planningTerms);

  if (implementationOverrideScore > 0) {
    return buildClassification("implementation", [...reasons, "explicit implementation override phrase"]);
  }

  if (noEditScore > 0) reasons.push("request asks for no edits/report-only handling");
  if (ambiguityScore > 0) reasons.push("request contains ambiguity-heavy wording");

  if (ambiguityScore > 0 && implementationScore > 0) {
    return buildClassification("ambiguity_heavy", [...reasons, "implementation wording is not safely scoped"]);
  }

  if (recoveryScore > 0) {
    reasons.push("recovery wording matched");
    return buildClassification(
      "recovery",
      reasons,
      noEditScore > 0
        ? { resultMode: "report", preferredAgentId: "codex-evaluator", safeHandling: "report_only" }
        : {},
    );
  }

  if (planningPhraseScore > 0) {
    return buildClassification("planning_report", [...reasons, "planning/report phrase matched"]);
  }

  if (evaluationScore > 0 && (noEditScore > 0 || implementationScore === 0)) {
    return buildClassification("evaluation", [...reasons, "evaluation wording matched"]);
  }

  if (specScore > 0 && (noEditScore > 0 || implementationScore === 0)) {
    return buildClassification("spec", [...reasons, "spec wording matched"]);
  }

  if (reviewScore > 0 && (noEditScore > 0 || implementationScore === 0)) {
    return buildClassification("review", [...reasons, "review wording matched"]);
  }

  if (noEditScore > 0) {
    return buildClassification("planning_report", [...reasons, "no-edit wording prevents write-scope selection"]);
  }

  if (implementationScore > 0 && planningScore === 0) {
    return buildClassification("implementation", [...reasons, "implementation wording matched without report-only wording"]);
  }

  if (text.includes("다음 작업") && implementationScore === 0) {
    return buildClassification("planning_report", [...reasons, "next-work wording matched without implementation wording"]);
  }

  if (planningScore > 0 && implementationScore === 0) {
    return buildClassification("planning_report", [...reasons, "planning/report wording matched without implementation wording"]);
  }

  if (implementationScore > 0 && planningScore > 0) {
    return buildClassification("implementation", [...reasons, "implementation and planning wording both matched"]);
  }

  return buildClassification("ambiguity_heavy", [...reasons, "no deterministic project/scope intent matched"]);
}

function reportScope(scopes: ProjectRemoteScope[]): ProjectRemoteScope | undefined {
  return (
    scopes.find((scope) => scope.id === "planning_report") ??
    scopes.find((scope) => scope.resultMode === "report")
  );
}

function writeScope(scopes: ProjectRemoteScope[]): ProjectRemoteScope | undefined {
  return (
    scopes.find((scope) => scope.id === "implementation") ??
    scopes.find((scope) => scope.resultMode === "write")
  );
}

function scopeForClassification(
  scopes: ProjectRemoteScope[],
  classification: RemoteRequestClassification,
): ProjectRemoteScope | undefined {
  if (classification.resultMode === "report") return reportScope(scopes);
  const intent = classification.intent;
  if (
    intent === "planning_report" ||
    intent === "review" ||
    intent === "spec" ||
    intent === "evaluation" ||
    intent === "ambiguity_heavy"
  ) {
    return reportScope(scopes);
  }
  return writeScope(scopes);
}

function profileRepoRootEnvName(profileId: string): string {
  return `SAMANTHA_PROJECT_${profileId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_REPO_ROOT`;
}

function validationPrefix(source: string | undefined): string {
  return source ? `project profile ${source}` : "project profile";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrayViolations(
  value: unknown,
  field: string,
  input: { source?: string; required?: boolean; nonEmpty?: boolean },
): string[] {
  const prefix = validationPrefix(input.source);
  if (value === undefined) {
    return input.required ? [`${prefix}: ${field} is required`] : [];
  }
  if (!Array.isArray(value)) return [`${prefix}: ${field} must be an array`];
  const violations: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      violations.push(`${prefix}: ${field}[${index}] must be a non-empty string`);
    }
  });
  if (input.nonEmpty && value.length === 0) violations.push(`${prefix}: ${field} must not be empty`);
  return violations;
}

function normalizedToken(value: string): string {
  return normalizedRequestText(value);
}

function validateProjectId(value: unknown, source?: string): string[] {
  const prefix = validationPrefix(source);
  if (typeof value !== "string" || value.trim() === "") return [`${prefix}: id is required`];
  if (value !== value.trim()) return [`${prefix}: id must not have leading or trailing whitespace`];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    return [`${prefix}: id must use lowercase letters, numbers, hyphen, or underscore`];
  }
  return [];
}

function validateRepoRootExpression(value: unknown, source?: string): string[] {
  const prefix = validationPrefix(source);
  if (typeof value !== "string" || value.trim() === "") return [`${prefix}: repoRoot is required`];
  if (value !== value.trim()) return [`${prefix}: repoRoot must not have leading or trailing whitespace`];
  if (value.includes("\0")) return [`${prefix}: repoRoot must not contain NUL bytes`];
  return [];
}

function validateRemoteScope(value: unknown, source: string | undefined, index: number): string[] {
  const prefix = `${validationPrefix(source)}: remoteScopes[${index}]`;
  if (!isRecord(value)) return [`${prefix} must be an object`];

  const violations: string[] = [];
  const scopeArrayViolations = (arrayValue: unknown, field: string, input: { required?: boolean; nonEmpty?: boolean } = {}) => {
    if (arrayValue === undefined) return input.required ? [`${prefix}.${field} is required`] : [];
    if (!Array.isArray(arrayValue)) return [`${prefix}.${field} must be an array`];
    const fieldViolations: string[] = [];
    arrayValue.forEach((item, itemIndex) => {
      if (typeof item !== "string" || item.trim() === "") {
        fieldViolations.push(`${prefix}.${field}[${itemIndex}] must be a non-empty string`);
      }
    });
    if (input.nonEmpty && arrayValue.length === 0) fieldViolations.push(`${prefix}.${field} must not be empty`);
    return fieldViolations;
  };
  const id = value.id;
  if (typeof id !== "string" || id.trim() === "") violations.push(`${prefix}.id is required`);
  if (typeof id === "string" && id !== id.trim()) violations.push(`${prefix}.id must not have leading or trailing whitespace`);
  for (const field of ["label", "description"] as const) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || fieldValue.trim() === "") violations.push(`${prefix}.${field} is required`);
  }
  if (value.risk !== "low" && value.risk !== "medium" && value.risk !== "high") {
    violations.push(`${prefix}.risk must be low, medium, or high`);
  }
  if (value.resultMode !== undefined && value.resultMode !== "write" && value.resultMode !== "report") {
    violations.push(`${prefix}.resultMode must be write or report`);
  }
  violations.push(...scopeArrayViolations(value.targetFiles, "targetFiles", { required: true, nonEmpty: true }));
  violations.push(...scopeArrayViolations(value.setupCommands, "setupCommands"));
  violations.push(...scopeArrayViolations(value.verifyCommands, "verifyCommands"));
  violations.push(...scopeArrayViolations(value.forbiddenChanges, "forbiddenChanges"));
  violations.push(...scopeArrayViolations(value.keywords, "keywords"));
  violations.push(...scopeArrayViolations(value.planSteps, "planSteps", { required: true, nonEmpty: true }));
  violations.push(...scopeArrayViolations(value.successCriteria, "successCriteria", { required: true, nonEmpty: true }));
  return violations;
}

export function validateProjectProfile(profile: unknown, source?: string): string[] {
  const prefix = validationPrefix(source);
  if (!isRecord(profile)) return [`${prefix} must be an object`];

  const violations: string[] = [];
  if (profile.schemaVersion !== 1) violations.push(`${prefix}: schemaVersion must be 1`);
  violations.push(...validateProjectId(profile.id, source));
  violations.push(...validateRepoRootExpression(profile.repoRoot, source));
  violations.push(...stringArrayViolations(profile.keywords, "keywords", { source }));
  violations.push(...stringArrayViolations(profile.setupCommands, "setupCommands", { source, required: true }));
  violations.push(...stringArrayViolations(profile.verifyCommands, "verifyCommands", { source, required: true, nonEmpty: true }));
  violations.push(...stringArrayViolations(profile.forbiddenChanges, "forbiddenChanges", { source, required: true }));
  violations.push(...validateProjectSafetyPolicyOverlay(profile as unknown as ProjectProfile, source));

  if (profile.defaultRemoteScopeId !== undefined && (typeof profile.defaultRemoteScopeId !== "string" || profile.defaultRemoteScopeId.trim() === "")) {
    violations.push(`${prefix}: defaultRemoteScopeId must be a non-empty string`);
  }

  if (profile.remoteScopes !== undefined && !Array.isArray(profile.remoteScopes)) {
    violations.push(`${prefix}: remoteScopes must be an array`);
  }
  const remoteScopes = Array.isArray(profile.remoteScopes) ? profile.remoteScopes : [];
  remoteScopes.forEach((scope, index) => violations.push(...validateRemoteScope(scope, source, index)));

  const scopeIds = remoteScopes
    .map((scope) => (isRecord(scope) && typeof scope.id === "string" ? scope.id : undefined))
    .filter((id): id is string => Boolean(id));
  const seenScopeIds = new Set<string>();
  for (const scopeId of scopeIds) {
    if (seenScopeIds.has(scopeId)) violations.push(`${prefix}: remote scope id is duplicated: ${scopeId}`);
    seenScopeIds.add(scopeId);
  }
  if (
    typeof profile.defaultRemoteScopeId === "string" &&
    profile.defaultRemoteScopeId.trim() !== "" &&
    !seenScopeIds.has(profile.defaultRemoteScopeId)
  ) {
    violations.push(`${prefix}: defaultRemoteScopeId does not match a remote scope: ${profile.defaultRemoteScopeId}`);
  }

  const keywordTokens = new Set<string>();
  const keywords = Array.isArray(profile.keywords) ? profile.keywords : [];
  for (const keyword of keywords) {
    if (typeof keyword !== "string" || keyword.trim() === "") continue;
    const token = normalizedToken(keyword);
    if (keywordTokens.has(token)) violations.push(`${prefix}: keyword is duplicated: ${keyword}`);
    keywordTokens.add(token);
  }

  return violations;
}

export function validateProjectProfileSet(inputs: ProjectProfileValidationInput[]): string[] {
  const violations = inputs.flatMap((input) => validateProjectProfile(input.profile, input.source));
  const ids = new Map<string, string>();
  const identifiers = new Map<string, { id: string; label: string; source: string | undefined }>();

  for (const input of inputs) {
    const profile = input.profile;
    if (typeof profile.id !== "string" || profile.id.trim() === "") continue;
    const id = profile.id;
    const previousSource = ids.get(id);
    if (previousSource) {
      violations.push(`${validationPrefix(input.source)}: duplicate project id ${id} also appears in ${previousSource}`);
    } else {
      ids.set(id, input.source ?? id);
    }

    for (const label of [profile.id, ...(Array.isArray(profile.keywords) ? profile.keywords : [])]) {
      if (typeof label !== "string" || label.trim() === "") continue;
      const token = normalizedToken(label);
      const previous = identifiers.get(token);
      if (previous && previous.id !== id) {
        violations.push(
          `${validationPrefix(input.source)}: project identifier ${label} conflicts with project ${previous.id} (${previous.label})`,
        );
      } else {
        identifiers.set(token, { id, label, source: input.source });
      }
    }
  }

  return violations;
}

function expandProfilePath(path: string, options: Required<ProjectProfileLoadOptions>): string {
  let expanded = path;
  if (expanded === "~") expanded = options.homeDir;
  if (expanded.startsWith("~/")) expanded = join(options.homeDir, expanded.slice(2));
  expanded = expanded.replace(/\$(\w+)|\$\{([^}]+)\}/g, (match, bareName: string, bracedName: string) => {
    const name = bareName || bracedName;
    if (name === "HOME") return options.env.HOME?.trim() || options.homeDir;
    return options.env[name]?.trim() || match;
  });
  if (/\$(\w+)|\$\{([^}]+)\}/.test(expanded)) {
    throw new Error(`repoRoot contains unresolved environment variable: ${path}`);
  }
  if (!isAbsolute(expanded)) {
    throw new Error(`repoRoot must resolve to an absolute path: ${path}`);
  }
  return resolve(expanded);
}

function normalizeProjectProfile(profile: ProjectProfile, options: ProjectProfileLoadOptions = {}): ProjectProfile {
  const normalizedOptions = {
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
  };
  const override = normalizedOptions.env[profileRepoRootEnvName(profile.id)]?.trim();
  const repoRootExpression = profile.repoRootExpression ?? profile.repoRoot;
  return {
    ...profile,
    repoRootExpression,
    repoRoot: expandProfilePath(override || repoRootExpression, normalizedOptions),
  };
}

export async function loadProjectProfiles(dir: string, options: ProjectProfileLoadOptions = {}): Promise<ProjectProfile[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  const rawProfiles = await Promise.all(
    files.map(async (file) => ({
      file,
      profile: JSON.parse(await readFile(join(dir, file), "utf8")) as ProjectProfile,
    })),
  );
  const violations = validateProjectProfileSet(rawProfiles.map((item) => ({ source: item.file, profile: item.profile })));
  if (violations.length > 0) throw new Error(`invalid project profile configuration:\n${violations.join("\n")}`);

  const normalized: ProjectProfile[] = [];
  for (const item of rawProfiles) {
    try {
      normalized.push(normalizeProjectProfile(item.profile, options));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid project profile configuration:\n${validationPrefix(item.file)}: ${message}`);
    }
  }
  return normalized.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadProjectProfile(dir: string, id: string, options: ProjectProfileLoadOptions = {}): Promise<ProjectProfile> {
  const profile = (await loadProjectProfiles(dir, options)).find((item) => item.id === id);
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
      const keywords = [...new Set([profile.id, ...(profile.keywords ?? [])].map((keyword) => normalizedRequestText(keyword)))];
      const score = keywords.filter((keyword) => text.includes(normalizedRequestText(keyword))).length;
      return { profile, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id));

  const top = scored[0];
  if (!top) return undefined;
  if (scored.length > 1) {
    throw new Error(`ambiguous project profile match: ${scored.map((item) => item.profile.id).join(", ")}; specify project id`);
  }
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
    forbiddenChanges: projectEffectiveForbiddenChanges(profile, patch.forbiddenChanges ?? []),
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
    if (!projectRemoteScopeAllowed(profile, requested.id)) {
      throw new Error(`project policy ${profile.id} blocks remote scope: ${requested.id}`);
    }
    return requested;
  }

  const text = input.requestText?.toLowerCase() ?? "";
  const classification = classifyRemoteRequest(text);
  const intentScope = scopeForClassification(scopes, classification);
  if (intentScope && projectRemoteScopeAllowed(profile, intentScope.id)) return intentScope;
  if (classification.safeHandling === "report_only" || classification.safeHandling === "questions_first") {
    return undefined;
  }

  const scored = scopes
    .map((scope) => ({
      scope,
      score: (scope.keywords ?? []).filter((keyword) => text.includes(keyword.toLowerCase())).length,
    }))
    .filter((item) => item.score > 0)
    .filter((item) => projectRemoteScopeAllowed(profile, item.scope.id))
    .sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].scope;

  if (profile.defaultRemoteScopeId) {
    const defaultScope = scopes.find((scope) => scope.id === profile.defaultRemoteScopeId);
    if (!defaultScope) throw new Error(`default remote scope not found: ${profile.defaultRemoteScopeId}`);
    if (!projectRemoteScopeAllowed(profile, defaultScope.id)) {
      throw new Error(`project policy ${profile.id} blocks default remote scope: ${defaultScope.id}`);
    }
    return defaultScope;
  }

  return scopes.find((scope) => projectRemoteScopeAllowed(profile, scope.id));
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
      forbiddenChanges: projectEffectiveForbiddenChanges(profile, patch.forbiddenChanges ?? scope?.forbiddenChanges ?? []),
      setupCommands: patch.setupCommands ?? scope?.setupCommands,
      verifyCommands: patch.verifyCommands ?? scope?.verifyCommands,
      resultMode: patch.resultMode ?? scope?.resultMode,
    },
    profile,
  );
}

export { projectRemoteScopeRisk };
