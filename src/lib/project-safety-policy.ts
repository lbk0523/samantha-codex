import { matchesAnyGlob } from "./glob";
import { CAPABILITY_CHANGE_RISK_CLASS } from "./profile-governance";
import type { DecisionItem } from "./decision-store";
import type { ProjectProfile, ProjectRemoteScope } from "./project-profile";

export type ProjectPolicyRisk = "low" | "medium" | "high";

export interface ProjectSafetyPolicyOverlay {
  forbiddenChanges?: string[];
  allowedRemoteScopeIds?: string[];
  hostOnlyVerificationNeeds?: string[];
  riskDefaults?: {
    remoteScopes?: Record<string, ProjectPolicyRisk>;
    dispatch?: ProjectPolicyRisk;
  };
  dispatchPrerequisites?: string[];
}

export interface ProjectSafetyGovernanceCheck {
  ok: boolean;
  violations: string[];
}

const ALLOWED_PROJECT_SAFETY_POLICY_FIELDS = new Set([
  "forbiddenChanges",
  "allowedRemoteScopeIds",
  "hostOnlyVerificationNeeds",
  "riskDefaults",
  "dispatchPrerequisites",
]);

const BLOCKED_AUTHORITY_FIELDS = new Set([
  "writerCap",
  "requiredForbiddenChanges",
  "requiredTargetFilesForWriters",
  "blockedSkillNames",
  "skillPolicy",
  "allowedSkills",
  "requiredBundles",
  "connectorAccess",
  "connectors",
  "secretAccess",
  "secrets",
  "mergePolicy",
  "pushPolicy",
  "cleanupPolicy",
  "approvalPolicy",
  "approvalGate",
]);

