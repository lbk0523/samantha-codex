import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskSpec } from "../src/lib/contracts";
import { buildCeoStatusSnapshot, formatCeoStatusReport } from "../src/lib/ceo-status";
import { createDecisionItem } from "../src/lib/decision-store";
import type { RunSummary } from "../src/lib/ledger";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import type { RemoteActionRecord } from "../src/lib/remote-action-store";
import type { RunLifecycleRecord } from "../src/lib/run-lifecycle-store";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-ceo-status-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

const task: TaskSpec = {
  id: "task-1",
  title: "Implement CEO status",
  targetAgent: "codex-worker",
  targetFiles: ["src/lib/ceo-status.ts"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun typecheck"],
  instructions: "Fixture.",
  status: "pending",
};

const action: RemoteActionRecord = {
  schemaVersion: 1,
  id: "action-1",
  kind: "dispatch_task",
  status: "pending",
  createdAt: "2026-05-07T10:00:00.000Z",
  source: "local",
  taskId: task.id,
  taskTitle: task.title,
  targetAgent: task.targetAgent,
  repoRoot: "/repo",
  allocate: true,
  execute: true,
  tmux: true,
};

const request: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-1",
  source: "local",
  text: "Build a CEO report",
  status: "pending_plan",
  createdAt: "2026-05-07T09:00:00.000Z",
};

const plan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-1",
  requestId: request.id,
  status: "planned",
  createdAt: "2026-05-07T09:05:00.000Z",
  completedAt: "2026-05-07T09:06:00.000Z",
  payload: {
    summary: "CEO status plan",
    assumptions: [],
    questions: [],
    scope: ["status snapshot"],
    nonScope: ["Telegram commands"],
    risks: ["report could hide blockers"],
    tasks: [
      {
        id: "status-plan-report",
        title: "Review CEO status plan",
        targetAgent: "codex-worker",
        projectId: "samantha",
        resultMode: "report",
        targetFiles: [],
        forbiddenChanges: ["state/**"],
        setupCommands: [],
        verifyCommands: ["bun typecheck"],
        instructions: "Review the CEO status plan and report findings.",
        dependencies: [],
      },
    ],
    batches: [["status-plan-report"]],
    userMessage: "Plan ready.",
  },
};

const passRun: RunSummary = {
  schemaVersion: 1,
  runId: "run-pass",
  taskId: task.id,
  taskTitle: task.title,
  agentId: task.targetAgent,
  repoRoot: "/repo",
  worktreePath: "/worktree",
  logPath: "/runs/run-pass.json",
  startedAt: "2026-05-07T11:00:00.000Z",
  finishedAt: "2026-05-07T11:05:00.000Z",
  outcome: "pass",
  pass: true,
  commit: "abcdef1234567890",
};

async function writeJsonLines(path: string, items: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
}

