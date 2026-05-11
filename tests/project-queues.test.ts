import { describe, expect, test } from "bun:test";
import type { WorkItemAncestry } from "../src/lib/ancestry";
import type { TaskSpec } from "../src/lib/contracts";
import { createCostBudgetAuditRecord } from "../src/lib/cost-budget-audit";
import { createDecisionItem } from "../src/lib/decision-store";
import { createGovernanceEvent } from "../src/lib/governance-event-store";
import type { RunSummary } from "../src/lib/ledger";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import type { RemoteActionRecord } from "../src/lib/remote-action-store";
import { DEFAULT_SAFETY_POLICY } from "../src/lib/policy";
import { buildQueuePressureSnapshot, decideQueueAdmission } from "../src/lib/queue-pressure";
import { buildProjectQueueSnapshot, filterProjectQueueRecords } from "../src/lib/project-queues";

const samanthaAncestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "samantha",
  goalId: "goal-samantha",
  workItemId: "work-samantha",
};

const omhtAncestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "omht",
  goalId: "goal-omht",
  workItemId: "work-omht",
};

const request: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-samantha",
  ancestry: samanthaAncestry,
  source: "local",
  text: "Samantha status",
  status: "pending_plan",
  createdAt: "2026-05-10T00:00:00.000Z",
};

const plan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-omht",
  ancestry: omhtAncestry,
  requestId: "request-omht",
  status: "failed",
  createdAt: "2026-05-10T00:01:00.000Z",
  failure: "planner failed",
};