const PROJECT_POLICY_RISK_ORDER: Record<ProjectPolicyRisk, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringArrayViolations(value: unknown, field: string, prefix: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${prefix}.${field} must be an array`];
  return value.flatMap((item, index) =>
    typeof item === "string" && item.trim() ? [] : [`${prefix}.${field}[${index}] must be a non-empty string`],
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(oneLine).filter(Boolean))];
}

function projectSafetyPolicy(profile: ProjectProfile): ProjectSafetyPolicyOverlay | undefined {
  return profile.safetyPolicy;
}

function remoteScopeIds(profile: ProjectProfile): string[] {
  return (profile.remoteScopes ?? []).map((scope) => scope.id);
}

function effectiveAllowedRemoteScopeIds(profile: ProjectProfile): string[] {
  const overlay = projectSafetyPolicy(profile);
  return unique(overlay?.allowedRemoteScopeIds ?? remoteScopeIds(profile));
}

function effectiveHostOnlyVerificationNeeds(profile: ProjectProfile): string[] {
  return unique(projectSafetyPolicy(profile)?.hostOnlyVerificationNeeds ?? []);
}

function effectiveDispatchPrerequisites(profile: ProjectProfile): string[] {
  return unique(projectSafetyPolicy(profile)?.dispatchPrerequisites ?? []);
}

function effectiveRiskForScope(profile: ProjectProfile, scope: ProjectRemoteScope): ProjectPolicyRisk {
  const overlayRisk = projectSafetyPolicy(profile)?.riskDefaults?.remoteScopes?.[scope.id];
  if (!overlayRisk) return scope.risk;
  return PROJECT_POLICY_RISK_ORDER[overlayRisk] > PROJECT_POLICY_RISK_ORDER[scope.risk] ? overlayRisk : scope.risk;
}

function effectiveScopeRiskMap(profile: ProjectProfile): Record<string, ProjectPolicyRisk> {
  return Object.fromEntries((profile.remoteScopes ?? []).map((scope) => [scope.id, effectiveRiskForScope(profile, scope)]));
}

function removedValues(before: string[], after: string[]): string[] {
  const afterSet = new Set(after);
  return before.filter((item) => !afterSet.has(item));
}

function addedValues(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((item) => !beforeSet.has(item));
}

function approvedProjectPolicyDecision(projectId: string, decisions: DecisionItem[]): DecisionItem | undefined {
  const subjectId = projectSafetyPolicyCapabilityId(projectId);
  return decisions
    .slice()
    .reverse()
    .find((decision) =>
      decision.kind === "capability_change" &&
      decision.status === "resolved" &&
      decision.resolution === "approved" &&
      decision.resolvedBy === "bk" &&
      Boolean(decision.resolvedAt) &&
      decision.subject?.type === "policy" &&
      decision.subject.id === subjectId &&
      decision.risk === CAPABILITY_CHANGE_RISK_CLASS &&
      Boolean(oneLine(decision.prompt)),
    );
}

export function projectSafetyPolicyCapabilityId(projectId: string): string {
  return `project_policy:${oneLine(projectId)}`;
}

export function projectEffectiveForbiddenChanges(profile: ProjectProfile, localForbiddenChanges: string[] = []): string[] {
  return unique([
    ...profile.forbiddenChanges,
    ...(projectSafetyPolicy(profile)?.forbiddenChanges ?? []),
    ...localForbiddenChanges,
  ]);
}

export function projectRemoteScopeAllowed(profile: ProjectProfile, scopeId: string): boolean {
  return effectiveAllowedRemoteScopeIds(profile).includes(scopeId);
}

export function projectRemoteScopeRisk(profile: ProjectProfile, scope: ProjectRemoteScope): ProjectPolicyRisk {
  return effectiveRiskForScope(profile, scope);
}

export function validateProjectSafetyPolicyOverlay(profile: ProjectProfile, source?: string): string[] {
  const prefix = source ? `project profile ${source}: safetyPolicy` : "project profile: safetyPolicy";
  const overlay = (profile as { safetyPolicy?: unknown }).safetyPolicy;
  if (overlay === undefined) return [];
  if (!isRecord(overlay)) return [`${prefix} must be an object`];

  const violations: string[] = [];
  for (const field of Object.keys(overlay)) {
    if (BLOCKED_AUTHORITY_FIELDS.has(field)) {
      violations.push(`${prefix}.${field} must not configure global authority; project policy can only add stricter constraints`);
      continue;
    }
    if (!ALLOWED_PROJECT_SAFETY_POLICY_FIELDS.has(field)) {
      violations.push(`${prefix}.${field} is not an allowed project safety policy field`);
    }
  }

  violations.push(...stringArrayViolations(overlay.forbiddenChanges, "forbiddenChanges", prefix));
  violations.push(...stringArrayViolations(overlay.allowedRemoteScopeIds, "allowedRemoteScopeIds", prefix));
  violations.push(...stringArrayViolations(overlay.hostOnlyVerificationNeeds, "hostOnlyVerificationNeeds", prefix));
  violations.push(...stringArrayViolations(overlay.dispatchPrerequisites, "dispatchPrerequisites", prefix));

  const scopeIds = new Set(remoteScopeIds(profile));
  const allowedScopeIds = Array.isArray(overlay.allowedRemoteScopeIds) ? overlay.allowedRemoteScopeIds : [];
  for (const scopeId of allowedScopeIds) {
    if (typeof scopeId !== "string" || !scopeId.trim()) continue;
    if (!scopeIds.has(scopeId)) violations.push(`${prefix}.allowedRemoteScopeIds references unknown remote scope: ${scopeId}`);
  }
  if (unique(allowedScopeIds.filter((item): item is string => typeof item === "string")).length !== allowedScopeIds.length) {
    violations.push(`${prefix}.allowedRemoteScopeIds must not contain duplicates`);
  }

  if (overlay.riskDefaults !== undefined) {
    if (!isRecord(overlay.riskDefaults)) {
      violations.push(`${prefix}.riskDefaults must be an object`);
    } else {
      const riskDefaults = overlay.riskDefaults;
      if (riskDefaults.dispatch !== undefined && !isProjectPolicyRisk(riskDefaults.dispatch)) {
        violations.push(`${prefix}.riskDefaults.dispatch must be low, medium, or high`);
      }
      if (riskDefaults.remoteScopes !== undefined) {
        if (!isRecord(riskDefaults.remoteScopes)) {
          violations.push(`${prefix}.riskDefaults.remoteScopes must be an object`);
        } else {
          for (const [scopeId, risk] of Object.entries(riskDefaults.remoteScopes)) {
            if (!scopeIds.has(scopeId)) violations.push(`${prefix}.riskDefaults.remoteScopes references unknown remote scope: ${scopeId}`);
            if (!isProjectPolicyRisk(risk)) violations.push(`${prefix}.riskDefaults.remoteScopes.${scopeId} must be low, medium, or high`);
          }
        }
      }
    }
  }

  return violations;
}

function isProjectPolicyRisk(value: unknown): value is ProjectPolicyRisk {
  return value === "low" || value === "medium" || value === "high";
}

export function projectSafetyMaterializationViolations(input: {
  project: ProjectProfile | undefined;
  proposalId: string;
  targetFiles: string[];
  resultMode?: "write" | "report";
}): string[] {
  const project = input.project;
  if (!project) return [];

  const prefix = `task proposal ${input.proposalId}: project policy ${project.id} blocked`;
  const violations: string[] = [];
  const allowedScopeIds = effectiveAllowedRemoteScopeIds(project);
  const overlayHasAllowedScopes = Boolean(projectSafetyPolicy(project)?.allowedRemoteScopeIds);

  if (overlayHasAllowedScopes) {
    const allowedScopes = (project.remoteScopes ?? []).filter((scope) => allowedScopeIds.includes(scope.id));
    const allowedTargetGlobs = allowedScopes.flatMap((scope) => scope.targetFiles);
    const allowedResultModes = new Set(allowedScopes.map((scope) => scope.resultMode ?? "write"));
    if (input.resultMode && !allowedResultModes.has(input.resultMode)) {
      violations.push(
        `${prefix}: resultMode ${input.resultMode} is outside allowed remote scopes ${allowedScopeIds.join(", ")}. Next safe action: revise the plan to an allowed project scope or request governed project policy approval.`,
      );
    }
    for (const file of input.targetFiles) {
      if (allowedTargetGlobs.length > 0 && !matchesAnyGlob(file, allowedTargetGlobs)) {
        violations.push(
          `${prefix}: targetFiles entry ${file} is outside allowed remote scopes ${allowedScopeIds.join(", ")}. Next safe action: revise targetFiles to the allowed project scope or request governed project policy approval.`,
        );
      }
    }
  }

  for (const prerequisite of effectiveDispatchPrerequisites(project)) {
    violations.push(
      `${prefix}: dispatch prerequisite is unresolved: ${prerequisite}. Next safe action: satisfy the project prerequisite or revise the plan to keep it as a blocker before /go.`,
    );
  }
  for (const need of effectiveHostOnlyVerificationNeeds(project)) {
    violations.push(
      `${prefix}: host-only verification is required outside worker dispatch: ${need}. Next safe action: revise the plan to report this as host verification instead of materializing a worker task.`,
    );
  }

  return violations;
}

export function projectSafetyAuthorityDiff(before: ProjectProfile, after: ProjectProfile): string[] {
  const changes: string[] = [];
  const removedForbidden = removedValues(projectEffectiveForbiddenChanges(before), projectEffectiveForbiddenChanges(after));
  const addedScopes = addedValues(effectiveAllowedRemoteScopeIds(before), effectiveAllowedRemoteScopeIds(after));
  const removedPrerequisites = removedValues(effectiveDispatchPrerequisites(before), effectiveDispatchPrerequisites(after));
  const removedHostNeeds = removedValues(effectiveHostOnlyVerificationNeeds(before), effectiveHostOnlyVerificationNeeds(after));
  const beforeRisk = effectiveScopeRiskMap(before);
  const afterRisk = effectiveScopeRiskMap(after);

  if (removedForbidden.length) changes.push(`forbiddenChanges removed: ${removedForbidden.join(",")}`);
  if (addedScopes.length) changes.push(`allowedRemoteScopeIds expanded: ${addedScopes.join(",")}`);
  if (removedPrerequisites.length) changes.push(`dispatchPrerequisites removed: ${removedPrerequisites.join(",")}`);
  if (removedHostNeeds.length) changes.push(`hostOnlyVerificationNeeds removed: ${removedHostNeeds.join(",")}`);
  for (const [scopeId, risk] of Object.entries(beforeRisk)) {
    const nextRisk = afterRisk[scopeId];
    if (nextRisk && PROJECT_POLICY_RISK_ORDER[nextRisk] < PROJECT_POLICY_RISK_ORDER[risk]) {
      changes.push(`riskDefaults lowered for ${scopeId}: ${risk} -> ${nextRisk}`);
    }
  }

  return changes;
}

export function validateProjectSafetyPolicyGovernance(
  before: ProjectProfile,
  after: ProjectProfile,
  decisions: DecisionItem[] = [],
): ProjectSafetyGovernanceCheck {
  const changes = projectSafetyAuthorityDiff(before, after);
  if (changes.length === 0) return { ok: true, violations: [] };
  if (approvedProjectPolicyDecision(after.id, decisions)) return { ok: true, violations: [] };
  return {
    ok: false,
    violations: [
      `project policy ${after.id} has unapproved governed authority expansion: ${changes.join("; ")}; required risk=${CAPABILITY_CHANGE_RISK_CLASS} subject=policy/${projectSafetyPolicyCapabilityId(after.id)}`,
    ],
  };
}
