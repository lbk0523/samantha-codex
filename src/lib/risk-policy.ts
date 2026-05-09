import {
  GOVERNANCE_ALLOWED_TRANSITIONS,
  GOVERNANCE_RISK_CLASS_ORDER,
  isGovernanceRiskClass,
  isGovernanceTransitionKind,
  isGovernedSubjectType,
  isAllowedGovernanceTransition,
  type GovernanceRiskClass,
  type GovernanceTransitionKind,
  type GovernedSubjectType,
} from "./governance-taxonomy";

export type RiskDecisionKind = "orchestrator_plan_approval" | "risk_acceptance";

export interface RiskApprovalEvidenceSubject {
  type: string;
  id: string;
}

export interface RiskApprovalEvidence {
  kind: string;
  status: string;
  resolution?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  subject?: RiskApprovalEvidenceSubject;
}

export interface RiskClassificationInput {
  subjectType: unknown;
  transitionKind: unknown;
  declaredRiskClass?: unknown;
}

export interface RiskClassification {
  subjectType?: GovernedSubjectType;
  transitionKind?: GovernanceTransitionKind;
  riskClass?: GovernanceRiskClass;
  violations: string[];
}

export interface RiskPolicyDecisionInput extends RiskClassificationInput {
  subjectId?: string;
  approvalEvidence?: RiskApprovalEvidence[];
  approvedDecisionKinds?: RiskDecisionKind[];
  approvalRequiredFrom?: GovernanceRiskClass;
}

export interface RiskPolicyDecision {
  mayProceed: boolean;
  classification: RiskClassification;
  requiresApproval: boolean;
  approval?: RiskApprovalEvidence;
  violations: string[];
  blockedReason?: string;
  nextSafeAction?: string;
}

const DEFAULT_APPROVAL_REQUIRED_FROM: GovernanceRiskClass = "high";
const DEFAULT_APPROVED_DECISION_KINDS: RiskDecisionKind[] = ["orchestrator_plan_approval", "risk_acceptance"];

const RISK_BY_SUBJECT_TRANSITION = {
  request: {
    observe: "informational",
    propose: "low",
    reject: "low",
    block: "low",
  },
  plan: {
    propose: "low",
    approve: "medium",
    reject: "low",
    materialize: "high",
    block: "low",
    archive: "medium",
  },
  task: {
    propose: "low",
    approve: "medium",
    reject: "low",
    dispatch: "high",
    start: "medium",
    complete: "low",
    fail: "low",
    block: "low",
    archive: "medium",
  },
  action: {
    propose: "low",
    approve: "medium",
    reject: "low",
    dispatch: "high",
    start: "medium",
    complete: "low",
    fail: "low",
    block: "low",
    archive: "medium",
  },
  run: {
    start: "medium",
    complete: "low",
    fail: "low",
    block: "low",
    archive: "medium",
  },
  merge: {
    propose: "medium",
    approve: "medium",
    reject: "low",
    merge: "high",
    fail: "low",
    block: "low",
  },
  push: {
    propose: "medium",
    approve: "high",
    reject: "low",
    push: "irreversible",
    fail: "low",
    block: "low",
  },
  cleanup: {
    propose: "medium",
    approve: "high",
    reject: "low",
    cleanup: "irreversible",
    complete: "low",
    fail: "low",
    block: "low",
  },
  recovery: {
    propose: "medium",
    approve: "medium",
    reject: "low",
    recover: "high",
    complete: "low",
    fail: "low",
    block: "low",
  },
  agent_profile: {
    propose: "medium",
    approve: "high",
    reject: "low",
    activate: "high",
    deactivate: "high",
    block: "low",
  },
  capability: {
    propose: "medium",
    approve: "high",
    reject: "low",
    activate: "high",
    deactivate: "high",
    block: "low",
  },
  skill: {
    propose: "medium",
    approve: "high",
    reject: "low",
    activate: "high",
    deactivate: "high",
    block: "low",
  },
  connector: {
    propose: "medium",
    approve: "high",
    reject: "low",
    activate: "irreversible",
    deactivate: "high",
    block: "low",
  },
  routine: {
    propose: "medium",
    approve: "high",
    reject: "low",
    activate: "high",
    deactivate: "high",
    block: "low",
  },
  policy: {
    propose: "medium",
    approve: "high",
    reject: "low",
    activate: "high",
    deactivate: "high",
    block: "low",
  },
  budget: {
    observe: "informational",
    propose: "low",
    approve: "medium",
    reject: "low",
    record_budget: "informational",
    block: "low",
  },
} as const satisfies {
  [Subject in GovernedSubjectType]: {
    [Transition in (typeof GOVERNANCE_ALLOWED_TRANSITIONS)[Subject][number]]: GovernanceRiskClass;
  };
};

function describeUnknown(value: unknown): string {
  if (value === "") return "(empty)";
  if (typeof value === "string") return value;
  return String(value);
}

function subjectTransitionRisk(
  subjectType: GovernedSubjectType,
  transitionKind: GovernanceTransitionKind,
): GovernanceRiskClass | undefined {
  const risks = RISK_BY_SUBJECT_TRANSITION[subjectType] as Partial<Record<GovernanceTransitionKind, GovernanceRiskClass>>;
  return risks[transitionKind];
}

