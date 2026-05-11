import { describe, expect, test } from "bun:test";
import type { CeoReportRecord } from "../src/lib/ceo-report-store";
import type { TaskSpec } from "../src/lib/contracts";
import type { DecisionItem } from "../src/lib/decision-store";
import { createCostBudgetAuditRecord } from "../src/lib/cost-budget-audit";
import { createGovernanceEvent } from "../src/lib/governance-event-store";
import type { RunSummary } from "../src/lib/ledger";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import { inferProjectProfile, type ProjectProfile } from "../src/lib/project-profile";
import type { RemoteActionRecord } from "../src/lib/remote-action-store";
import type { RunLifecycleRecord } from "../src/lib/run-lifecycle-store";
import type { WorkerRunLog } from "../src/lib/run-log";

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const profiles: ProjectProfile[] = [
  {
    schemaVersion: 1,
    id: "samantha",
    repoRoot: "/workspace/samantha-codex",
    keywords: ["samantha", "samantha-codex", "사만다"],
    setupCommands: ["bun install"],
    verifyCommands: ["bun run typecheck"],
    forbiddenChanges: ["state/**", "runs/**"],
  },
  {
    schemaVersion: 1,
    id: "omht",
    repoRoot: "/workspace/oh-my-health-trainer",
    keywords: ["omht", "oh-my-health-trainer", "오마헬"],
    setupCommands: ["bun install"],
    verifyCommands: ["bun typecheck"],
    forbiddenChanges: [".env", "node_modules/**"],
  },
];

const request: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-m1-ambiguous",
  source: "remote",
  senderId: "bk",
  text: "다음 작업 계획 보고",
  status: "planned",
  createdAt: "2026-05-10T00:00:00.000Z",
  plannedAt: "2026-05-10T00:01:00.000Z",
};

const plan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-m1-baseline",
  requestId: request.id,
  status: "materialized",
  createdAt: "2026-05-10T00:01:00.000Z",
  approvedAt: "2026-05-10T00:02:00.000Z",
  materializedAt: "2026-05-10T00:03:00.000Z",
  taskIds: ["task-m1-baseline"],
  actionIds: ["action-m1-baseline"],
  payload: {
    summary: "M1 baseline plan",
    assumptions: [],
    questions: [],
    scope: ["document current project identity behavior"],
    nonScope: ["schema migration", "runtime behavior changes"],
    risks: ["Project identity is not first-class on every durable record."],
    tasks: [
      {
        id: "m1-baseline",
        title: "Document current project identity gaps",
        targetAgent: "codex-spec",
        projectId: "samantha",
        resultMode: "report",
        targetFiles: ["docs/MULTI_PROJECT_BASELINE_INVENTORY.md"],
        forbiddenChanges: ["state/**", "runs/**"],
        verifyCommands: ["bun run verify:docs"],
        instructions: "Document current behavior only.",
      },
    ],
    batches: [["m1-baseline"]],
    userMessage: "Baseline only.",
  },
};

const decision: DecisionItem = {
  schemaVersion: 1,
  id: "decision-m1-baseline",
  status: "resolved",
  kind: "orchestrator_plan_approval",
  title: "Review plan: M1 baseline",
  prompt: "Approve before materialization.",
  options: ["approve", "revise", "cancel"],
  source: "system",
  subject: { type: "orchestrator_plan", id: plan.id },
  createdAt: "2026-05-10T00:01:30.000Z",
  updatedAt: "2026-05-10T00:02:00.000Z",
  resolvedAt: "2026-05-10T00:02:00.000Z",
  resolvedBy: "bk",
  resolution: "approved",
};

const task: TaskSpec = {
  id: "task-m1-baseline",
  title: "Document current project identity gaps",
  targetAgent: "codex-spec",
  projectId: "samantha",
  repoRoot: profiles[0].repoRoot,
  targetFiles: ["docs/MULTI_PROJECT_BASELINE_INVENTORY.md"],
  forbiddenChanges: ["state/**", "runs/**"],
  verifyCommands: ["bun run verify:docs"],
  instructions: "Document current behavior only.",
  resultMode: "report",
  status: "completed",
};

const legacyTask: TaskSpec = {
  ...task,
  id: "task-m1-legacy",
  projectId: undefined,
  repoRoot: undefined,
};

