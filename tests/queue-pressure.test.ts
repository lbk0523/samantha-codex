import { describe, expect, test } from "bun:test";
import { createBudgetPolicyRecord, createCostBudgetAuditRecord } from "../src/lib/cost-budget-audit";
import { createDecisionItem } from "../src/lib/decision-store";
import { createGovernanceEvent } from "../src/lib/governance-event-store";
import { buildQueuePressureSnapshot, decideQueueAdmission, formatQueuePressureGuidance } from "../src/lib/queue-pressure";

const ancestry = {
  mode: "assigned" as const,
  projectId: "samantha",
  goalId: "goal-budget",
  workItemId: "work-budget",
};

function approvedBudgetPolicy() {
  const policy = createBudgetPolicyRecord({
    id: "budget-policy-queue",
    createdAt: "2026-05-10T01:00:00.000Z",
    status: "active",
    scope: { type: "project", id: "samantha" },
    thresholds: { currency: "USD", deferAtAmount: 1, blockAtAmount: 2, unknownCost: "defer" },
    governance: {
      decisionId: "decision-budget-policy-queue",
      governanceEventId: "gov-event-budget-policy-queue",
      approvedBy: "bk",
      approvedAt: "2026-05-10T01:02:00.000Z",
      summary: "BK approved deterministic queue budget policy.",
    },
  });
  const decision = {
    ...createDecisionItem({
      kind: "budget_change",
      title: "Approve queue budget policy",
      prompt: "Approve deterministic budget enforcement.",
      source: "system",
      subject: { type: "budget", id: policy.id },
      options: ["approve", "reject"],
      createdAt: "2026-05-10T01:01:00.000Z",
    }),
    id: "decision-budget-policy-queue",
    status: "resolved" as const,
    resolution: "approved" as const,
    resolvedBy: "bk" as const,
    resolvedAt: "2026-05-10T01:02:00.000Z",
    updatedAt: "2026-05-10T01:02:00.000Z",
  };
  const event = createGovernanceEvent({
    id: "gov-event-budget-policy-queue",
    timestamp: "2026-05-10T01:02:00.000Z",
    actor: "bk",
    source: { kind: "decision", id: decision.id },
    subject: { type: "budget", id: policy.id },
    kind: "transition_approved",
    riskClass: "high",
    summary: "Budget policy approved.",
    related: { decisionIds: [decision.id] },
  });
  return { policy, decision, event };
}

function approvedActionBudgetPolicy(actionId: string) {
  const policy = createBudgetPolicyRecord({
    id: `budget-policy-${actionId}`,
    createdAt: "2026-05-10T01:00:00.000Z",
    status: "active",
    scope: { type: "action", id: actionId },
    thresholds: { currency: "USD", blockAtAmount: 2 },
    governance: {
      decisionId: `decision-budget-policy-${actionId}`,
      governanceEventId: `gov-event-budget-policy-${actionId}`,
      approvedBy: "bk",
      approvedAt: "2026-05-10T01:02:00.000Z",
      summary: "BK approved deterministic action budget policy.",
    },
  });
  const decision = {
    ...createDecisionItem({
      kind: "budget_change",
      title: "Approve action budget policy",
      prompt: "Approve deterministic action budget enforcement.",
      source: "system",
      subject: { type: "budget", id: policy.id },
      options: ["approve", "reject"],
      createdAt: "2026-05-10T01:01:00.000Z",
    }),
    id: policy.governance!.decisionId,
    status: "resolved" as const,
    resolution: "approved" as const,
    resolvedBy: "bk" as const,
    resolvedAt: "2026-05-10T01:02:00.000Z",
    updatedAt: "2026-05-10T01:02:00.000Z",
  };
  const event = createGovernanceEvent({
    id: policy.governance!.governanceEventId,
    timestamp: "2026-05-10T01:02:00.000Z",
    actor: "bk",
    source: { kind: "decision", id: decision.id },
    subject: { type: "budget", id: policy.id },
    kind: "transition_approved",
    riskClass: "high",
    summary: "Action budget policy approved.",
    related: { decisionIds: [decision.id] },
  });
  return { policy, decision, event };
}

