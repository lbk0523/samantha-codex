import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { AgentProfile, TaskResultMode, TaskSpec } from "../src/lib/contracts";
import { orchestratorPlanResultReport } from "../src/lib/operator-reports";
import type { OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import { DEFAULT_SAFETY_POLICY } from "../src/lib/policy";
import { createRemoteDispatchAction, type RemoteActionRecord } from "../src/lib/remote-action-store";
import type { WorkerRunLog } from "../src/lib/run-log";

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

function task(input: { id: string; title: string; targetAgent: string; resultMode: TaskResultMode }): TaskSpec {
  const reportOnly = input.resultMode === "report";

  return {
    id: input.id,
    title: input.title,
    targetAgent: input.targetAgent,
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

function runLog(input: {
  task: TaskSpec;
  agent: AgentProfile;
  runId: string;
  commitHash?: string;
}): WorkerRunLog {
  const changedFiles = input.commitHash ? ["src/lib/parallelism.ts"] : [];

  return {
    schemaVersion: 1,
    runId: input.runId,
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
        pass: true,
        harness: { status: "pass", note: "done", commit: input.commitHash ?? "" },
        changedFiles,
        scopeViolations: [],
        verifyResults: [],
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
      pass: true,
    },
  };
}

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("parallelism evidence", () => {
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
    expect(evidence).toContain("There is no Stage 9 writer cap increase.");
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
    expect(operationsTests).toContain('test("runs ready non-writers in parallel before serialized writers"');
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
