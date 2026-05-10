import { describe, expect, test } from "bun:test";
import type { GoalRecord } from "../src/lib/ancestry";
import { buildCeoStatusSnapshot, formatCeoStatusReport } from "../src/lib/ceo-status";
import { createDecisionItem } from "../src/lib/decision-store";
import { renderDashboard } from "../src/lib/dashboard";
import type { RunSummary } from "../src/lib/ledger";
import type { OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import { ceoNotificationReport, nowReport } from "../src/lib/operator-reports";
import type { RemoteActionRecord } from "../src/lib/remote-action-store";

const ancestry = {
  mode: "assigned" as const,
  projectId: "samantha",
  goalId: "goal-samantha",
  workItemId: "work-samantha",
};

const goal: GoalRecord = {
  schemaVersion: 1,
  id: "goal-samantha",
  projectId: "samantha",
  title: "Samantha operations",
  status: "active",
  createdAt: "2026-05-07T00:00:00.000Z",
  priority: "normal",
};

const plan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-ranking",
  ancestry,
  requestId: "request-ranking",
  status: "planned",
  createdAt: "2026-05-07T09:00:00.000Z",
  completedAt: "2026-05-07T09:01:00.000Z",
  payload: {
    summary: "Ranking test plan",
    assumptions: [],
    questions: [],
    scope: ["ranking"],
    nonScope: [],
    risks: [],
    tasks: [],
    batches: [],
    userMessage: "Ready.",
  },
};

const action: RemoteActionRecord = {
  schemaVersion: 1,
  id: "action-ranking",
  ancestry,
  kind: "dispatch_task",
  status: "failed",
  createdAt: "2026-05-07T10:00:00.000Z",
  completedAt: "2026-05-07T10:05:00.000Z",
  source: "local",
  taskId: "task-ranking",
  taskTitle: "Recover ranking work",
  targetAgent: "codex-worker",
  repoRoot: "/repo",
  allocate: true,
  execute: true,
  tmux: true,
  result: { pass: false, outcome: "verify_failed", failure: "typecheck failed" },
};

function passRun(id: string, finishedAt: string, goalId = "goal-samantha"): RunSummary {
  return {
    schemaVersion: 1,
    runId: id,
    ancestry: { ...ancestry, goalId },
    taskId: `task-${id}`,
    taskTitle: `Completed ${id}`,
    agentId: "codex-worker",
    repoRoot: "/repo",
    worktreePath: `/worktrees/${id}`,
    logPath: `/runs/${id}.json`,
    startedAt: "2026-05-07T11:00:00.000Z",
    finishedAt,
    outcome: "pass",
    pass: true,
    commit: "",
  };
}

describe("CEO cross-project ranking", () => {
  test("uses stable explainable tie-breakers for equal inputs", () => {
    const omhtDecision = createDecisionItem({
      ancestry: { mode: "assigned", projectId: "omht", goalId: "goal-omht", workItemId: "work-omht" },
      title: "Review OMHT plan",
      prompt: "Approve or revise.",
      kind: "orchestrator_plan_approval",
      subject: { type: "orchestrator_plan", id: "plan-omht" },
      options: ["approve", "revise", "cancel"],
      createdAt: "2026-05-07T09:00:00.000Z",
    });
    const samanthaDecision = createDecisionItem({
      ancestry,
      title: "Review Samantha plan",
      prompt: "Approve or revise.",
      kind: "orchestrator_plan_approval",
      subject: { type: "orchestrator_plan", id: "plan-samantha" },
      options: ["approve", "revise", "cancel"],
      createdAt: "2026-05-07T09:00:00.000Z",
    });
    const plans: OrchestratorPlanRecord[] = [
      { ...plan, id: "plan-samantha", ancestry },
      { ...plan, id: "plan-omht", ancestry: { mode: "assigned", projectId: "omht", goalId: "goal-omht", workItemId: "work-omht" } },
    ];

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T12:00:00.000Z",
      decisions: [samanthaDecision, omhtDecision],
      orchestratorPlans: plans,
    });

    expect(snapshot.ranking?.tieBreaker).toBe("score desc, recency desc, project id asc, signal asc, item id asc");
    expect(snapshot.ranking?.candidates.map((item) => item.projectId).slice(0, 2)).toEqual(["omht", "samantha"]);
    expect(snapshot.ranking?.top?.explanation).toContain("ties use score desc");
  });

  test("urgent BK decisions outrank routine completed-work summaries", () => {
    const urgentGoal: GoalRecord = { ...goal, id: "goal-urgent", priority: "urgent" };
    const decision = createDecisionItem({
      ancestry: { ...ancestry, goalId: "goal-urgent" },
      title: "Review urgent plan",
      prompt: "Approve before materialization.",
      kind: "orchestrator_plan_approval",
      subject: { type: "orchestrator_plan", id: "plan-ranking" },
      options: ["approve", "revise", "cancel"],
      createdAt: "2026-05-07T08:00:00.000Z",
    });

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T12:00:00.000Z",
      goals: [goal, urgentGoal],
      decisions: [decision],
      orchestratorPlans: [{ ...plan, ancestry: { ...ancestry, goalId: "goal-urgent" } }],
      runs: [passRun("run-newer-summary", "2026-05-07T11:30:00.000Z")],
    });

    expect(snapshot.ranking?.top).toMatchObject({
      signal: "bk_decision",
      title: "Review urgent plan",
      priority: "urgent",
    });
    expect(snapshot.ranking?.candidates.find((item) => item.signal === "completed_summary")?.score).toBeLessThan(
      snapshot.ranking?.top?.score ?? 0,
    );
  });

  test("blocked recovery remains ranked until it is fixed or closed", () => {
    const blocked = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T12:00:00.000Z",
      actions: [action],
    });
    const fixed = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T12:00:00.000Z",
      actions: [{ ...action, status: "completed", result: { pass: true, outcome: "pass" } }],
    });

    expect(blocked.ranking?.candidates).toContainEqual(expect.objectContaining({
      signal: "blocked_recovery",
      id: "action-ranking",
    }));
    expect(blocked.ranking?.top?.id).toBe("action-ranking");
    expect(fixed.ranking?.candidates).not.toContainEqual(expect.objectContaining({
      signal: "blocked_recovery",
      id: "action-ranking",
    }));
  });

  test("CLI, dashboard, compact remote, and now reports show the same top recommendation", () => {
    const decision = createDecisionItem({
      ancestry,
      title: "Review ranking plan",
      prompt: "Approve before materialization.",
      kind: "orchestrator_plan_approval",
      subject: { type: "orchestrator_plan", id: "plan-ranking" },
      options: ["approve", "revise", "cancel"],
      createdAt: "2026-05-07T09:00:00.000Z",
    });
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T12:00:00.000Z",
      decisions: [decision],
      orchestratorPlans: [plan],
    });
    const topLabel = snapshot.ranking?.top?.action.label ?? "";

    expect(topLabel).toBe("Resolve the latest pending BK decision");
    expect(formatCeoStatusReport(snapshot)).toContain(topLabel);
    expect(renderDashboard([], { ceoStatus: snapshot })).toContain(topLabel);
    expect(ceoNotificationReport(snapshot)).toContain(`추천: ${topLabel}`);
    expect(nowReport({ runs: [], tasks: [], actions: [], decisions: [decision], orchestratorPlans: [plan] })).toContain(
      `추천: ${topLabel}`,
    );
  });
});