function riskAtLeast(riskClass: GovernanceRiskClass, threshold: GovernanceRiskClass): boolean {
  return GOVERNANCE_RISK_CLASS_ORDER[riskClass] >= GOVERNANCE_RISK_CLASS_ORDER[threshold];
}

function decisionSubjectMatches(
  evidenceSubject: RiskApprovalEvidenceSubject | undefined,
  subjectType: GovernedSubjectType,
  subjectId: string,
): boolean {
  if (!evidenceSubject) return false;
  if (evidenceSubject.id !== subjectId) return false;
  if (evidenceSubject.type === subjectType) return true;
  if (subjectType === "plan" && evidenceSubject.type === "orchestrator_plan") return true;
  if (subjectType === "action" && evidenceSubject.type === "remote_action") return true;
  return false;
}

function validApprovalEvidence(
  evidence: RiskApprovalEvidence,
  input: {
    subjectType: GovernedSubjectType;
    subjectId: string;
    approvedDecisionKinds: RiskDecisionKind[];
  },
): boolean {
  if (!input.approvedDecisionKinds.includes(evidence.kind as RiskDecisionKind)) return false;
  if (evidence.status !== "resolved") return false;
  if (evidence.resolution !== "approved") return false;
  if (evidence.resolvedBy !== "bk") return false;
  if (!evidence.resolvedAt) return false;
  return decisionSubjectMatches(evidence.subject, input.subjectType, input.subjectId);
}

export function classifyGovernanceRisk(input: RiskClassificationInput): RiskClassification {
  const violations: string[] = [];
  const subjectKnown = isGovernedSubjectType(input.subjectType);
  const transitionKnown = isGovernanceTransitionKind(input.transitionKind);
  const subjectType = subjectKnown ? (input.subjectType as GovernedSubjectType) : undefined;
  const transitionKind = transitionKnown ? (input.transitionKind as GovernanceTransitionKind) : undefined;

  if (!subjectKnown) {
    violations.push(`unknown governed subject type: ${describeUnknown(input.subjectType)}`);
  }
  if (!transitionKnown) {
    violations.push(`unknown governance transition kind: ${describeUnknown(input.transitionKind)}`);
  }
  if (input.declaredRiskClass !== undefined && !isGovernanceRiskClass(input.declaredRiskClass)) {
    violations.push(`unknown governance risk class: ${describeUnknown(input.declaredRiskClass)}`);
  }
  if (subjectType && transitionKind && !isAllowedGovernanceTransition(subjectType, transitionKind)) {
    violations.push(`transition ${transitionKind} is not allowed for governed subject ${subjectType}`);
  }

  const riskClass =
    subjectType && transitionKind && isAllowedGovernanceTransition(subjectType, transitionKind)
      ? subjectTransitionRisk(subjectType, transitionKind)
      : undefined;

  if (subjectType && transitionKind && isAllowedGovernanceTransition(subjectType, transitionKind) && !riskClass) {
    violations.push(`risk classification missing for ${subjectType}.${transitionKind}`);
  }
  if (
    riskClass &&
    input.declaredRiskClass !== undefined &&
    isGovernanceRiskClass(input.declaredRiskClass) &&
    input.declaredRiskClass !== riskClass
  ) {
    violations.push(
      `declared risk ${input.declaredRiskClass} does not match policy risk ${riskClass} for ${subjectType}.${transitionKind}`,
    );
  }

  return {
    subjectType,
    transitionKind,
    riskClass,
    violations,
  };
}

export function riskRequiresApproval(
  riskClass: unknown,
  approvalRequiredFrom: GovernanceRiskClass = DEFAULT_APPROVAL_REQUIRED_FROM,
): boolean {
  return isGovernanceRiskClass(riskClass) && riskAtLeast(riskClass, approvalRequiredFrom);
}

export function riskPolicyAllowsTransition(input: RiskPolicyDecisionInput): RiskPolicyDecision {
  const classification = classifyGovernanceRisk(input);
  const violations = [...classification.violations];
  const requiresApproval = classification.riskClass
    ? riskRequiresApproval(classification.riskClass, input.approvalRequiredFrom ?? DEFAULT_APPROVAL_REQUIRED_FROM)
    : false;
  let approval: RiskApprovalEvidence | undefined;

  if (requiresApproval) {
    const subjectId = input.subjectId?.trim();
    if (!subjectId) {
      violations.push("subject id is required for approval evidence");
    } else if (classification.subjectType) {
      approval = (input.approvalEvidence ?? []).find((item) =>
        validApprovalEvidence(item, {
          subjectType: classification.subjectType!,
          subjectId,
          approvedDecisionKinds: input.approvedDecisionKinds ?? DEFAULT_APPROVED_DECISION_KINDS,
        }),
      );
      if (!approval) {
        violations.push(
          `approved BK decision evidence is required for ${classification.riskClass} ${classification.subjectType}.${classification.transitionKind}`,
        );
      }
    }
  }

  const mayProceed = violations.length === 0;
  return {
    mayProceed,
    classification,
    requiresApproval,
    approval,
    violations,
    blockedReason: mayProceed ? undefined : violations.join("; "),
    nextSafeAction: mayProceed
      ? undefined
      : requiresApproval
        ? "Resolve an applicable BK approval decision before execution."
        : "Correct the transition contract before execution.",
  };
}
