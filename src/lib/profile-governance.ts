import type {
  AgentProfile,
  ConnectorAccessCapabilityRecord,
  SafetyPolicy,
  SecretAccessCapabilityRecord,
  SkillBundleRef,
} from "./contracts";
import type { DecisionItem } from "./decision-store";
import type { GovernanceEventRecord } from "./governance-event-store";
import { parseGovernanceRiskClass, type GovernanceRiskClass } from "./governance-taxonomy";
import { readableSlug, shortHash } from "./ids";
import type {
  ParallelismEvidenceRecord,
  ParallelismWriterConflictSafety,
} from "./parallelism-evidence-store";

export const PROFILE_CHANGE_RISK_CLASS: GovernanceRiskClass = "high";
export const CAPABILITY_CHANGE_RISK_CLASS: GovernanceRiskClass = "high";

export interface ProfileGovernanceCheck {
  ok: boolean;
  violations: string[];
}

export interface WriterCapGovernanceEvidence {
  parallelismEvidence?: ParallelismEvidenceRecord[];
  writerConflictSafety?: ParallelismWriterConflictSafety;
  governanceEvents?: GovernanceEventRecord[];
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

export function connectorAccessCapabilityId(agentId: string, connector: string): string {
  return `agent_profile:${oneLine(agentId)}:connector_access:${readableSlug(oneLine(connector), 48)}`;
}

export function secretAccessCapabilityId(agentId: string, secretName: string): string {
  return `agent_profile:${oneLine(agentId)}:secret_access:${shortHash(oneLine(secretName), 12)}`;
}

export function safetyPolicyCapabilityId(): string {
  return "safety_policy";
}

function isNonEmptyGrantValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: unknown): string {
  return typeof value === "string" ? oneLine(value) : "";
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function adHocConnectorSecretGrantKeys(agent: AgentProfile): string[] {
  const record = agent as unknown as Record<string, unknown>;
  return [
    "allowedConnectors",
    "connectors",
    "allowedSecrets",
    "secrets",
  ].filter((key) => isNonEmptyGrantValue(record[key]));
}

function connectorCapabilityRecords(input: {
  agentId: string;
  value: unknown;
  ungovernedKeys: string[];
  violations: string[];
}): ConnectorAccessCapabilityRecord[] {
  if (!isNonEmptyGrantValue(input.value)) return [];
  if (!Array.isArray(input.value)) {
    addUnique(input.ungovernedKeys, "connectorAccess");
    return [];
  }

  const records: ConnectorAccessCapabilityRecord[] = [];
  for (const item of input.value) {
    if (!isPlainRecord(item)) {
      addUnique(input.ungovernedKeys, "connectorAccess");
      continue;
    }
    const connector = stringField(item.connector);
    const capabilityId = stringField(item.capabilityId);
    if (!connector || !capabilityId) {
      input.violations.push(
        `agent profile ${input.agentId} has invalid connector capability record: connector and capabilityId are required`,
      );
      continue;
    }
    if (capabilityId !== connectorAccessCapabilityId(input.agentId, connector)) {
      input.violations.push(
        `agent profile ${input.agentId} has connector capability record with mismatched capabilityId: ${connector}`,
      );
      continue;
    }
    records.push({ connector, capabilityId });
  }
  return records;
}

function secretCapabilityRecords(input: {
  agentId: string;
  value: unknown;
  ungovernedKeys: string[];
  violations: string[];
}): SecretAccessCapabilityRecord[] {
  if (!isNonEmptyGrantValue(input.value)) return [];
  if (!Array.isArray(input.value)) {
    addUnique(input.ungovernedKeys, "secretAccess");
    return [];
  }

  const records: SecretAccessCapabilityRecord[] = [];
  for (const item of input.value) {
    if (!isPlainRecord(item)) {
      addUnique(input.ungovernedKeys, "secretAccess");
      continue;
    }
    const secretName = stringField(item.secretName);
    const capabilityId = stringField(item.capabilityId);
    if (!secretName || !capabilityId) {
      input.violations.push(
        `agent profile ${input.agentId} has invalid secret capability record: secretName and capabilityId are required`,
      );
      continue;
    }
    if (capabilityId !== secretAccessCapabilityId(input.agentId, secretName)) {
      input.violations.push(
        `agent profile ${input.agentId} has secret capability record with mismatched capabilityId`,
      );
      continue;
    }
    records.push({ secretName, capabilityId });
  }
  return records;
}

function connectorSecretCapabilityScan(agent: AgentProfile): {
  connectorRecords: ConnectorAccessCapabilityRecord[];
  secretRecords: SecretAccessCapabilityRecord[];
  violations: string[];
} {
  const record = agent as unknown as Record<string, unknown>;
  const ungovernedKeys = adHocConnectorSecretGrantKeys(agent);
  const violations: string[] = [];
  const connectorRecords = connectorCapabilityRecords({
    agentId: agent.id,
    value: record.connectorAccess,
    ungovernedKeys,
    violations,
  });
  const secretRecords = secretCapabilityRecords({
    agentId: agent.id,
    value: record.secretAccess,
    ungovernedKeys,
    violations,
  });

  if (ungovernedKeys.length > 0) {
    violations.push(
      `agent profile ${agent.id} has connector/secret access outside governed capability records: ${ungovernedKeys.join(", ")}`,
    );
  }

  return { connectorRecords, secretRecords, violations };
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
  const connectorSecretScan = connectorSecretCapabilityScan(agent);

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
  violations.push(...connectorSecretScan.violations);

  const missingConnectorApprovals = connectorSecretScan.connectorRecords.filter(
    (record) => !approvedCapabilityChangeDecision(record.capabilityId, decisions),
  );
  const missingSecretApprovals = connectorSecretScan.secretRecords.filter(
    (record) => !approvedCapabilityChangeDecision(record.capabilityId, decisions),
  );
  if (missingConnectorApprovals.length > 0) {
    violations.push(
      `agent profile ${agent.id} is missing approved connector capability records: ${missingConnectorApprovals.map((record) => record.connector).join(", ")}`,
    );
  }
  if (missingSecretApprovals.length > 0) {
    violations.push(
      `agent profile ${agent.id} is missing approved secret capability records: ${missingSecretApprovals.length} secret grant(s)`,
    );
  }

  return { ok: violations.length === 0, violations };
}

export function validateSafetyPolicyGovernance(
  policy: SafetyPolicy,
  baseline: SafetyPolicy,
  decisions: DecisionItem[] = [],
  evidence: WriterCapGovernanceEvidence = {},
): ProfileGovernanceCheck {
  const changes: string[] = [];
  const writerCapIncrease = policy.writerCap > baseline.writerCap;
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
  const violations: string[] = [];
  const approved = approvedCapabilityChangeDecision(safetyPolicyCapabilityId(), decisions);
  if (!approved) {
    violations.push(`safety policy has unapproved governed capability change: ${changes.join("; ")}`);
  }
  if (approved && writerCapIncrease) {
    violations.push(...writerCapIncreaseViolations({
      policy,
      baseline,
      changes,
      approved,
      evidence,
    }));
  }
  return { ok: violations.length === 0, violations };
}

function writerCapIncreaseViolations(input: {
  policy: SafetyPolicy;
  baseline: SafetyPolicy;
  changes: string[];
  approved: DecisionItem;
  evidence: WriterCapGovernanceEvidence;
}): string[] {
  const violations: string[] = [];
  const records = input.evidence.parallelismEvidence ?? [];
  const conflictSafety = input.evidence.writerConflictSafety
    ?? records.map((record) => record.writerConflictSafety).find((safety): safety is ParallelismWriterConflictSafety => Boolean(safety));

  if (!approvalPromptIncludesDiff(input.approved, input.changes)) {
    violations.push(`approved safety policy change is missing auditable diff: ${input.changes.join("; ")}`);
  }
  if (!hasCompleteDogfoodEvidence(records, input.baseline)) {
    violations.push("safety policy writerCap increase is missing complete dogfood evidence");
  }
  if (!conflictSafety) {
    violations.push("safety policy writerCap change is missing deterministic writer conflict evidence");
  } else {
    if (!conflictSafety.advisorySafe) {
      violations.push(
        `safety policy writerCap change has unsafe writer conflict evidence: ${conflictSafety.violations.join("; ")}`,
      );
    }
    if (conflictSafety.writerCap !== input.baseline.writerCap) {
      violations.push(
        `safety policy writerCap conflict evidence used writerCap ${conflictSafety.writerCap}, expected baseline ${input.baseline.writerCap}`,
      );
    }
    if (conflictSafety.candidateCount < input.policy.writerCap) {
      violations.push(
        `safety policy writerCap conflict evidence has ${conflictSafety.candidateCount} candidate(s), expected at least ${input.policy.writerCap}`,
      );
    }
  }
  if (!hasMergeCleanupEvidence(records)) {
    violations.push("safety policy writerCap increase is missing merge and cleanup evidence");
  }
  if (!hasRollbackEvidence(input.evidence.governanceEvents ?? [])) {
    violations.push("safety policy writerCap increase is missing completed rollback drill evidence");
  }

  return violations;
}

function approvalPromptIncludesDiff(decision: DecisionItem, changes: string[]): boolean {
  const prompt = oneLine(decision.prompt);
  return changes.every((change) => prompt.includes(change));
}

function hasCompleteDogfoodEvidence(records: ParallelismEvidenceRecord[], baseline: SafetyPolicy): boolean {
  return records.some((record) => {
    if (record.outcome !== "pass" || !record.verification.pass) return false;
    if (record.writerCount !== baseline.writerCap) return false;
    const writerRefs = record.refs.filter((ref) => ref.agentRole === "writer" || ref.resultMode === "write");
    if (!writerRefs.some((ref) => ref.outcome === "pass")) return false;

    const reportTaskIds = new Set(
      record.refs
        .filter((ref) => ref.agentRole !== "writer" && ref.resultMode === "report" && ref.outcome === "pass")
        .map((ref) => ref.taskId),
    );
    return record.batches.some((batch) => batch.filter((taskId) => reportTaskIds.has(taskId)).length >= 2);
  });
}

function hasMergeCleanupEvidence(records: ParallelismEvidenceRecord[]): boolean {
  return records.some((record) =>
    record.outcome === "pass" &&
    record.verification.pass &&
    record.writerCount > 0 &&
    record.mergeStatus === "completed" &&
    record.cleanupStatus === "completed"
  );
}

function hasRollbackEvidence(events: GovernanceEventRecord[]): boolean {
  return events.some((event) =>
    event.source.kind === "operator_report" &&
    event.source.id.startsWith("recovery-drill:") &&
    event.kind === "transition_completed" &&
    event.summary.includes("outcome=fixed")
  );
}
