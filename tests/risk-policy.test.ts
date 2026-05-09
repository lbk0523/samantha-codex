import { describe, expect, test } from "bun:test";
import { GOVERNANCE_ALLOWED_TRANSITIONS, GOVERNANCE_RISK_CLASSES } from "../src/lib/governance-taxonomy";
import {
  classifyGovernanceRisk,
  riskPolicyAllowsTransition,
  riskRequiresApproval,
  type RiskApprovalEvidence,
} from "../src/lib/risk-policy";

const approvedPlanDecision: RiskApprovalEvidence = {
  kind: "orchestrator_plan_approval",
  status: "resolved",
  resolution: "approved",
  resolvedAt: "2026-05-09T10:00:00.000Z",
  resolvedBy: "bk",
  subject: { type: "orchestrator_plan", id: "plan-1" },
};

function approvedRiskDecision(subject: { type: string; id: string }): RiskApprovalEvidence {
  return {
    kind: "risk_acceptance",
    status: "resolved",
    resolution: "approved",
    resolvedAt: "2026-05-09T10:00:00.000Z",
    resolvedBy: "bk",
    subject,
  };
}

describe("risk policy contracts", () => {
  test("classifies every allowed governed transition deterministically", () => {
    for (const [subjectType, transitions] of Object.entries(GOVERNANCE_ALLOWED_TRANSITIONS)) {
      for (const transitionKind of transitions) {
        const result = classifyGovernanceRisk({ subjectType, transitionKind });

        expect(result.violations).toEqual([]);
        expect(result.riskClass).toBeDefined();
        if (result.riskClass) expect(GOVERNANCE_RISK_CLASSES).toContain(result.riskClass);
      }
    }
  });

  test("covers Phase 5 G3 dangerous contract transitions", () => {
    expect(classifyGovernanceRisk({ subjectType: "plan", transitionKind: "materialize" }).riskClass).toBe("high");
    expect(classifyGovernanceRisk({ subjectType: "action", transitionKind: "dispatch" }).riskClass).toBe("high");
    expect(classifyGovernanceRisk({ subjectType: "agent_profile", transitionKind: "activate" }).riskClass).toBe("high");
    expect(classifyGovernanceRisk({ subjectType: "capability", transitionKind: "activate" }).riskClass).toBe("high");
    expect(classifyGovernanceRisk({ subjectType: "skill", transitionKind: "activate" }).riskClass).toBe("high");
    expect(classifyGovernanceRisk({ subjectType: "connector", transitionKind: "activate" }).riskClass).toBe("irreversible");
    expect(classifyGovernanceRisk({ subjectType: "merge", transitionKind: "merge" }).riskClass).toBe("high");
    expect(classifyGovernanceRisk({ subjectType: "push", transitionKind: "push" }).riskClass).toBe("irreversible");
    expect(classifyGovernanceRisk({ subjectType: "cleanup", transitionKind: "cleanup" }).riskClass).toBe("irreversible");
    expect(classifyGovernanceRisk({ subjectType: "recovery", transitionKind: "recover" }).riskClass).toBe("high");
    expect(classifyGovernanceRisk({ subjectType: "policy", transitionKind: "activate" }).riskClass).toBe("high");
  });

  test("unknown risk and risk drift fail closed", () => {
    const unknown = riskPolicyAllowsTransition({
      subjectType: "plan",
      subjectId: "plan-1",
      transitionKind: "materialize",
      declaredRiskClass: "safe",
      approvalEvidence: [approvedPlanDecision],
    });
    const drift = riskPolicyAllowsTransition({
      subjectType: "push",
      subjectId: "run-1",
      transitionKind: "push",
      declaredRiskClass: "low",
      approvalEvidence: [approvedRiskDecision({ type: "push", id: "run-1" })],
    });

    expect(unknown.mayProceed).toBe(false);
    expect(unknown.violations).toContain("unknown governance risk class: safe");
    expect(drift.mayProceed).toBe(false);
    expect(drift.violations).toContain("declared risk low does not match policy risk irreversible for push.push");
  });

  test("high-risk plan materialization requires explicit approved BK decision evidence", () => {
    const missing = riskPolicyAllowsTransition({
      subjectType: "plan",
      subjectId: "plan-1",
      transitionKind: "materialize",
    });
    const pending = riskPolicyAllowsTransition({
      subjectType: "plan",
      subjectId: "plan-1",
      transitionKind: "materialize",
      approvalEvidence: [{ ...approvedPlanDecision, status: "pending", resolution: undefined, resolvedAt: undefined }],
    });
    const approved = riskPolicyAllowsTransition({
      subjectType: "plan",
      subjectId: "plan-1",
      transitionKind: "materialize",
      approvalEvidence: [approvedPlanDecision],
    });

    expect(missing.mayProceed).toBe(false);
    expect(missing.blockedReason).toContain("approved BK decision evidence is required for high plan.materialize");
    expect(pending.mayProceed).toBe(false);
    expect(approved.mayProceed).toBe(true);
    expect(approved.approval).toBe(approvedPlanDecision);
  });

  test("irreversible push and cleanup transitions require approved risk acceptance", () => {
    const push = riskPolicyAllowsTransition({
      subjectType: "push",
      subjectId: "run-1",
      transitionKind: "push",
      approvalEvidence: [approvedRiskDecision({ type: "push", id: "run-1" })],
    });
    const cleanupWrongSubject = riskPolicyAllowsTransition({
      subjectType: "cleanup",
      subjectId: "run-1",
      transitionKind: "cleanup",
      approvalEvidence: [approvedRiskDecision({ type: "cleanup", id: "run-2" })],
    });

    expect(push.mayProceed).toBe(true);
    expect(push.requiresApproval).toBe(true);
    expect(cleanupWrongSubject.mayProceed).toBe(false);
    expect(cleanupWrongSubject.nextSafeAction).toBe("Resolve an applicable BK approval decision before execution.");
  });

  test("safe report-level transitions pass without approval evidence", () => {
    const result = riskPolicyAllowsTransition({
      subjectType: "budget",
      transitionKind: "record_budget",
      declaredRiskClass: "informational",
    });

    expect(riskRequiresApproval("informational")).toBe(false);
    expect(result).toMatchObject({
      mayProceed: true,
      requiresApproval: false,
      violations: [],
    });
  });
});