const action: RemoteActionRecord = {
  schemaVersion: 1,
  id: "action-m1-baseline",
  kind: "dispatch_task",
  status: "completed",
  createdAt: "2026-05-10T00:03:00.000Z",
  source: "remote",
  taskId: task.id,
  taskTitle: task.title,
  targetAgent: task.targetAgent,
  repoRoot: profiles[0].repoRoot,
  allocate: true,
  execute: true,
  liveLog: true,
  orchestratorPlanId: plan.id,
  orchestratorTaskId: "m1-baseline",
  completedAt: "2026-05-10T00:04:00.000Z",
  result: { runId: "run-m1-baseline", pass: true, outcome: "pass" },
};

const run: RunSummary = {
  schemaVersion: 1,
  runId: "run-m1-baseline",
  taskId: task.id,
  taskTitle: task.title,
  agentId: task.targetAgent,
  repoRoot: profiles[0].repoRoot,
  worktreePath: "/workspace/samantha-codex/.samantha-worktrees/task-m1-baseline",
  logPath: "runs/run-m1-baseline.json",
  startedAt: "2026-05-10T00:03:00.000Z",
  finishedAt: "2026-05-10T00:04:00.000Z",
  outcome: "pass",
  pass: true,
  commit: "",
};

const runLog: WorkerRunLog = {
  schemaVersion: 1,
  runId: run.runId,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  task,
  agent: {
    id: "codex-spec",
    role: "spec",
    model: "gpt-5.5",
    writerClass: "non-writer",
    worktreePolicy: "none",
    mergePolicy: "none",
    skillPolicy: { requiredBundles: [], blockedSkills: [] },
  },
  input: { repoRoot: run.repoRoot, allocate: true, execute: true },
  result: {
    preparation: {
      taskId: task.id,
      agentId: "codex-spec",
      worktreePath: run.worktreePath,
      codex: { prompt: "prompt", command: ["codex", "exec"] },
    },
    setupResults: [],
    command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
    pass: true,
  },
};

const lifecycle: RunLifecycleRecord = {
  schemaVersion: 1,
  runId: run.runId,
  taskId: task.id,
  repoRoot: run.repoRoot,
  runLogPath: run.logPath,
  commit: "",
  updatedAt: "2026-05-10T00:04:00.000Z",
};

const recoveryRequest: OrchestrationRequestRecord = {
  ...request,
  id: "request-m1-recovery",
  status: "pending_plan",
  recoveryOfPlanId: plan.id,
  plannedAt: undefined,
};

const report: CeoReportRecord = {
  schemaVersion: 1,
  id: "ceo-report-m1-baseline",
  kind: "ceo_notify",
  generatedAt: "2026-05-10T00:05:00.000Z",
  outboxFile: "remote-m1-baseline.md",
  outboxPath: "outbox/remote-m1-baseline.md",
  deliveryStatePath: "state/telegram-replies.json",
  overall: "idle",
  nextActionKind: "none",
  decisionCount: 0,
  activeCount: 0,
  blockedCount: 0,
  riskCount: 0,
};

const governanceEvent = createGovernanceEvent({
  timestamp: "2026-05-10T00:05:00.000Z",
  actor: "system",
  source: { kind: "orchestrator_plan", id: plan.id },
  subject: { type: "plan", id: plan.id },
  kind: "audit_gap_recorded",
  riskClass: "informational",
  summary: "Project identity is not first-class on every durable record.",
  related: { decisionIds: [decision.id], actionIds: [action.id], runIds: [run.runId] },
});

const budgetObservation = createCostBudgetAuditRecord({
  observedAt: "2026-05-10T00:05:00.000Z",
  actor: "system",
  subject: { type: "run", id: run.runId },
  context: {
    projectId: task.projectId,
    planId: plan.id,
    actionId: action.id,
    taskId: task.id,
    runId: run.runId,
    repoRoot: run.repoRoot,
  },
});