describe("CEO status snapshot", () => {
  test("empty state reports idle with deterministic sections", () => {
    const snapshot = buildCeoStatusSnapshot({ generatedAt: "2026-05-07T00:00:00.000Z" });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.overall).toBe("idle");
    expect(snapshot.active).toEqual([]);
    expect(snapshot.needsDecision).toEqual([]);
    expect(snapshot.nextAction.kind).toBe("none");
    expect(report).toContain("# ceo:status");
    expect(report).toContain("Summary: decisions=0 active=0 blocked=0 historical_failures=0 completed=0 risks=0");
    expect(report).toContain("Needs BK:\n- none");
    expect(report).toContain("Next safe action:\n- No safe action required");
  });

  test("pending orchestration request recommends planning", () => {
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      orchestrationRequests: [request],
    });

    expect(snapshot.overall).toBe("active");
    expect(snapshot.active).toContainEqual(expect.objectContaining({ kind: "orchestration_request", id: "request-1" }));
    expect(snapshot.nextAction).toMatchObject({ kind: "plan", command: "/plan", targetId: "request-1" });
  });

  test("project filter keeps selected project status while preserving cross-project blockers and legacy labels", () => {
    const samanthaAncestry = {
      mode: "assigned" as const,
      projectId: "samantha",
      goalId: "goal-samantha",
      workItemId: "work-samantha",
    };
    const omhtAncestry = {
      mode: "assigned" as const,
      projectId: "omht",
      goalId: "goal-omht",
      workItemId: "work-omht",
    };
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      projectId: "samantha",
      orchestrationRequests: [
        { ...request, id: "request-samantha", ancestry: samanthaAncestry, text: "Samantha work" },
        { ...request, id: "request-omht", ancestry: omhtAncestry, text: "OMHT work" },
      ],
      tasks: [{ ...task, id: "task-legacy", status: "blocked" }],
      ops: {
        ok: false,
        failures: ["host verification failed"],
        warnings: [],
        queues: {
          pendingInboxCount: 0,
          remoteOutboxCount: 0,
          unsentRemoteOutboxCount: 0,
        },
        telegram: {},
        health: { ok: true, ageMs: 0, violations: [] },
        launchd: [],
        issues: [
          {
            severity: "unsafe_to_continue",
            area: "host",
            message: "host verification failed",
            action: "repair host ownership",
          },
        ],
      } as any,
    });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.projectFilterId).toBe("samantha");
    expect(snapshot.active.map((item) => item.id)).toEqual(["request-samantha"]);
    expect(snapshot.risks).toContain("host verification failed");
    expect(snapshot.projectQueues?.selectedProject?.counts.active).toBe(1);
    expect(snapshot.projectQueues?.projects.find((item) => item.bucket.projectId === "omht")?.counts.active).toBe(1);
    expect(snapshot.projectQueues?.legacy.counts.blocked).toBe(1);
    expect(snapshot.projectQueues?.globalBlockers).toEqual(["host verification failed"]);
    expect(report).toContain("Project filter: samantha");
    expect(report).toContain("- selected samantha:");
    expect(report).toContain("- project omht:");
    expect(report).toContain("- legacy legacy:");
    expect(report).toContain("- global blockers: 1");
    expect(report).toContain("Queue pressure:");
    expect(report).toContain("- class: block project=samantha");
    expect(report).toContain("unsafe_host=1");
  });

  test("planned and question plans appear under Needs BK", () => {
    const questionPlan: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-questions",
      status: "questions",
      createdAt: "2026-05-07T09:07:00.000Z",
      completedAt: "2026-05-07T09:08:00.000Z",
      payload: {
        ...plan.payload!,
        summary: "Clarify CEO status",
        questions: ["Which report surface first?"],
      },
    };
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      orchestratorPlans: [plan, questionPlan],
    });

    expect(snapshot.overall).toBe("needs_decision");
    expect(snapshot.needsDecision.map((item) => item.id)).toEqual(["plan-questions", "plan-1"]);
    expect(snapshot.nextAction).toMatchObject({ kind: "answer_questions", targetId: "plan-questions" });
    expect(snapshot.risks).toContain("report could hide blockers");
  });

  test("pending decision queue items appear before derived plan decisions", () => {
    const decision = createDecisionItem({
      title: "Review CEO status plan",
      prompt: "Approve or revise before worker materialization.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-1" },
      risk: "report could hide blockers",
      options: ["approve", "revise", "cancel"],
      createdAt: "2026-05-07T09:09:00.000Z",
    });
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      decisions: [decision],
      orchestratorPlans: [plan],
    });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.overall).toBe("needs_decision");
    expect(snapshot.needsDecision).toEqual([
      expect.objectContaining({ kind: "decision", id: decision.id, subject: "orchestrator_plan:plan-1" }),
    ]);
    expect(snapshot.nextAction).toMatchObject({ kind: "resolve_decision", targetId: decision.id });
    expect(report).toContain("Needs BK:\n- Decision: Review CEO status plan");
    expect(report).not.toContain(decision.id);
    expect(report).not.toContain("subject=orchestrator_plan:plan-1");
  });

  test("stale and resolved decisions do not appear as active needs", () => {
    const stale = createDecisionItem({
      title: "Review stale plan",
      prompt: "Approve, revise, or cancel.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-stale" },
      createdAt: "2026-05-07T09:10:00.000Z",
    });
    const approved = {
      ...createDecisionItem({
        title: "Review approved plan",
        prompt: "Approve, revise, or cancel.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-approved" },
        createdAt: "2026-05-07T09:11:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-07T09:12:00.000Z",
      resolvedBy: "bk" as const,
    };
    const rejected = {
      ...createDecisionItem({
        title: "Review rejected plan",
        prompt: "Approve, revise, or cancel.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-rejected" },
        createdAt: "2026-05-07T09:13:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "rejected" as const,
      resolvedAt: "2026-05-07T09:14:00.000Z",
      resolvedBy: "bk" as const,
    };
    const archived = {
      ...createDecisionItem({
        title: "Review archived plan",
        prompt: "Approve, revise, or cancel.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-archived" },
        createdAt: "2026-05-07T09:15:00.000Z",
      }),
      status: "archived" as const,
      archivedAt: "2026-05-07T09:16:00.000Z",
      archiveReason: "No longer active.",
    };
    const current = createDecisionItem({
      title: "Review current plan",
      prompt: "Approve, revise, or cancel.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-current" },
      createdAt: "2026-05-07T09:17:00.000Z",
    });
    const missingPlan = createDecisionItem({
      title: "Review missing plan",
      prompt: "Approve, revise, or cancel.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-missing" },
      createdAt: "2026-05-07T09:18:00.000Z",
    });
    const plans: OrchestratorPlanRecord[] = [
      { ...plan, id: "plan-stale", status: "canceled" },
      { ...plan, id: "plan-approved", status: "planned" },
      { ...plan, id: "plan-rejected", status: "planned" },
      { ...plan, id: "plan-current", status: "planned" },
    ];

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      decisions: [stale, approved, rejected, archived, current, missingPlan],
      orchestratorPlans: plans,
    });

    expect(snapshot.needsDecision.map((item) => item.title)).toEqual(["Review current plan"]);
    expect(snapshot.nextAction).toMatchObject({ kind: "resolve_decision", command: "bun run samantha decisions:approve-latest" });
  });

  test("approved plan decisions become a go action without a new active need", () => {
    const approved = {
      ...createDecisionItem({
        title: "Review approved plan",
        prompt: "Approve, revise, or cancel.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-approved" },
        createdAt: "2026-05-07T09:11:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-07T09:12:00.000Z",
      resolvedBy: "bk" as const,
    };

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      decisions: [approved],
      orchestratorPlans: [{ ...plan, id: "plan-approved", status: "planned" }],
    });

    expect(snapshot.needsDecision).toEqual([]);
    expect(snapshot.active).toContainEqual(expect.objectContaining({ kind: "orchestrator_plan", id: "plan-approved" }));
    expect(snapshot.nextAction).toMatchObject({ kind: "review_plan", command: "/go", targetId: "plan-approved" });
  });

  test("pending blocker clarification prevents approved plan materialization", () => {
    const approved = {
      ...createDecisionItem({
        title: "Review approved plan",
        prompt: "Approve, revise, or cancel.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-approved" },
        createdAt: "2026-05-07T09:11:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-07T09:12:00.000Z",
      resolvedBy: "bk" as const,
    };
    const clarification = createDecisionItem({
      title: "Clarify blocker",
      prompt: "Should Samantha narrow scope before materialization?",
      kind: "blocker_clarification",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-approved" },
      options: ["answer", "revise", "cancel"],
      risk: "Materializing before BK answers can dispatch the wrong work.",
      createdAt: "2026-05-07T09:13:00.000Z",
    });

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      decisions: [approved, clarification],
      orchestratorPlans: [{ ...plan, id: "plan-approved", status: "planned" }],
    });

    expect(snapshot.overall).toBe("needs_decision");
    expect(snapshot.needsDecision).toEqual([
      expect.objectContaining({
        id: clarification.id,
        decisionKind: "blocker_clarification",
        options: ["answer", "revise", "cancel"],
      }),
    ]);
    expect(snapshot.active).not.toContainEqual(expect.objectContaining({ kind: "orchestrator_plan", id: "plan-approved" }));
    expect(snapshot.nextAction).toMatchObject({
      kind: "resolve_decision",
      command: `bun run samantha decisions:resolve ${clarification.id} --resolution=answered --note=<answer>`,
      targetId: clarification.id,
    });
    expect(snapshot.nextAction.command).not.toBe("/go");
  });

  test("non-plan blocker clarification outranks approved plan and action progress", () => {
    const approved = {
      ...createDecisionItem({
        title: "Review approved plan",
        prompt: "Approve, revise, or cancel.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-approved" },
        createdAt: "2026-05-07T09:11:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-07T09:12:00.000Z",
      resolvedBy: "bk" as const,
    };
    const blocker = createDecisionItem({
      title: "Clarify run blocker",
      prompt: "Should Samantha recover the failed run or wait?",
      kind: "blocker_clarification",
      source: "system",
      subject: { type: "run", id: "run-failed" },
      options: ["recover", "wait", "cancel"],
      risk: "Wrong recovery can waste a worker run.",
      createdAt: "2026-05-07T09:13:00.000Z",
    });

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      decisions: [approved, blocker],
      orchestratorPlans: [{ ...plan, id: "plan-approved", status: "planned" }],
      actions: [{ ...action, id: "action-running", status: "running" }],
    });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.overall).toBe("needs_decision");
    expect(snapshot.needsDecision[0]).toMatchObject({
      id: blocker.id,
      decisionKind: "blocker_clarification",
      subject: "run:run-failed",
    });
    expect(snapshot.active).not.toContainEqual(expect.objectContaining({ kind: "orchestrator_plan", id: "plan-approved" }));
    expect(snapshot.nextAction).toMatchObject({
      kind: "resolve_decision",
      command: `bun run samantha decisions:resolve ${blocker.id} --resolution=answered --note=<answer>`,
      targetId: blocker.id,
    });
    expect(report).toContain("Next safe action:\n- Answer the latest blocker clarification\n- Telegram: /answer <답변>");
    expect(report).not.toContain("Telegram: /go");
  });

  test("blocked orchestrator plans surface one deterministic revision action", () => {
    const blockedPlan = { ...plan, id: "plan-blocked", status: "planned" as const };
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      orchestratorPlans: [blockedPlan],
      orchestratorPlanBlockers: [
        {
          planId: "plan-blocked",
          requestId: request.id,
          violations: ["task proposal write: verifyCommands must not be empty"],
          nextAction: {
            label: "Revise the current orchestrator plan before materialization",
            command: "/revise <피드백>",
            reason: "task proposal write: verifyCommands must not be empty",
          },
        },
      ],
    });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.overall).toBe("blocked");
    expect(snapshot.needsDecision).toEqual([]);
    expect(snapshot.blocked).toContainEqual(expect.objectContaining({ kind: "orchestrator_plan", id: "plan-blocked", status: "blocked" }));
    expect(snapshot.nextAction).toMatchObject({ kind: "review_plan", command: "/revise <피드백>", targetId: "plan-blocked" });
    expect(report).toContain("Next safe action:\n- Revise the current orchestrator plan before materialization\n- Telegram: /revise <피드백>");
    expect(report).not.toContain("Telegram: /go");
  });

  test("running approved waiting and pending actions count as active work", () => {
    const actions: RemoteActionRecord[] = ["running", "approved", "waiting", "pending"].map((status, index) => ({
      ...action,
      id: `action-${status}`,
      status: status as RemoteActionRecord["status"],
      createdAt: `2026-05-07T10:0${index}:00.000Z`,
    }));
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      actions,
    });

    expect(snapshot.overall).toBe("active");
    expect(snapshot.active.map((item) => item.status).sort()).toEqual(["approved", "pending", "running", "waiting"]);
  });

  test("completed parallel specialists summarize role outcome and ancestry without run ids", () => {
    const ancestry = {
      mode: "assigned" as const,
      projectId: "samantha",
      goalId: "goal-parallelism",
      workItemId: "work-parallelism",
    };
    const reviewTask: TaskSpec = {
      ...task,
      id: "task-review-parallel",
      ancestry,
      title: "Review parallel outcome",
      targetAgent: "codex-reviewer",
      resultMode: "report",
      targetFiles: [],
    };
    const completedAction: RemoteActionRecord = {
      ...action,
      id: "action-review-parallel",
      ancestry,
      taskId: reviewTask.id,
      taskTitle: reviewTask.title,
      targetAgent: reviewTask.targetAgent,
      status: "completed",
      completedAt: "2026-05-07T12:10:00.000Z",
      result: { runId: "run-review-parallel", pass: true, outcome: "pass" },
    };

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      tasks: [reviewTask],
      actions: [completedAction],
    });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.completed[0]).toMatchObject({
      kind: "action",
      id: "action-review-parallel",
      detail: expect.stringContaining("Reviewer [project=samantha goal=goal-parallelism]: Review parallel outcome: completed (계획/보고)"),
    });
    expect(report).toContain("checked quality and regressions; reduced bad change approval risk");
    expect(report).not.toContain("run=run-review-parallel");
  });

  test("failed action and failed synthesis create recovery blockers", () => {
    const failedAction: RemoteActionRecord = {
      ...action,
      id: "action-failed",
      status: "failed",
      completedAt: "2026-05-07T10:10:00.000Z",
      result: { pass: false, outcome: "verify_failed", failure: "typecheck failed" },
    };
    const failedPlan: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-failed-synthesis",
      status: "materialized",
      resultReportedAt: "2026-05-07T10:11:00.000Z",
      synthesisAt: "2026-05-07T10:12:00.000Z",
      synthesis: {
        outcome: "failed",
        summary: "Verification failed.",
        nextActions: ["Recover"],
        risks: ["worker output did not pass"],
        userMessage: "Needs recovery.",
      },
    };
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      actions: [failedAction],
      orchestratorPlans: [failedPlan],
    });

    expect(snapshot.overall).toBe("needs_recovery");
    expect(snapshot.blocked.map((item) => item.id)).toEqual(["plan-failed-synthesis", "action-failed"]);
    expect(snapshot.risks).toContain("Failed action action-failed: typecheck failed");
    expect(snapshot.nextAction.kind).toBe("recover");
  });

  test("successful linked recovery prevents stale failed plans from polluting CEO status", () => {
    const failedAction: RemoteActionRecord = {
      ...action,
      id: "action-failed",
      status: "failed",
      completedAt: "2026-05-07T10:10:00.000Z",
      result: { pass: false, outcome: "verify_failed", failure: "typecheck failed" },
    };
    const failedPlan: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-failed-source",
      status: "materialized",
      resultReportedAt: "2026-05-07T10:11:00.000Z",
      actionIds: [failedAction.id],
      taskIds: [failedAction.taskId],
      synthesis: {
        outcome: "failed",
        summary: "Verification failed.",
        nextActions: ["Recover"],
        risks: [],
        userMessage: "Needs recovery.",
      },
    };
    const recoveryRequest: OrchestrationRequestRecord = {
      ...request,
      id: "request-recovery",
      status: "planned",
      recoveryOfPlanId: failedPlan.id,
    };
    const recoveryAction: RemoteActionRecord = {
      ...action,
      id: "action-recovery",
      taskId: "task-recovery",
      taskTitle: "Recovery task",
      status: "completed",
      completedAt: "2026-05-07T10:30:00.000Z",
      result: { pass: true, outcome: "pass" },
    };
    const recoveryPlan: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-recovery",
      requestId: recoveryRequest.id,
      status: "materialized",
      resultReportedAt: "2026-05-07T10:31:00.000Z",
      actionIds: [recoveryAction.id],
      taskIds: [recoveryAction.taskId],
      synthesis: {
        outcome: "pass",
        summary: "Recovery fixed the source failure.",
        nextActions: [],
        risks: [],
        userMessage: "Fixed.",
      },
    };
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      actions: [failedAction, recoveryAction],
      orchestrationRequests: [request, recoveryRequest],
      orchestratorPlans: [failedPlan, recoveryPlan],
    });

    expect(snapshot.overall).not.toBe("needs_recovery");
    expect(snapshot.blocked.map((item) => item.id)).not.toContain(failedPlan.id);
    expect(snapshot.blocked.map((item) => item.id)).not.toContain(failedAction.id);
    expect(snapshot.risks.join("\n")).not.toContain("Plan needs recovery plan-failed-source");
  });

  test("historical failed runs do not dominate pending decision status", () => {
    const decision = createDecisionItem({
      title: "Review plan: Current work",
      prompt: "Approve, revise, or cancel.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-current" },
      createdAt: "2026-05-07T12:00:00.000Z",
    });
    const failedRuns: RunSummary[] = [1, 2, 3].map((index) => ({
      schemaVersion: 1,
      runId: `run-old-${index}`,
      taskId: `task-old-${index}`,
      taskTitle: `Old failed task ${index}`,
      agentId: "codex-worker",
      repoRoot: "/repo",
      worktreePath: `/worktrees/task-old-${index}`,
      logPath: `/runs/run-old-${index}.json`,
      startedAt: `2026-05-0${index}T10:00:00.000Z`,
      finishedAt: `2026-05-0${index}T10:10:00.000Z`,
      outcome: "verify_failed",
      pass: false,
      commit: "",
      failureReason: "typecheck failed",
    }));

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      decisions: [decision],
      runs: failedRuns,
      orchestratorPlans: [{ ...plan, id: "plan-current", status: "planned" }],
    });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.overall).toBe("needs_decision");
    expect(snapshot.blocked).toEqual([]);
    expect(snapshot.historicalFailures.map((item) => item.id)).toEqual(["run-old-3", "run-old-2", "run-old-1"]);
    expect(snapshot.nextAction).toMatchObject({ kind: "resolve_decision", targetId: decision.id });
    expect(report.indexOf("Next safe action:")).toBeLessThan(report.indexOf("Historical failures:"));
    expect(report.indexOf("Needs BK:")).toBeLessThan(report.indexOf("Historical failures:"));
  });

  test("unresolved historical failures remain visible when no current work exists", () => {
    const failedRun: RunSummary = {
      schemaVersion: 1,
      runId: "run-unresolved",
      taskId: "task-unresolved",
      taskTitle: "Unresolved failed task",
      agentId: "codex-worker",
      repoRoot: "/repo",
      worktreePath: "/worktrees/task-unresolved",
      logPath: "/runs/run-unresolved.json",
      startedAt: "2026-05-07T10:00:00.000Z",
      finishedAt: "2026-05-07T10:10:00.000Z",
      outcome: "blocked",
      pass: false,
      commit: "",
      failureReason: "worker blocked",
    };

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      runs: [failedRun],
    });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.overall).toBe("needs_recovery");
    expect(snapshot.blocked).toEqual([]);
    expect(snapshot.historicalFailures).toContainEqual(expect.objectContaining({ kind: "run", id: "run-unresolved" }));
    expect(snapshot.risks).toContain("Historical failed run run-unresolved: worker blocked");
    expect(snapshot.nextAction).toMatchObject({ kind: "recover", command: "/problems", targetId: "run-unresolved" });
    expect(report).toContain("Historical failures:\n- Unresolved failed task (run:run-unresolved, blocked) - worker blocked");
  });

  test("current actionable blockers stay visible before historical failures", () => {
    const failedAction: RemoteActionRecord = {
      ...action,
      id: "action-current-failed",
      status: "failed",
      completedAt: "2026-05-07T12:00:00.000Z",
      result: { pass: false, outcome: "verify_failed", failure: "current verify failed" },
    };
    const failedRun: RunSummary = {
      schemaVersion: 1,
      runId: "run-old",
      taskId: "task-old",
      taskTitle: "Old failed task",
      agentId: "codex-worker",
      repoRoot: "/repo",
      worktreePath: "/worktrees/task-old",
      logPath: "/runs/run-old.json",
      startedAt: "2026-05-06T10:00:00.000Z",
      finishedAt: "2026-05-06T10:10:00.000Z",
      outcome: "verify_failed",
      pass: false,
      commit: "",
      failureReason: "old verify failed",
    };

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      actions: [failedAction],
      runs: [failedRun],
    });
    const report = formatCeoStatusReport(snapshot);

    expect(snapshot.blocked.map((item) => item.id)).toEqual(["action-current-failed"]);
    expect(snapshot.historicalFailures.map((item) => item.id)).toEqual(["run-old"]);
    expect(snapshot.nextAction).toMatchObject({ kind: "recover", targetId: "action-current-failed" });
    expect(report.indexOf("Blocked / recovery:")).toBeLessThan(report.indexOf("Historical failures:"));
  });

  test("resolved failed runs produce a clean idle status", () => {
    const failedRun: RunSummary = {
      schemaVersion: 1,
      runId: "run-fixed-source",
      taskId: "task-fixed-source",
      taskTitle: "Fixed source failure",
      agentId: "codex-worker",
      repoRoot: "/repo",
      worktreePath: "/worktrees/task-fixed-source",
      logPath: "/runs/run-fixed-source.json",
      startedAt: "2026-05-07T10:00:00.000Z",
      finishedAt: "2026-05-07T10:10:00.000Z",
      outcome: "verify_failed",
      pass: false,
      commit: "",
      failureReason: "typecheck failed",
    };
    const failedPlan: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-fixed-source",
      requestId: "request-fixed-source",
      status: "materialized",
      resultReportedAt: "2026-05-07T10:11:00.000Z",
      taskIds: [failedRun.taskId],
      synthesis: {
        outcome: "failed",
        summary: "Source failed.",
        nextActions: ["Recover"],
        risks: [],
        userMessage: "Needs recovery.",
      },
    };
    const recoveryRequest: OrchestrationRequestRecord = {
      ...request,
      id: "request-fixed-recovery",
      status: "planned",
      recoveryOfPlanId: failedPlan.id,
    };
    const recoveryAction: RemoteActionRecord = {
      ...action,
      id: "action-fixed-recovery",
      taskId: "task-fixed-recovery",
      taskTitle: "Fix source failure",
      status: "completed",
      completedAt: "2026-05-07T10:30:00.000Z",
      result: { pass: true, outcome: "pass" },
    };
    const recoveryPlan: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-fixed-recovery",
      requestId: recoveryRequest.id,
      status: "materialized",
      resultReportedAt: "2026-05-07T10:31:00.000Z",
      actionIds: [recoveryAction.id],
      taskIds: [recoveryAction.taskId],
      synthesis: {
        outcome: "pass",
        summary: "Recovery fixed the source failure.",
        nextActions: [],
        risks: [],
        userMessage: "Fixed.",
      },
    };

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      runs: [failedRun],
      actions: [recoveryAction],
      orchestrationRequests: [recoveryRequest],
      orchestratorPlans: [failedPlan, recoveryPlan],
    });

    expect(snapshot.overall).toBe("idle");
    expect(snapshot.blocked).toEqual([]);
    expect(snapshot.historicalFailures).toEqual([]);
    expect(snapshot.risks).toEqual([]);
    expect(snapshot.nextAction.kind).toBe("none");
  });

  test("archived task failures do not create actionable historical recovery", () => {
    const failedRun: RunSummary = {
      schemaVersion: 1,
      runId: "run-archived",
      taskId: "task-archived",
      taskTitle: "Archived failed task",
      agentId: "codex-worker",
      repoRoot: "/repo",
      worktreePath: "/worktrees/task-archived",
      logPath: "/runs/run-archived.json",
      startedAt: "2026-05-07T10:00:00.000Z",
      finishedAt: "2026-05-07T10:10:00.000Z",
      outcome: "verify_failed",
      pass: false,
      commit: "",
      failureReason: "old verify failed",
    };

    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      runs: [failedRun],
      tasks: [
        {
          id: "task-archived",
          title: "Archived failed task",
          targetAgent: "codex-worker",
          repoRoot: "/repo",
          targetFiles: ["src/app.ts"],
          forbiddenChanges: ["state/**"],
          verifyCommands: ["bun typecheck"],
          instructions: "Archived stale task.",
          status: "archived",
          archivedAt: "2026-05-07T11:00:00.000Z",
          archiveReason: "superseded by recovery",
        },
      ],
    });

    expect(snapshot.overall).toBe("idle");
    expect(snapshot.historicalFailures).toEqual([]);
    expect(snapshot.risks).not.toContain("Historical failed run run-archived: old verify failed");
    expect(snapshot.nextAction.kind).toBe("none");
  });

  test("passed run with missing lifecycle becomes merge gate next action", () => {
    const snapshot = buildCeoStatusSnapshot({
      generatedAt: "2026-05-07T00:00:00.000Z",
      runs: [passRun],
      lifecycles: [],
    });

    expect(snapshot.completed).toContainEqual(expect.objectContaining({ kind: "run", id: "run-pass" }));
    expect(snapshot.nextAction).toMatchObject({
      kind: "merge_check",
      command: "bun run samantha merge:check --run-log=/runs/run-pass.json --repo-root=/repo",
    });

    const mergedLifecycle: RunLifecycleRecord = {
      schemaVersion: 1,
      runId: "run-pass",
      taskId: task.id,
      repoRoot: "/repo",
      runLogPath: "/runs/run-pass.json",
      commit: passRun.commit,
      mergedAt: "2026-05-07T11:06:00.000Z",
      pushedAt: "2026-05-07T11:07:00.000Z",
      cleanedAt: "2026-05-07T11:08:00.000Z",
      updatedAt: "2026-05-07T11:08:00.000Z",
    };
    expect(buildCeoStatusSnapshot({ runs: [passRun], lifecycles: [mergedLifecycle] }).nextAction.kind).toBe("none");
  });

  test("CLI command prints ceo status report", async () => {
    const root = await makeRoot();
    const stateDir = join(root, "state");
    await writeJsonLines(join(stateDir, "orchestration-requests.jsonl"), [request]);

    const proc = Bun.spawn(["bun", "run", "src/samantha.ts", "ceo:status", `--state-dir=${stateDir}`], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# ceo:status");
    expect(stdout).toContain("Overall:");
  });

  test("CLI command writes a compact remote CEO notification outbox", async () => {
    const root = await makeRoot();
    const stateDir = join(root, "state");
    const outbox = join(root, "outbox");
    await writeJsonLines(join(stateDir, "decisions.jsonl"), [
      createDecisionItem({
        title: "Review plan: Mobile approval",
        prompt: "Approve, revise, or cancel.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-mobile-approval" },
        createdAt: "2026-05-07T11:00:00.000Z",
      }),
    ]);
    await writeJsonLines(join(stateDir, "orchestrator-plans.jsonl"), [
      { ...plan, id: "plan-mobile-approval", status: "planned" },
    ]);

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "ceo:notify",
        `--state-dir=${stateDir}`,
        `--outbox-dir=${outbox}`,
        "--created-at=2026-05-07T11:01:00.000Z",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("remote-20260507-110100-ceo-notify");
    const files = await readdir(outbox);
    expect(files).toHaveLength(1);
    const report = await readFile(join(outbox, files[0] ?? ""), "utf8");
    expect(report).toContain("# ceo-notify");
    expect(report).toContain("텔레그램: `/approve`");
    expect(report).toContain("CLI 또는 dashboard");
    expect(report).not.toContain("plan-mobile-approval");
    expect(report).not.toContain("decision-");
    const reportLedger = await readFile(join(stateDir, "ceo-reports.jsonl"), "utf8");
    const records = reportLedger
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      kind: "ceo_notify",
      generatedAt: "2026-05-07T11:01:00.000Z",
      outboxFile: files[0],
      outboxPath: join(outbox, files[0] ?? ""),
      deliveryStatePath: join(stateDir, "telegram-replies.json"),
      overall: "needs_decision",
      nextActionKind: "resolve_decision",
      decisionCount: 1,
    });

    const retry = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "ceo:notify",
        `--state-dir=${stateDir}`,
        `--outbox-dir=${outbox}`,
        "--created-at=2026-05-07T11:01:00.000Z",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const retryStdout = await new Response(retry.stdout).text();
    const retryStderr = await new Response(retry.stderr).text();
    const retryExitCode = await retry.exited;

    expect(retryStderr).toBe("");
    expect(retryExitCode).toBe(0);
    expect(retryStdout).toContain(files[0] ?? "");
    expect(await readdir(outbox)).toEqual(files);
    const preservedReport = "# preserved CEO report\n";
    await writeFile(join(outbox, files[0] ?? ""), preservedReport, "utf8");
    const deliveryState = `${JSON.stringify(
      {
        schemaVersion: 1,
        sentFiles: [files[0]],
        failures: [{ file: "remote-failed.md", attempts: 1, lastError: "timeout", updatedAt: "2026-05-07T11:02:00.000Z" }],
        updatedAt: "2026-05-07T11:03:00.000Z",
      },
      null,
      2,
    )}\n`;
    await writeFile(join(stateDir, "telegram-replies.json"), deliveryState, "utf8");
    const duplicate = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "ceo:notify",
        `--state-dir=${stateDir}`,
        `--outbox-dir=${outbox}`,
        "--created-at=2026-05-07T11:01:00.000Z",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(duplicate.stderr).text()).toBe("");
    expect(await duplicate.exited).toBe(0);
    expect(await readFile(join(outbox, files[0] ?? ""), "utf8")).toBe(preservedReport);
    expect(await readFile(join(stateDir, "telegram-replies.json"), "utf8")).toBe(deliveryState);
    const retryReportLedger = await readFile(join(stateDir, "ceo-reports.jsonl"), "utf8");
    expect(retryReportLedger.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("CLI ceo notify uses an hourly default identity for timer retries", async () => {
    const root = await makeRoot();
    const stateDir = join(root, "state");
    const outbox = join(root, "outbox");

    for (const now of ["2026-05-07T11:37:00.000Z", "2026-05-07T11:43:00.000Z"]) {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "src/samantha.ts",
          "ceo:notify",
          `--state-dir=${stateDir}`,
          `--outbox-dir=${outbox}`,
          `--now=${now}`,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(await proc.exited).toBe(0);
    }

    const files = await readdir(outbox);
    expect(files).toHaveLength(1);
    const reportLedger = (await readFile(join(stateDir, "ceo-reports.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { generatedAt: string; outboxFile: string });
    expect(reportLedger).toEqual([
      expect.objectContaining({ generatedAt: "2026-05-07T11:00:00.000Z", outboxFile: files[0] }),
    ]);
  });
});