describe("queue pressure budget enforcement", () => {
  test("unknown cost defers intake when an approved policy applies", () => {
    const { policy, decision, event } = approvedBudgetPolicy();
    const pressure = buildQueuePressureSnapshot({
      decisions: [decision],
      governanceEvents: [event],
      budgetPolicies: [policy],
      budgetObservations: [
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-10T01:03:00.000Z",
          actor: "samantha",
          subject: { type: "run", id: "run-unknown" },
          cost: { kind: "unknown", reason: "provider cost missing" },
          context: { projectId: "samantha" },
        }),
      ],
    }, { projectId: "samantha" });
    const requestAdmission = decideQueueAdmission({ pressure, subjectKind: "request" });
    const actionAdmission = decideQueueAdmission({ pressure, subjectKind: "action" });

    expect(pressure.pressureClass).toBe("defer");
    expect(pressure.budget?.state).toBe("defer");
    expect(requestAdmission.decision).toBe("defer");
    expect(actionAdmission.decision).toBe("defer");
  });

  test("budget gates do not outrank pending BK approval blockers", () => {
    const { policy, event } = approvedBudgetPolicy();
    const pendingDecision = createDecisionItem({
      ancestry,
      title: "Approve current plan",
      prompt: "Approve before materialization.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-current" },
      options: ["approve", "revise", "cancel"],
      createdAt: "2026-05-10T01:05:00.000Z",
    });
    const pressure = buildQueuePressureSnapshot({
      decisions: [pendingDecision],
      governanceEvents: [event],
      budgetPolicies: [policy],
      budgetObservations: [
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-10T01:03:00.000Z",
          actor: "operator",
          subject: { type: "project", id: "samantha" },
          cost: { kind: "estimated", amount: 3, currency: "USD", basis: "manual estimate" },
          context: { projectId: "samantha" },
        }),
      ],
    }, { projectId: "samantha" });
    const admission = decideQueueAdmission({ pressure, subjectKind: "action" });

    expect(pressure.budget?.state).toBe("needs_bk");
    expect(admission.decision).toBe("ask_bk");
    expect(admission.reason).toContain("pending BK decisions=1");
    expect(formatQueuePressureGuidance(pressure).join("\n")).toContain("/approve project:samantha");
  });

  test("pressure guidance turns pending request pressure into concrete Telegram actions", () => {
    const pressure = buildQueuePressureSnapshot({
      requests: [
        { schemaVersion: 1, id: "request-1", source: "remote", status: "pending_plan", text: "one", createdAt: "2026-05-10T01:00:00.000Z", ancestry },
        { schemaVersion: 1, id: "request-2", source: "remote", status: "pending_plan", text: "two", createdAt: "2026-05-10T01:01:00.000Z", ancestry },
        { schemaVersion: 1, id: "request-3", source: "remote", status: "pending_plan", text: "three", createdAt: "2026-05-10T01:02:00.000Z", ancestry },
      ],
    }, { projectId: "samantha" });
    const guidance = formatQueuePressureGuidance(pressure).join("\n");

    expect(pressure.pressureClass).toBe("defer");
    expect(guidance).toContain("Pressure 해결:");
    expect(guidance).toContain("pending requests=3");
    expect(guidance).toContain("/plan samantha");
    expect(guidance).toContain("/drop stale project:samantha");
  });

  test("pressure guidance sends global ambiguous queues to now for project-specific commands", () => {
    const pressure = buildQueuePressureSnapshot({
      requests: [
        { schemaVersion: 1, id: "request-1", source: "remote", status: "pending_plan", text: "one", createdAt: "2026-05-10T01:00:00.000Z", ancestry },
        { schemaVersion: 1, id: "request-2", source: "remote", status: "pending_plan", text: "two", createdAt: "2026-05-10T01:01:00.000Z", ancestry },
        { schemaVersion: 1, id: "request-3", source: "remote", status: "pending_plan", text: "three", createdAt: "2026-05-10T01:02:00.000Z", ancestry },
      ],
    });
    const guidance = formatQueuePressureGuidance(pressure).join("\n");

    expect(guidance).toContain("/now에서 project별 /plan");
    expect(guidance).toContain("/drop stale project:<project>");
    expect(guidance).not.toContain("/now으로");
    expect(guidance).not.toContain("/now로 줄이세요");
  });

  test("action-scoped budget policies enforce through action admission context", () => {
    const { policy, decision, event } = approvedActionBudgetPolicy("action-over-budget");
    const pressure = buildQueuePressureSnapshot({
      decisions: [decision],
      governanceEvents: [event],
      budgetPolicies: [policy],
      budgetObservations: [
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-10T01:03:00.000Z",
          actor: "operator",
          subject: { type: "action", id: "action-over-budget" },
          cost: { kind: "estimated", amount: 2.5, currency: "USD", basis: "manual estimate" },
          context: { projectId: "samantha", actionId: "action-over-budget" },
        }),
      ],
    }, {
      projectId: "samantha",
      budgetContext: { projectId: "samantha", actionId: "action-over-budget" },
    });
    const admission = decideQueueAdmission({ pressure, subjectKind: "action" });

    expect(pressure.budget?.state).toBe("block");
    expect(admission.decision).toBe("block");
  });
});