describe("multi-project M1 baseline", () => {
  test("keeps the two-profile and ambiguous request baseline explicit", () => {
    expect(profiles.map((profile) => profile.id).sort()).toEqual(["omht", "samantha"]);
    expect(inferProjectProfile(profiles, { requestText: "samantha dashboard 계획 보고" })?.id).toBe("samantha");
    expect(inferProjectProfile(profiles, { requestText: "omht 다음 작업 계획 보고" })?.id).toBe("omht");
    expect(inferProjectProfile(profiles, { requestText: request.text })).toBeUndefined();
  });

  test("documents where current durable records carry project identity", () => {
    const matrix = [
      {
        record: "orchestration_request",
        directProjectId: hasOwn(request, "projectId"),
        repoRoot: hasOwn(request, "repoRoot"),
        linkOnly: ["text", "recoveryOfPlanId"],
      },
      {
        record: "orchestrator_plan",
        directProjectId: hasOwn(plan, "projectId"),
        repoRoot: hasOwn(plan, "repoRoot"),
        proposalProjectIds: plan.payload?.tasks.map((item) => item.projectId) ?? [],
      },
      {
        record: "decision",
        directProjectId: hasOwn(decision, "projectId"),
        repoRoot: hasOwn(decision, "repoRoot"),
        linkOnly: [decision.subject?.type],
      },
      {
        record: "task",
        directProjectId: task.projectId,
        repoRoot: task.repoRoot,
        legacyProjectId: legacyTask.projectId,
      },
      {
        record: "remote_action",
        directProjectId: hasOwn(action, "projectId"),
        repoRoot: action.repoRoot,
        linkOnly: [action.taskId, action.orchestratorPlanId],
      },
      {
        record: "run_summary",
        directProjectId: hasOwn(run, "projectId"),
        repoRoot: run.repoRoot,
        linkOnly: [run.taskId],
      },
      {
        record: "worker_run_log",
        directProjectId: hasOwn(runLog, "projectId"),
        repoRoot: runLog.input.repoRoot,
        nestedTaskProjectId: runLog.task.projectId,
      },
      {
        record: "run_lifecycle",
        directProjectId: hasOwn(lifecycle, "projectId"),
        repoRoot: lifecycle.repoRoot,
        linkOnly: [lifecycle.runId, lifecycle.taskId],
      },
      {
        record: "recovery_request",
        directProjectId: hasOwn(recoveryRequest, "projectId"),
        repoRoot: hasOwn(recoveryRequest, "repoRoot"),
        linkOnly: [recoveryRequest.recoveryOfPlanId],
      },
      {
        record: "ceo_report",
        directProjectId: hasOwn(report, "projectId"),
        repoRoot: hasOwn(report, "repoRoot"),
        globalCountsOnly: true,
      },
      {
        record: "governance_event",
        directProjectId: hasOwn(governanceEvent, "projectId"),
        repoRoot: hasOwn(governanceEvent, "repoRoot"),
        linkOnly: [governanceEvent.source.id, governanceEvent.subject.id],
      },
      {
        record: "budget_observation",
        directProjectId: budgetObservation.context?.projectId,
        repoRoot: budgetObservation.context?.repoRoot,
        subject: budgetObservation.subject.type,
      },
    ];

    expect(matrix).toEqual([
      {
        record: "orchestration_request",
        directProjectId: false,
        repoRoot: false,
        linkOnly: ["text", "recoveryOfPlanId"],
      },
      {
        record: "orchestrator_plan",
        directProjectId: false,
        repoRoot: false,
        proposalProjectIds: ["samantha"],
      },
      {
        record: "decision",
        directProjectId: false,
        repoRoot: false,
        linkOnly: ["orchestrator_plan"],
      },
      {
        record: "task",
        directProjectId: "samantha",
        repoRoot: "/workspace/samantha-codex",
        legacyProjectId: undefined,
      },
      {
        record: "remote_action",
        directProjectId: false,
        repoRoot: "/workspace/samantha-codex",
        linkOnly: ["task-m1-baseline", "plan-m1-baseline"],
      },
      {
        record: "run_summary",
        directProjectId: false,
        repoRoot: "/workspace/samantha-codex",
        linkOnly: ["task-m1-baseline"],
      },
      {
        record: "worker_run_log",
        directProjectId: false,
        repoRoot: "/workspace/samantha-codex",
        nestedTaskProjectId: "samantha",
      },
      {
        record: "run_lifecycle",
        directProjectId: false,
        repoRoot: "/workspace/samantha-codex",
        linkOnly: ["run-m1-baseline", "task-m1-baseline"],
      },
      {
        record: "recovery_request",
        directProjectId: false,
        repoRoot: false,
        linkOnly: ["plan-m1-baseline"],
      },
      {
        record: "ceo_report",
        directProjectId: false,
        repoRoot: false,
        globalCountsOnly: true,
      },
      {
        record: "governance_event",
        directProjectId: false,
        repoRoot: false,
        linkOnly: ["plan-m1-baseline", "plan-m1-baseline"],
      },
      {
        record: "budget_observation",
        directProjectId: "samantha",
        repoRoot: "/workspace/samantha-codex",
        subject: "run",
      },
    ]);
  });
});
