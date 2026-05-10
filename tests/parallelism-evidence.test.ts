import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile, TaskResultMode, TaskSpec } from "../src/lib/contracts";
import { orchestratorPlanResultReport } from "../src/lib/operator-reports";
import type { OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import {
  createParallelismEvidenceFromPlanResult,
  createParallelismEvidenceRecord,
  ParallelismEvidenceStore,
} from "../src/lib/parallelism-evidence-store";
import { DEFAULT_SAFETY_POLICY } from "../src/lib/policy";
import { createRemoteDispatchAction, type RemoteActionRecord } from "../src/lib/remote-action-store";
import type { WorkerRunLog } from "../src/lib/run-log";

let tmpRoots: string[] = [];

const blockedSkills = [
  "using-git-worktrees",
  "dispatching-parallel-agents",
  "subagent-driven-development",
];

const reviewer: AgentProfile = {
  id: "codex-reviewer",
  role: "reviewer",
  model: "gpt-5",
  writerClass: "non-writer",
  worktreePolicy: "none",
  mergePolicy: "none",
  skillPolicy: { requiredBundles: [], blockedSkills },
};

const evaluator: AgentProfile = {
  ...reviewer,
  id: "codex-evaluator",
  role: "evaluator",
};

const writer: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: { requiredBundles: [], blockedSkills },
};

const ancestry = {
  mode: "assigned" as const,
  projectId: "samantha",
  goalId: "goal-parallelism",
  workItemId: "work-parallelism",
};

async function makeStore(): Promise<{ path: string; store: ParallelismEvidenceStore }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-parallel-evidence-"));
  tmpRoots.push(root);
  const path = join(root, "state", "parallelism-evidence.jsonl");
  return { path, store: new ParallelismEvidenceStore(path) };
}

function task(input: { id: string; title: string; targetAgent: string; resultMode: TaskResultMode }): TaskSpec {
  const reportOnly = input.resultMode === "report";

  return {
    id: input.id,
    ancestry,
    title: input.title,
    targetAgent: input.targetAgent,
    projectId: "samantha",
    repoRoot: "/repo/samantha-codex",
    targetFiles: reportOnly ? [] : ["src/lib/parallelism.ts"],
    forbiddenChanges: reportOnly ? ["**/*"] : ["state/**"],
    verifyCommands: ["bun typecheck"],
    instructions: `${input.title} fixture`,
    resultMode: input.resultMode,
    status: "pending",
  };
}

function completedAction(taskSpec: TaskSpec, runId: string): RemoteActionRecord {
  return {
    ...createRemoteDispatchAction({
      task: taskSpec,
      repoRoot: taskSpec.repoRoot ?? "/repo/samantha-codex",
      createdAt: "2026-05-07T10:00:00.000Z",
      source: "remote",
      commandId: runId,
      orchestratorPlanId: "plan-parallelism",
      ancestry,
    }),
    status: "completed",
    result: {
      runId,
      runLogPath: `/runs/${runId}.json`,
      pass: true,
      outcome: "pass",
    },
  };
}

function failedAction(taskSpec: TaskSpec, runId: string): RemoteActionRecord {
  return {
    ...completedAction(taskSpec, runId),
    status: "failed",
    result: {
      runId,
      runLogPath: `/runs/${runId}.json`,
      pass: false,
      outcome: "failed",
      failure: "verification failed",
    },
  };
}

