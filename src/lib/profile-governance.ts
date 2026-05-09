import type { AgentProfile, SafetyPolicy, SkillBundleRef } from "./contracts";
import type { DecisionItem } from "./decision-store";
import { parseGovernanceRiskClass, type GovernanceRiskClass } from "./governance-taxonomy";

export const PROFILE_CHANGE_RISK_CLASS: GovernanceRiskClass = "high";
export const CAPABILITY_CHANGE_RISK_CLASS: GovernanceRiskClass = "high";

export interface ProfileGovernanceCheck {
  ok: boolean;
  violations: string[];
}

interface ProfileAuthorityBaseline {
  role: AgentProfile["role"];
  model: string;
  codexProfile?: string;
  writerClass: AgentProfile["writerClass"];
  worktreePolicy: AgentProfile["worktreePolicy"];
  mergePolicy: AgentProfile["mergePolicy"];
  requiredBundles: SkillBundleRef[];
}

const BUILT_IN_PROFILE_AUTHORITY: Record<string, ProfileAuthorityBaseline> = {
  "codex-content": nonWriter("content"),
  "codex-evaluator": nonWriter("evaluator"),
  "codex-operations": nonWriter("operations"),
  "codex-orchestrator": nonWriter("spec"),
  "codex-researcher": nonWriter("researcher"),
  "codex-reviewer": nonWriter("reviewer"),
  "codex-spec": nonWriter("spec"),
  "codex-worker": {
    role: "writer",
    model: "gpt-5.5",
    writerClass: "writer",
    worktreePolicy: "per-task",
    mergePolicy: "samantha-controlled",
    requiredBundles: [],
  },
};

