import { describe, expect, test } from "bun:test";
import type { WorkItemAncestry } from "../src/lib/ancestry";
import { createDecisionItem, type DecisionItem } from "../src/lib/decision-store";
import { buildDecisionHistorySummary, type DecisionHistoryReportSource } from "../src/lib/decision-history-summary";
import { createGovernanceEvent, type GovernanceEventRecord } from "../src/lib/governance-event-store";
import type { OrchestratorPlanRecord } from "../src/lib/orchestrator-store";

const ancestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "samantha",
  goalId: "goal-memory",
  workItemId: "work-item-phase-8-m4",
};

function planFixture(input: Partial<OrchestratorPlanRecord> = {}): OrchestratorPlanRecord {
  return {
    schemaVersion: 1,
    id: "plan-active-policy",
    ancestry,
    requestId: "request-memory",
    status: "planned",
    createdAt: "2026-05-10T00:00:00.000Z",
    payload: {
      summary: "Use a conservative memory summary.",
      assumptions: [],
      questions: [],
      scope: ["decision summaries"],
      nonScope: ["memory writes"],
      risks: [],
      tasks: [],
      batches: [],
      userMessage: "Plan ready.",
    },
    ...input,
  };
}

function resolvedDecision(input: {
  id?: string;
  title?: string;
  resolution?: DecisionItem["resolution"];
  resolvedAt?: string;
  subject?: DecisionItem["subject"];
  kind?: DecisionItem["kind"];
  note?: string;
} = {}): DecisionItem {
  const decision = createDecisionItem({
    title: input.title ?? "Keep memory derived",
    prompt: "Should Samantha use derived decision-history summaries only?",
    kind: input.kind ?? "manual",
    source: "system",
    subject: input.subject,
    options: ["approve", "reject", "revise"],
    createdAt: "2026-05-10T00:01:00.000Z",
    ancestry,
  });

  return {
    ...decision,
    id: input.id ?? decision.id,
    status: "resolved",
    updatedAt: input.resolvedAt ?? "2026-05-10T00:02:00.000Z",
    resolvedAt: input.resolvedAt ?? "2026-05-10T00:02:00.000Z",
    resolvedBy: "bk",
    resolution: input.resolution ?? "approved",
    resolutionNote: input.note,
  };
}

function governanceEvent(decisionId: string, input: Partial<GovernanceEventRecord> = {}): GovernanceEventRecord {
  return createGovernanceEvent({
    timestamp: "2026-05-10T00:03:00.000Z",
    ancestry,
    actor: "system",
    source: { kind: "decision", id: decisionId },
    subject: { type: "memory", id: "decision-history" },
    kind: "transition_approved",
    riskClass: "low",
    summary: "Decision-history summary can be used as derived context.",
    related: { decisionIds: [decisionId] },
    ...input,
  });
}

const report: DecisionHistoryReportSource = {
  id: "operator-report-memory-review",
  kind: "operator_report",
  ancestry,
  generatedAt: "2026-05-10T00:04:00.000Z",
};