function runLog(input: {
  task: TaskSpec;
  agent: AgentProfile;
  runId: string;
  commitHash?: string;
  pass?: boolean;
}): WorkerRunLog {
  const changedFiles = input.commitHash ? ["src/lib/parallelism.ts"] : [];
  const pass = input.pass ?? true;

  return {
    schemaVersion: 1,
    runId: input.runId,
    ancestry,
    startedAt: "2026-05-07T10:00:00.000Z",
    finishedAt: "2026-05-07T10:01:00.000Z",
    task: input.task,
    agent: input.agent,
    input: { repoRoot: "/repo/samantha-codex", allocate: input.agent.writerClass === "writer", execute: true },
    result: {
      preparation: {
        taskId: input.task.id,
        agentId: input.agent.id,
        worktreePath: `/worktrees/${input.task.id}`,
        codex: { prompt: "prompt", command: ["codex", "exec"] },
      },
      setupResults: [],
      command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
      evaluation: {
        pass,
        harness: { status: pass ? "pass" : "rework", note: pass ? "done" : "failed", commit: input.commitHash ?? "" },
        changedFiles,
        scopeViolations: [],
        verifyResults: pass ? [] : [{ command: "bun typecheck", exitCode: 1, stdout: "", stderr: "TS2322" }],
      },
      commit: input.commitHash
        ? {
            subject: "feat: parallelism fixture",
            files: changedFiles,
            add: { command: ["git", "add", "src/lib/parallelism.ts"], exitCode: 0, stdout: "", stderr: "" },
            commit: { command: ["git", "commit", "-m", "feat: parallelism fixture"], exitCode: 0, stdout: "", stderr: "" },
            commitHash: input.commitHash,
          }
        : undefined,
      pass,
    },
  };
}

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("parallelism evidence", () => {
  test("appends, lists, loads, and filters compact evidence records", async () => {
    const { path, store } = await makeStore();
    const first = createParallelismEvidenceRecord({
      observedAt: "2026-05-07T10:02:00.000Z",
      planId: "plan-parallelism",
      ancestry,
      batches: [["task-review", "task-evaluate"]],
      refs: [
        {
          taskId: "task-review",
          actionId: "action-review",
          runId: "run-review",
          runLogPath: "/runs/run-review.json",
          agentId: reviewer.id,
          agentRole: reviewer.role,
          resultMode: "report",
          outcome: "pass",
          changedFiles: [],
        },
      ],
      verification: { pass: true, summary: "review passed" },
      mergeStatus: "not_applicable",
      cleanupStatus: "not_applicable",
      outcome: "pass",
    });
    const second = createParallelismEvidenceRecord({
      observedAt: "2026-05-07T10:03:00.000Z",
      planId: "plan-failed",
      ancestry,
      batches: [["task-evaluate"]],
      refs: [
        {
          taskId: "task-evaluate",
          actionId: "action-evaluate",
          runId: "run-evaluate",
          runLogPath: "/runs/run-evaluate.json",
          agentId: evaluator.id,
          agentRole: evaluator.role,
          resultMode: "report",
          outcome: "failed",
          changedFiles: [],
        },
      ],
      verification: { pass: false, summary: "verification failed", failedCommands: ["bun typecheck"] },
      mergeStatus: "not_applicable",
      cleanupStatus: "not_applicable",
      outcome: "failed",
    });

    await store.append(first);
    const firstLine = (await readFile(path, "utf8")).trimEnd();
    await store.append(second);

    const rawLines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(rawLines[0]).toBe(firstLine);
    expect(await store.load(first.id)).toEqual(first);
    expect(await store.list()).toEqual([first, second]);
    expect(await store.list({ planId: "plan-failed" })).toEqual([second]);
    expect(await store.list({ projectId: "samantha" })).toEqual([first, second]);
    expect(await store.list({ goalId: "goal-parallelism" })).toEqual([first, second]);
    expect(await store.list({ role: "evaluator" })).toEqual([second]);
    expect(await store.list({ resultMode: "report" })).toEqual([first, second]);
    expect(await store.list({ runId: "run-review" })).toEqual([first]);
  });

  test("builds successful report-only parallel evidence from plan result refs", () => {
    const reviewTask = task({
      id: "task-review",
      title: "Scope report",
      targetAgent: reviewer.id,
      resultMode: "report",
    });
    const evaluateTask = task({
      id: "task-evaluate",
      title: "Verify report",
      targetAgent: evaluator.id,
      resultMode: "report",
    });
    const actions = [
      completedAction(reviewTask, "run-review"),
      completedAction(evaluateTask, "run-evaluate"),
    ];
    const plan: OrchestratorPlanRecord = {
      schemaVersion: 1,
      id: "plan-parallelism",
      ancestry,
      requestId: "request-parallelism",
      status: "materialized",
      createdAt: "2026-05-07T09:59:00.000Z",
      actionIds: actions.map((action) => action.id),
      payload: {
        summary: "parallel report-only fixture",
        assumptions: [],
        questions: [],
        scope: [],
        nonScope: [],
        risks: [],
        tasks: [],
        batches: [["task-review", "task-evaluate"]],
        userMessage: "fixture",
      },
    };

    const evidence = createParallelismEvidenceFromPlanResult({
      observedAt: "2026-05-07T10:02:00.000Z",
      plan,
      actions,
      runLogs: [
        runLog({ task: reviewTask, agent: reviewer, runId: "run-review" }),
        runLog({ task: evaluateTask, agent: evaluator, runId: "run-evaluate" }),
      ],
    });

    expect(evidence).toMatchObject({
      planId: "plan-parallelism",
      ancestry,
      batches: [["task-review", "task-evaluate"]],
      agentRoles: ["evaluator", "reviewer"],
      resultModes: ["report"],
      writerCount: 0,
      changedFiles: [],
      mergeStatus: "not_applicable",
      cleanupStatus: "not_applicable",
      outcome: "pass",
      verification: { pass: true },
    });
    expect(evidence.refs.map((ref) => ({ taskId: ref.taskId, actionId: ref.actionId, runId: ref.runId }))).toEqual([
      { taskId: "task-review", actionId: actions[0].id, runId: "run-review" },
      { taskId: "task-evaluate", actionId: actions[1].id, runId: "run-evaluate" },
    ]);
  });

  test("preserves failed report-only parallel evidence", async () => {
    const { store } = await makeStore();
    const reviewTask = task({
      id: "task-review",
      title: "Scope report",
      targetAgent: reviewer.id,
      resultMode: "report",
    });
    const evaluateTask = task({
      id: "task-evaluate",
      title: "Verify report",
      targetAgent: evaluator.id,
      resultMode: "report",
    });
    const actions = [
      completedAction(reviewTask, "run-review"),
      failedAction(evaluateTask, "run-evaluate"),
    ];
    const plan: OrchestratorPlanRecord = {
      schemaVersion: 1,
      id: "plan-parallelism",
      ancestry,
      requestId: "request-parallelism",
      status: "materialized",
      createdAt: "2026-05-07T09:59:00.000Z",
      actionIds: actions.map((action) => action.id),
      payload: {
        summary: "failed parallel report-only fixture",
        assumptions: [],
        questions: [],
        scope: [],
        nonScope: [],
        risks: [],
        tasks: [],
        batches: [["task-review", "task-evaluate"]],
        userMessage: "fixture",
      },
    };
    const evidence = createParallelismEvidenceFromPlanResult({
      observedAt: "2026-05-07T10:02:00.000Z",
      plan,
      actions,
      runLogs: [
        runLog({ task: reviewTask, agent: reviewer, runId: "run-review" }),
        runLog({ task: evaluateTask, agent: evaluator, runId: "run-evaluate", pass: false }),
      ],
    });

    await store.append(evidence);

    expect(evidence.outcome).toBe("mixed");
    expect(evidence.verification).toEqual({
      pass: false,
      summary: "Recorded preserved evidence with outcome mixed.",
      failedCommands: ["bun typecheck"],
    });
    expect(evidence.refs.map((ref) => ref.outcome)).toEqual(["pass", "failed"]);
    expect(await store.list({ outcome: "mixed" })).toEqual([evidence]);
  });

  test("does not expand writer authority through evidence records", () => {
    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
    expect(() =>
      createParallelismEvidenceRecord({
        observedAt: "2026-05-07T10:02:00.000Z",
        planId: "plan-two-writers",
        ancestry,
        batches: [["task-write-a", "task-write-b"]],
        refs: [
          {
            taskId: "task-write-a",
            actionId: "action-write-a",
            runId: "run-write-a",
            runLogPath: "/runs/run-write-a.json",
            agentId: writer.id,
            agentRole: writer.role,
            resultMode: "write",
            outcome: "pass",
            changedFiles: ["src/a.ts"],
          },
          {
            taskId: "task-write-b",
            actionId: "action-write-b",
            runId: "run-write-b",
            runLogPath: "/runs/run-write-b.json",
            agentId: writer.id,
            agentRole: writer.role,
            resultMode: "write",
            outcome: "pass",
            changedFiles: ["src/b.ts"],
          },
        ],
        verification: { pass: true, summary: "two writers are not allowed by Phase 7 M2" },
        mergeStatus: "pending",
        cleanupStatus: "pending",
        outcome: "pass",
      }),
    ).toThrow("parallelism evidence writerCount exceeds policy cap: 2 > 1");
  });

  test("keeps the evidence document aligned with enforced writer-cap and gate coverage", async () => {
    const [
      evidence,
      policyTests,
      operationsTests,
      materializerTests,
      lifecycleTests,
      mergeGateTests,
      cleanupTests,
    ] = await Promise.all([
      read("docs/PARALLELISM_EVIDENCE.md"),
      read("tests/policy.test.ts"),
      read("tests/operations.test.ts"),
      read("tests/orchestrator-materializer.test.ts"),
      read("tests/run-lifecycle-store.test.ts"),
      read("tests/merge-gate.test.ts"),
      read("tests/worktree-cleanup.test.ts"),
    ]);

    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
    expect(evidence).toContain("There is no automatic Phase 7 writer cap increase.");
    expect(evidence).toContain("If any item is missing, the writer cap stays `1`.");

    for (const filename of [
      "tests/policy.test.ts",
      "tests/operations.test.ts",
      "tests/orchestrator-materializer.test.ts",
      "tests/parallelism-evidence.test.ts",
      "tests/merge-gate.test.ts",
      "tests/worktree-cleanup.test.ts",
      "tests/run-lifecycle-store.test.ts",
      "tests/recovery-context.test.ts",
      "tests/recovery-continuity.test.ts",
    ]) {
      expect(evidence).toContain(filename);
    }

    expect(policyTests).toContain('test("keeps the default writer cap at one"');
    expect(operationsTests).toContain('test("runs ready reviewer, researcher, and evaluator reports in parallel before serialized writers"');
    expect(operationsTests).toContain('test("serializes ready writers under writer cap one"');
    expect(materializerTests).toContain('test("blocks a batch that exceeds writer cap one"');
    expect(materializerTests).toContain('test("blocks non-writer proposals that request write behavior"');
    expect(lifecycleTests).toContain('test("marks merge, push, and cleanup lifecycle events"');
    expect(mergeGateTests).toContain('test("does not apply merge when the gate is blocked"');
    expect(cleanupTests).toContain('test("blocks cleanup before the worker commit is integrated"');
  });

  test("reports parallel non-writer outcomes separately from a single mergeable writer", () => {
    const reviewTask = task({
      id: "task-review",
      title: "Scope report",
      targetAgent: reviewer.id,
      resultMode: "report",
    });
    const evaluateTask = task({
      id: "task-evaluate",
      title: "Verify report",
      targetAgent: evaluator.id,
      resultMode: "report",
    });
    const writeTask = task({
      id: "task-write",
      title: "Apply focused change",
      targetAgent: writer.id,
      resultMode: "write",
    });
    const actions = [
      completedAction(reviewTask, "run-review"),
      completedAction(evaluateTask, "run-evaluate"),
      completedAction(writeTask, "run-write"),
    ];
    const plan: OrchestratorPlanRecord = {
      schemaVersion: 1,
      id: "plan-parallelism",
      requestId: "request-parallelism",
      status: "materialized",
      createdAt: "2026-05-07T09:59:00.000Z",
      actionIds: actions.map((action) => action.id),
    };

    const report = orchestratorPlanResultReport({
      plan,
      actions,
      runLogs: [
        runLog({ task: reviewTask, agent: reviewer, runId: "run-review" }),
        runLog({ task: evaluateTask, agent: evaluator, runId: "run-evaluate" }),
        runLog({ task: writeTask, agent: writer, runId: "run-write", commitHash: "abc123" }),
      ],
      synthesis: {
        outcome: "pass",
        summary: "parallel role evidence passed",
        nextActions: [],
        risks: [],
        userMessage: "Parallel specialists reported, and the writer produced one merge candidate.",
      },
    });

    expect(report).toContain("완료 작업: 3/3");
    expect(report).toContain("Reviewer: Scope report: 보고 완료 (계획/보고)");
    expect(report).toContain("Evaluator: Verify report: 보고 완료 (계획/보고)");
    expect(report).toContain("Writer: Apply focused change: 통과 (구현/수정)");
    expect(report).toContain("작업 유형: 구현/수정 - merge 필요");
    expect(report).toContain("로컬 merge 후보:");
    expect(report).not.toContain("action-");
    expect(report).not.toContain("status=");
    expect(report).not.toContain("HARNESS_RESULT");
    expect(report).not.toContain("plan-parallelism");
  });
});
