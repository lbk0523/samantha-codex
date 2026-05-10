export const GOVERNED_SUBJECT_TYPES = [
  "request",
  "plan",
  "task",
  "action",
  "run",
  "merge",
  "push",
  "cleanup",
  "recovery",
  "agent_profile",
  "capability",
  "skill",
  "connector",
  "routine",
  "policy",
  "budget",
  "memory",
] as const;

export type GovernedSubjectType = (typeof GOVERNED_SUBJECT_TYPES)[number];

export const GOVERNANCE_EVENT_KINDS = [
  "record_created",
  "transition_requested",
  "transition_approved",
  "transition_rejected",
  "transition_blocked",
  "transition_completed",
  "transition_failed",
  "risk_classified",
  "audit_gap_recorded",
] as const;

export type GovernanceEventKind = (typeof GOVERNANCE_EVENT_KINDS)[number];

export const GOVERNANCE_TRANSITION_KINDS = [
  "observe",
  "propose",
  "approve",
  "reject",
  "materialize",
  "dispatch",
  "start",
  "complete",
  "fail",
  "block",
  "archive",
  "merge",
  "push",
  "cleanup",
  "recover",
  "activate",
  "deactivate",
  "record_budget",
] as const;

export type GovernanceTransitionKind = (typeof GOVERNANCE_TRANSITION_KINDS)[number];

export const GOVERNANCE_RISK_CLASSES = [
  "informational",
  "low",
  "medium",
  "high",
  "irreversible",
] as const;

export type GovernanceRiskClass = (typeof GOVERNANCE_RISK_CLASSES)[number];

export const GOVERNANCE_RISK_CLASS_ORDER: Record<GovernanceRiskClass, number> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  irreversible: 4,
};

export const SOURCE_OF_TRUTH_RECORD_KINDS = [
  "decision",
  "orchestrator_plan",
  "task",
  "remote_action",
  "run_lifecycle",
  "run_log",
  "proposal",
  "learning_candidate",
  "recovery_context",
  "agent_profile",
  "project_profile",
  "safety_policy",
] as const;

export type SourceOfTruthRecordKind = (typeof SOURCE_OF_TRUTH_RECORD_KINDS)[number];

export const DERIVED_VIEW_KINDS = [
  "ceo_status",
  "operator_report",
  "dashboard_view",
  "telegram_summary",
] as const;

export type DerivedViewKind = (typeof DERIVED_VIEW_KINDS)[number];

export const GOVERNANCE_ALLOWED_TRANSITIONS = {
  request: ["observe", "propose", "reject", "block"],
  plan: ["propose", "approve", "reject", "materialize", "block", "archive"],
  task: ["propose", "approve", "reject", "dispatch", "start", "complete", "fail", "block", "archive"],
  action: ["propose", "approve", "reject", "dispatch", "start", "complete", "fail", "block", "archive"],
  run: ["start", "complete", "fail", "block", "archive"],
  merge: ["propose", "approve", "reject", "merge", "fail", "block"],
  push: ["propose", "approve", "reject", "push", "fail", "block"],
  cleanup: ["propose", "approve", "reject", "cleanup", "complete", "fail", "block"],
  recovery: ["propose", "approve", "reject", "recover", "complete", "fail", "block"],
  agent_profile: ["propose", "approve", "reject", "activate", "deactivate", "block"],
  capability: ["propose", "approve", "reject", "activate", "deactivate", "block"],
  skill: ["propose", "approve", "reject", "activate", "deactivate", "block"],
  connector: ["propose", "approve", "reject", "activate", "deactivate", "block"],
  routine: ["propose", "approve", "reject", "activate", "deactivate", "block"],
  policy: ["propose", "approve", "reject", "activate", "deactivate", "block"],
  budget: ["observe", "propose", "approve", "reject", "record_budget", "block"],
  memory: ["propose", "approve", "reject", "activate", "deactivate", "archive", "block"],
} as const satisfies Record<GovernedSubjectType, readonly GovernanceTransitionKind[]>;

export interface GovernanceTransitionInput {
  subjectType: unknown;
  transitionKind: unknown;
  riskClass: unknown;
}

export interface GovernanceTransitionValidation {
  allowed: boolean;
  violations: string[];
}

function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function describeUnknown(value: unknown): string {
  if (value === "") {
    return "(empty)";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

export function isGovernedSubjectType(value: unknown): value is GovernedSubjectType {
  return hasValue(GOVERNED_SUBJECT_TYPES, value);
}

export function parseGovernedSubjectType(value: unknown): GovernedSubjectType {
  if (!isGovernedSubjectType(value)) {
    throw new Error(`unknown governed subject type: ${describeUnknown(value)}`);
  }
  return value;
}

export function isGovernanceEventKind(value: unknown): value is GovernanceEventKind {
  return hasValue(GOVERNANCE_EVENT_KINDS, value);
}

export function parseGovernanceEventKind(value: unknown): GovernanceEventKind {
  if (!isGovernanceEventKind(value)) {
    throw new Error(`unknown governance event kind: ${describeUnknown(value)}`);
  }
  return value;
}

export function isGovernanceTransitionKind(value: unknown): value is GovernanceTransitionKind {
  return hasValue(GOVERNANCE_TRANSITION_KINDS, value);
}

export function parseGovernanceTransitionKind(value: unknown): GovernanceTransitionKind {
  if (!isGovernanceTransitionKind(value)) {
    throw new Error(`unknown governance transition kind: ${describeUnknown(value)}`);
  }
  return value;
}

export function isGovernanceRiskClass(value: unknown): value is GovernanceRiskClass {
  return hasValue(GOVERNANCE_RISK_CLASSES, value);
}

export function parseGovernanceRiskClass(value: unknown): GovernanceRiskClass {
  if (!isGovernanceRiskClass(value)) {
    throw new Error(`unknown governance risk class: ${describeUnknown(value)}`);
  }
  return value;
}

export function isAllowedGovernanceTransition(
  subjectType: unknown,
  transitionKind: unknown,
): subjectType is GovernedSubjectType {
  if (!isGovernedSubjectType(subjectType) || !isGovernanceTransitionKind(transitionKind)) {
    return false;
  }
  const allowedTransitions = GOVERNANCE_ALLOWED_TRANSITIONS[subjectType] as readonly GovernanceTransitionKind[];
  return allowedTransitions.includes(transitionKind);
}

export function validateGovernanceTransition(
  input: GovernanceTransitionInput,
): GovernanceTransitionValidation {
  const violations: string[] = [];
  const subjectKnown = isGovernedSubjectType(input.subjectType);
  const transitionKnown = isGovernanceTransitionKind(input.transitionKind);

  if (!subjectKnown) {
    violations.push(`unknown governed subject type: ${describeUnknown(input.subjectType)}`);
  }
  if (!transitionKnown) {
    violations.push(`unknown governance transition kind: ${describeUnknown(input.transitionKind)}`);
  }
  if (!isGovernanceRiskClass(input.riskClass)) {
    violations.push(`unknown governance risk class: ${describeUnknown(input.riskClass)}`);
  }
  if (subjectKnown && transitionKnown && !isAllowedGovernanceTransition(input.subjectType, input.transitionKind)) {
    violations.push(
      `transition ${input.transitionKind} is not allowed for governed subject ${input.subjectType}`,
    );
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}