const task: TaskSpec = {
  id: "task-samantha",
  ancestry: samanthaAncestry,
  title: "Implement Samantha report",
  targetAgent: "codex-worker",
  targetFiles: ["src/lib/ceo-status.ts"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun test"],
  instructions: "Fixture.",
  status: "pending",
};

const legacyTask: TaskSpec = {
  ...task,
  id: "task-legacy",
  ancestry: undefined,
  projectId: undefined,
  status: "blocked",
};

const action: RemoteActionRecord = {
  schemaVersion: 1,
  id: "action-samantha",
  ancestry: samanthaAncestry,
  kind: "dispatch_task",
  status: "running",
  createdAt: "2026-05-10T00:02:00.000Z",
  source: "local",
  taskId: task.id,
  taskTitle: task.title,
  targetAgent: task.targetAgent,
  repoRoot: "/repo/samantha",
  allocate: true,
  execute: true,
  liveLog: true,
};

const run: RunSummary = {
  schemaVersion: 1,
  runId: "run-omht-failed",
  ancestry: omhtAncestry,
  taskId: "task-omht",
  taskTitle: "OMHT failed task",
  agentId: "codex-worker",
  repoRoot: "/repo/omht",
  worktreePath: "/repo/omht-worktree",
  logPath: "/runs/run-omht-failed.json",
  startedAt: "2026-05-10T00:03:00.000Z",
  finishedAt: "2026-05-10T00:04:00.000Z",
  outcome: "verify_failed",
  pass: false,
  commit: "",
  failureReason: "verify failed",
};

describe("project-isolated queues", () => {
  test("counts assigned projects, unassigned records, legacy records, and global blockers separately", () => {
    const decision = createDecisionItem({
      ancestry: { mode: "unassigned", workItemId: "work-unassigned", reason: "ambiguous project" },
      title: "Clarify project",
      prompt: "Which project?",
      kind: "blocker_clarification",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-unassigned" },
      options: ["samantha", "omht"],
      createdAt: "2026-05-10T00:05:00.000Z",
    });
    const governanceEvent = createGovernanceEvent({
      ancestry: omhtAncestry,
      timestamp: "2026-05-10T00:06:00.000Z",
      actor: "system",
      source: { kind: "orchestrator_plan", id: "plan-omht" },
      subject: { type: "plan", id: "plan-omht" },
      kind: "audit_gap_recorded",
      riskClass: "informational",
      summary: "OMHT audit gap.",
    });
    const budgetObservation = createCostBudgetAuditRecord({
      ancestry: samanthaAncestry,
      observedAt: "2026-05-10T00:07:00.000Z",
      actor: "system",
      subject: { type: "run", id: "run-samantha" },
    });

    const snapshot = buildProjectQueueSnapshot({
      requests: [request],
      plans: [plan],
      decisions: [decision],
      tasks: [task, legacyTask],
      actions: [action],
      runs: [run],
      governanceEvents: [governanceEvent],
      budgetObservations: [budgetObservation],
      globalBlockers: ["host verification is failing"],
    }, { filterProjectId: "samantha" });

    expect(snapshot.totals.total).toBe(9);
    expect(snapshot.selectedProject?.counts.total).toBe(4);
    expect(snapshot.selectedProject?.counts.pendingBkDecisions).toBe(0);
    expect(snapshot.selectedProject?.counts.activeActions).toBe(1);
    expect(snapshot.selectedProject?.counts.auditGaps).toBe(1);
    expect(snapshot.projects.find((item) => item.bucket.projectId === "omht")?.counts.failedRuns).toBe(1);
    expect(snapshot.projects.find((item) => item.bucket.projectId === "omht")?.counts.recoveryNeeds).toBe(2);
    expect(snapshot.unassigned.counts.pendingBkDecisions).toBe(1);
    expect(snapshot.legacy.counts.blocked).toBe(1);
    expect(snapshot.globalBlockers).toEqual(["host verification is failing"]);
  });

  test("filters concrete record lists to one project without treating legacy records as assigned", () => {
    expect(filterProjectQueueRecords([task, legacyTask], "samantha").map((item) => item.id)).toEqual(["task-samantha"]);
    expect(filterProjectQueueRecords([task, legacyTask], undefined).map((item) => item.id)).toEqual(["task-samantha", "task-legacy"]);
  });

  test("does not double count a plan when its pending decision already exists", () => {
    const planned: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-samantha-review",
      ancestry: samanthaAncestry,
      status: "planned",
      failure: undefined,
    };
    const decision = createDecisionItem({
      ancestry: samanthaAncestry,
      title: "Approve Samantha plan",
      prompt: "Approve before materialization.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: planned.id },
      options: ["approve", "revise", "cancel"],
      createdAt: "2026-05-10T00:08:00.000Z",
    });

    const snapshot = buildProjectQueueSnapshot({ plans: [planned], decisions: [decision] }, { filterProjectId: "samantha" });

    expect(snapshot.selectedProject?.counts.pendingBkDecisions).toBe(1);
    expect(snapshot.selectedProject?.counts.records.plan).toBe(1);
    expect(snapshot.selectedProject?.counts.records.decision).toBe(1);
  });

  test("classifies queue pressure deterministically and keeps BK decisions above routine intake", () => {
    const decision = createDecisionItem({
      ancestry: samanthaAncestry,
      title: "Approve Samantha plan",
      prompt: "Approve before materialization.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-samantha" },
      options: ["approve", "revise", "cancel"],
      createdAt: "2026-05-10T00:09:00.000Z",
    });
    const pressure = buildQueuePressureSnapshot({
      decisions: [decision],
      actions: [action],
    }, { projectId: "samantha" });
    const admission = decideQueueAdmission({ pressure, subjectKind: "routine_trigger" });

    expect(pressure.pressureClass).toBe("needs_bk");
    expect(pressure.reasons[0]).toBe("pending BK decisions=1");
    expect(admission.decision).toBe("ask_bk");
    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
  });

  test("blocks routine intake when host state is unsafe", () => {
    const pressure = buildQueuePressureSnapshot({
      ops: {
        issues: [
          {
            severity: "unsafe_to_continue",
            area: "host",
            message: "host ownership is stale",
            action: "repair host ownership",
          },
        ],
        queues: { pendingInboxCount: 0, unsentRemoteOutboxCount: 0 },
      } as any,
    });
    const admission = decideQueueAdmission({ pressure, subjectKind: "routine_trigger" });

    expect(pressure.pressureClass).toBe("block");
    expect(admission.decision).toBe("block");
  });
});