function nonWriter(role: AgentProfile["role"]): ProfileAuthorityBaseline {
  return {
    role,
    model: "gpt-5.5",
    writerClass: "non-writer",
    worktreePolicy: "none",
    mergePolicy: "none",
    requiredBundles: [],
  };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stableBundleKey(bundle: SkillBundleRef): string {
  return [bundle.id, bundle.source, bundle.ref].map(oneLine).join("@");
}

function stableBundleList(bundles: SkillBundleRef[] | undefined): string[] {
  return (bundles ?? []).map(stableBundleKey).sort();
}

function listChanged(label: string, before: string[] | undefined, after: string[] | undefined): string[] {
  const beforeValues = before ?? [];
  const afterValues = after ?? [];
  return beforeValues.length === afterValues.length && beforeValues.every((item, index) => item === afterValues[index])
    ? []
    : [`${label}: ${beforeValues.join(",") || "(none)"} -> ${afterValues.join(",") || "(none)"}`];
}

export function agentProfileChangeSummary(agent: AgentProfile): string {
  const diff = agentProfileAuthorityDiff(agent);
  return diff.length ? diff.join("; ") : `no authority change for ${agent.id}`;
}

export function agentProfileAuthorityDiff(agent: AgentProfile): string[] {
  const baseline = BUILT_IN_PROFILE_AUTHORITY[agent.id];
  if (!baseline) return [`new profile: ${agent.id}`];

  const changes: string[] = [];
  if (agent.role !== baseline.role) changes.push(`role: ${baseline.role} -> ${agent.role}`);
  if (agent.model !== baseline.model) changes.push(`model: ${baseline.model} -> ${agent.model}`);
  if ((agent.codexProfile ?? "") !== (baseline.codexProfile ?? "")) {
    changes.push(`codexProfile: ${baseline.codexProfile ?? "(none)"} -> ${agent.codexProfile ?? "(none)"}`);
  }
  if (agent.writerClass !== baseline.writerClass) {
    changes.push(`writerClass: ${baseline.writerClass} -> ${agent.writerClass}`);
  }
  if (agent.worktreePolicy !== baseline.worktreePolicy) {
    changes.push(`worktreePolicy: ${baseline.worktreePolicy} -> ${agent.worktreePolicy}`);
  }
  if (agent.mergePolicy !== baseline.mergePolicy) {
    changes.push(`mergePolicy: ${baseline.mergePolicy} -> ${agent.mergePolicy}`);
  }
  changes.push(...listChanged(
    "requiredBundles",
    stableBundleList(baseline.requiredBundles),
    stableBundleList(agent.skillPolicy?.requiredBundles),
  ));
  return changes;
}

export function skillBundleCapabilityId(agentId: string): string {
  return `agent_profile:${agentId}:skill_bundles`;
}

export function connectorSecretCapabilityId(agentId: string): string {
  return `agent_profile:${agentId}:connector_secret_access`;
}

export function safetyPolicyCapabilityId(): string {
  return "safety_policy";
}

function isNonEmptyGrantValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function connectorSecretGrantKeys(agent: AgentProfile): string[] {
  const record = agent as unknown as Record<string, unknown>;
  return [
    "allowedConnectors",
    "connectorAccess",
    "connectors",
    "allowedSecrets",
    "secretAccess",
    "secrets",
  ].filter((key) => isNonEmptyGrantValue(record[key]));
}

function approvedDecisionFor(input: {
  decisions: DecisionItem[];
  kind: "agent_profile_change" | "capability_change";
  subjectType: "agent_profile" | "capability" | "policy";
  subjectId: string;
  riskClass: GovernanceRiskClass;
}): DecisionItem | undefined {
  return input.decisions
    .slice()
    .reverse()
    .find((decision) => {
      if (decision.kind !== input.kind) return false;
      if (decision.status !== "resolved") return false;
      if (decision.resolution !== "approved") return false;
      if (decision.resolvedBy !== "bk" || !decision.resolvedAt) return false;
      if (decision.subject?.type !== input.subjectType || decision.subject.id !== input.subjectId) return false;
      if (!decision.risk) return false;
      try {
        if (parseGovernanceRiskClass(decision.risk) !== input.riskClass) return false;
      } catch {
        return false;
      }
      return Boolean(oneLine(decision.prompt));
    });
}

export function approvedProfileChangeDecision(agent: AgentProfile, decisions: DecisionItem[]): DecisionItem | undefined {
  return approvedDecisionFor({
    decisions,
    kind: "agent_profile_change",
    subjectType: "agent_profile",
    subjectId: agent.id,
    riskClass: PROFILE_CHANGE_RISK_CLASS,
  });
}

export function approvedCapabilityChangeDecision(
  capabilityId: string,
  decisions: DecisionItem[],
): DecisionItem | undefined {
  return approvedDecisionFor({
    decisions,
    kind: "capability_change",
    subjectType: capabilityId === safetyPolicyCapabilityId() ? "policy" : "capability",
    subjectId: capabilityId,
    riskClass: CAPABILITY_CHANGE_RISK_CLASS,
  });
}

export function validateAgentProfileGovernance(
  agent: AgentProfile,
  decisions: DecisionItem[] = [],
): ProfileGovernanceCheck {
  const violations: string[] = [];
  const authorityDiff = agentProfileAuthorityDiff(agent);
  const requiredBundles = stableBundleList(agent.skillPolicy?.requiredBundles);
  const grantKeys = connectorSecretGrantKeys(agent);

  if (authorityDiff.length > 0 && !approvedProfileChangeDecision(agent, decisions)) {
    violations.push(
      `agent profile ${agent.id} has unapproved governed authority change: ${authorityDiff.join("; ")}`,
    );
  }
  if (requiredBundles.length > 0 && !approvedCapabilityChangeDecision(skillBundleCapabilityId(agent.id), decisions)) {
    violations.push(
      `agent profile ${agent.id} has unapproved allowed skill bundle capability: ${requiredBundles.join(", ")}`,
    );
  }
  if (grantKeys.length > 0 && !approvedCapabilityChangeDecision(connectorSecretCapabilityId(agent.id), decisions)) {
    violations.push(
      `agent profile ${agent.id} has unapproved connector/secret capability grant: ${grantKeys.join(", ")}`,
    );
  }

  return { ok: violations.length === 0, violations };
}

export function validateSafetyPolicyGovernance(
  policy: SafetyPolicy,
  baseline: SafetyPolicy,
  decisions: DecisionItem[] = [],
): ProfileGovernanceCheck {
  const changes: string[] = [];
  if (policy.writerCap !== baseline.writerCap) changes.push(`writerCap: ${baseline.writerCap} -> ${policy.writerCap}`);
  if (policy.requiredForbiddenChanges !== baseline.requiredForbiddenChanges) {
    changes.push(`requiredForbiddenChanges: ${baseline.requiredForbiddenChanges} -> ${policy.requiredForbiddenChanges}`);
  }
  if (policy.requiredTargetFilesForWriters !== baseline.requiredTargetFilesForWriters) {
    changes.push(
      `requiredTargetFilesForWriters: ${baseline.requiredTargetFilesForWriters} -> ${policy.requiredTargetFilesForWriters}`,
    );
  }
  changes.push(...listChanged("blockedSkillNames", baseline.blockedSkillNames, policy.blockedSkillNames));

  if (changes.length === 0) return { ok: true, violations: [] };
  if (approvedCapabilityChangeDecision(safetyPolicyCapabilityId(), decisions)) return { ok: true, violations: [] };
  return {
    ok: false,
    violations: [`safety policy has unapproved governed capability change: ${changes.join("; ")}`],
  };
}
