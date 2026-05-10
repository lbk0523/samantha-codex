import { describe, expect, test } from "bun:test";
import {
  ANCESTRY_FIELD_CONTRACTS,
  legacyAncestry,
  normalizeRecordAncestry,
  validateAncestryRecords,
  validateGoalRecord,
  validateSameProjectMaterializedExecutionPlan,
  type AncestryRecordKind,
  type GoalRecord,
  type WorkItemAncestry,
} from "../src/lib/ancestry";
import { createCostBudgetAuditRecord, parseCostBudgetAuditRecord } from "../src/lib/cost-budget-audit";
import { createGovernanceEvent, parseGovernanceEventRecord } from "../src/lib/governance-event-store";

const goal: GoalRecord = {
  schemaVersion: 1,
  id: "goal-multi-project-ancestry",
  projectId: "samantha",
  title: "Define multi-project ancestry",
  status: "active",
  createdAt: "2026-05-10T00:00:00.000Z",
  priority: "high",
};

const ancestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "samantha",
  goalId: goal.id,
  workItemId: "work-item-m3",
};

describe("M3 goal and work-item ancestry contract", () => {
  test("defines the durable record field contract without path identity", () => {
    const kinds = Object.keys(ANCESTRY_FIELD_CONTRACTS).sort() as AncestryRecordKind[];

    expect(kinds).toEqual([
      "action",
      "budget_observation",
      "decision",
      "governance_event",
      "lifecycle",
      "plan",
      "recovery",
      "report",
      "request",
      "run",
      "task",
    ]);
    expect(kinds.map((kind) => ANCESTRY_FIELD_CONTRACTS[kind])).toEqual(kinds.map(() => ({ field: "ancestry", missingRecordMode: "legacy" })));
    expect(validateGoalRecord(goal)).toEqual([]);
    expect(validateGoalRecord({ ...goal, id: "/tmp/goal", projectId: "samantha" })).toContain("goal.id must be a stable id, not a path");
  });

  test("keeps old records explicit as legacy instead of inferring project or goal", () => {
    expect(normalizeRecordAncestry({})).toEqual(legacyAncestry("missing_ancestry"));
    expect(validateAncestryRecords({
      goals: [goal],
      records: [
        { kind: "request", id: "request-old" },
        { kind: "task", id: "task-old", ancestry: { mode: "legacy", reason: "pre_m3_record" } },
        { kind: "decision", id: "decision-unassigned", ancestry: { mode: "unassigned", reason: "BK has not selected a project yet" } },
      ],
    })).toEqual([]);
  });

  test("rejects project and goal mismatches deterministically", () => {
    expect(validateGoalRecord({
      ...goal,
      parent: { projectId: "omht", goalId: "goal-parent" },
    })).toContain("goal.parent.projectId must match goal.projectId: omht != samantha");

    expect(validateAncestryRecords({
      goals: [goal],
      records: [
        {
          kind: "task",
          id: "task-mismatched-goal",
          ancestry: { mode: "assigned", projectId: "omht", goalId: goal.id, workItemId: "work-item-m3" },
        },
        {
          kind: "action",
          id: "action-unknown-goal",
          ancestry: { mode: "assigned", projectId: "samantha", goalId: "goal-missing", workItemId: "work-item-m3" },
        },
      ],
    })).toEqual([
      "task task-mismatched-goal.ancestry.projectId must match goal projectId: omht != samantha",
      "action action-unknown-goal.ancestry.goalId is unknown: goal-missing",
    ]);
  });

  test("requires same-project ancestry for a materialized execution plan", () => {
    expect(validateSameProjectMaterializedExecutionPlan({
      plan: { kind: "plan", id: "plan-m3", ancestry },
      records: [
        { kind: "task", id: "task-m3", ancestry: { ...ancestry, projectId: "omht" } },
        { kind: "action", id: "action-m3", ancestry: { ...ancestry, goalId: "goal-other" } },
        { kind: "run", id: "run-m3", ancestry: { ...ancestry, workItemId: "work-item-other" } },
        { kind: "lifecycle", id: "lifecycle-m3" },
      ],
    })).toEqual([
      "task task-m3 projectId must match materialized plan projectId: omht != samantha",
      "action action-m3 goalId must match materialized plan goalId: goal-other != goal-multi-project-ancestry",
      "run run-m3 workItemId must match materialized plan workItemId: work-item-other != work-item-m3",
      "lifecycle lifecycle-m3 must have assigned ancestry for materialized plan plan-m3",
    ]);
  });

  test("traces request to plan to execution records without reading prose", () => {
    const records = [
      { kind: "request" as const, id: "request-m3", ancestry },
      { kind: "plan" as const, id: "plan-m3", ancestry },
      { kind: "decision" as const, id: "decision-m3", ancestry },
      { kind: "task" as const, id: "task-m3", ancestry },
      { kind: "action" as const, id: "action-m3", ancestry },
      { kind: "run" as const, id: "run-m3", ancestry },
      { kind: "lifecycle" as const, id: "lifecycle-m3", ancestry },
      { kind: "recovery" as const, id: "request-recovery-m3", ancestry },
      { kind: "report" as const, id: "report-m3", ancestry },
      { kind: "governance_event" as const, id: "gov-event-m3", ancestry },
      { kind: "budget_observation" as const, id: "budget-m3", ancestry },
    ];

    expect(validateAncestryRecords({ goals: [goal], records })).toEqual([]);
    expect(validateSameProjectMaterializedExecutionPlan({ plan: records[1], records: records.slice(3, 7) })).toEqual([]);
  });

  test("preserves ancestry on governance events and budget observations", () => {
    const event = createGovernanceEvent({
      timestamp: "2026-05-10T00:01:00.000Z",
      ancestry,
      actor: "system",
      source: { kind: "orchestrator_plan", id: "plan-m3" },
      subject: { type: "plan", id: "plan-m3" },
      kind: "audit_gap_recorded",
      riskClass: "informational",
      summary: "Ancestry contract check.",
    });
    const budget = createCostBudgetAuditRecord({
      observedAt: "2026-05-10T00:02:00.000Z",
      ancestry,
      actor: "system",
      subject: { type: "run", id: "run-m3" },
      context: { projectId: "samantha", goalId: goal.id, taskId: "task-m3", runId: "run-m3" },
    });

    expect(parseGovernanceEventRecord(event).ancestry).toEqual(ancestry);
    expect(parseCostBudgetAuditRecord(budget).ancestry).toEqual(ancestry);
  });
});