describe("decision history summary", () => {
  test("builds planner-facing BK decision summaries with source citations and ancestry", () => {
    const decision = resolvedDecision({ id: "decision-derived-memory", note: "Use summaries only as context." });
    const event = governanceEvent(decision.id);

    const summary = buildDecisionHistorySummary({
      decisions: [decision],
      governanceEvents: [event],
      reports: [report],
      generatedAt: "2026-05-10T00:05:00.000Z",
      scope: { projectId: "samantha" },
    });

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: "decision_history_summary",
      generatedAt: "2026-05-10T00:05:00.000Z",
      scope: { projectId: "samantha" },
    });
    expect(summary.active).toHaveLength(1);
    expect(summary.active[0]).toMatchObject({
      sourceDecisionId: decision.id,
      sourceDecisionIds: [decision.id],
      sourceGovernanceEventIds: [event.id],
      sourceReportIds: [report.id],
      authority: "bk_decision",
      claimKind: "bk_decision",
      guidanceStatus: "active",
      activeGuidance: true,
      ancestry,
      resolvedBy: "bk",
      resolution: "approved",
    });
    expect(summary.active[0].citations).toEqual([
      { kind: "decision", id: decision.id, ancestry },
      { kind: "governance_event", id: event.id, ancestry },
      { kind: "operator_report", id: report.id, ancestry },
    ]);
    expect(summary.citations.map((citation) => `${citation.kind}:${citation.id}`)).toContain(`decision:${decision.id}`);
  });

  test("keeps LLM or system prompts separate from BK decisions", () => {
    const pending = createDecisionItem({
      title: "Question drafted by orchestrator",
      prompt: "Which memory scope should be summarized?",
      kind: "blocker_clarification",
      source: "system",
      subject: { type: "task", id: "task-memory" },
      options: ["project", "goal"],
      createdAt: "2026-05-10T00:01:00.000Z",
      ancestry,
    });

    const summary = buildDecisionHistorySummary({ decisions: [pending] });

    expect(summary.active).toEqual([]);
    expect(summary.inactive[0]).toMatchObject({
      sourceDecisionId: pending.id,
      authority: "derived_summary",
      claimKind: "llm_summary",
      guidanceStatus: "pending",
      activeGuidance: false,
      staleReasons: ["BK has not resolved this decision."],
    });
  });

  test("marks rejected superseded reversed and stale decisions as inactive guidance", () => {
    const rejected = resolvedDecision({
      id: "decision-rejected-memory",
      title: "Reject automatic memory writes",
      resolution: "rejected",
      note: "Do not write memory automatically.",
    });
    const supersededPlan = planFixture({ id: "plan-superseded", status: "superseded" });
    const superseded = resolvedDecision({
      id: "decision-superseded-plan",
      title: "Approve old plan",
      kind: "orchestrator_plan_approval",
      subject: { type: "orchestrator_plan", id: supersededPlan.id },
    });
    const materializedPlan = planFixture({ id: "plan-materialized", status: "materialized" });
    const stale = resolvedDecision({
      id: "decision-stale-plan",
      title: "Approve already materialized plan",
      kind: "orchestrator_plan_approval",
      subject: { type: "orchestrator_plan", id: materializedPlan.id },
    });
    const original = resolvedDecision({
      id: "decision-original-policy",
      title: "Allow memory summaries in prompts",
      subject: { type: "policy", id: "policy-memory-context" },
      resolvedAt: "2026-05-10T00:02:00.000Z",
    });
    const reversal = resolvedDecision({
      id: "decision-reverse-policy",
      title: "Pause memory summaries in prompts",
      subject: { type: "policy", id: "policy-memory-context" },
      resolution: "canceled",
      resolvedAt: "2026-05-10T00:06:00.000Z",
    });

    const summary = buildDecisionHistorySummary({
      decisions: [rejected, superseded, stale, original, reversal],
      plans: [supersededPlan, materializedPlan],
    });

    expect(summary.active).toEqual([]);
    expect(Object.fromEntries(summary.inactive.map((item) => [item.sourceDecisionId, item.guidanceStatus]))).toEqual({
      "decision-rejected-memory": "rejected",
      "decision-superseded-plan": "superseded",
      "decision-stale-plan": "stale",
      "decision-original-policy": "reversed",
      "decision-reverse-policy": "canceled",
    });
    expect(summary.inactive.find((item) => item.sourceDecisionId === "decision-original-policy")?.sourceDecisionIds).toEqual([
      "decision-original-policy",
      "decision-reverse-policy",
    ]);
    expect(summary.risks.map((risk) => risk.summary)).toContain(
      "Decision decision-original-policy is reversed; do not present it as active guidance.",
    );
    expect(summary.risks.map((risk) => risk.summary)).toContain(
      "Decision decision-stale-plan is stale; do not present it as active guidance.",
    );
  });

  test("surfaces conflicting prior BK decisions as ambiguity instead of silently choosing recency", () => {
    const active = resolvedDecision({
      id: "decision-active-policy",
      subject: { type: "policy", id: "policy-memory-context" },
      resolution: "approved",
      resolvedAt: "2026-05-10T00:07:00.000Z",
    });
    const rejected = resolvedDecision({
      id: "decision-rejected-policy",
      subject: { type: "policy", id: "policy-memory-context" },
      resolution: "rejected",
      resolvedAt: "2026-05-10T00:04:00.000Z",
    });
    const event = governanceEvent(rejected.id, {
      id: "gov-event-rejected-policy",
      kind: "transition_rejected",
      related: { decisionIds: [rejected.id, active.id] },
    });

    const summary = buildDecisionHistorySummary({
      decisions: [rejected, active],
      governanceEvents: [event],
    });

    expect(summary.active.map((item) => item.sourceDecisionId)).toEqual(["decision-active-policy"]);
    expect(summary.risks).toContainEqual(expect.objectContaining({
      kind: "conflicting_prior_decisions",
      severity: "ambiguity",
      sourceDecisionIds: ["decision-active-policy", "decision-rejected-policy"],
      sourceGovernanceEventIds: [event.id],
    }));
  });

  test("summary generation does not mutate source-of-truth records", () => {
    const decision = resolvedDecision({ id: "decision-immutable" });
    const event = governanceEvent(decision.id);
    const plan = planFixture();
    const sources = { decisions: [decision], governanceEvents: [event], reports: [report], plans: [plan] };
    const before = JSON.stringify(sources);

    buildDecisionHistorySummary(sources);

    expect(JSON.stringify(sources)).toBe(before);
  });
});
