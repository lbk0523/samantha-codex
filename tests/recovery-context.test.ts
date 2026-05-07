import { describe, expect, test } from "bun:test";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import { createRemoteDispatchAction } from "../src/lib/remote-action-store";
import { buildRecoveryRequestText } from "../src/lib/recovery-context";
import type { WorkerRunLog } from "../src/lib/run-log";

const task: TaskSpec = {
  id: "task-failed",
  title: "Fix failed workflow",
  targetAgent: "codex-worker",
  projectId: "samantha",
  repoRoot: "/repo/samantha-codex",
  targetFiles: ["src/**", "tests/**"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun typecheck"],
  instructions: "Fix the workflow.",
  status: "pending",
};

const agent: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: {
    requiredBundles: [],
    blockedSkills: [
      "using-git-worktrees",
      "dispatching-parallel-agents",
      "subagent-driven-development",
    ],
  },
};

const request: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-original",
  source: "remote",
  senderId: "bk",
  text: "Fix the workflow without broad retries.",
  status: "planned",
  createdAt: "2026-05-07T10:00:00.000Z",
  plannedAt: "2026-05-07T10:01:00.000Z",
};

const plan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-failed",
  requestId: request.id,
  status: "materialized",
  createdAt: "2026-05-07T10:01:00.000Z",
  materializedAt: "2026-05-07T10:02:00.000Z",
  resultReportedAt: "2026-05-07T10:10:00.000Z",
  payload: {
    summary: "Workflow recovery target",
    assumptions: [],
    questions: [],
    scope: ["worker dispatch", "verification"],
    nonScope: ["blind retry"],
    risks: ["old worker worktree paths are evidence only"],
    tasks: [
      {
        id: "failed",
        title: "Fix failed workflow",
        targetAgent: "codex-worker",
        projectId: "samantha",
        repoRoot: "",
        resultMode: "write",
        targetFiles: ["src/**", "tests/**"],
        forbiddenChanges: ["state/**"],
        setupCommands: [],
        verifyCommands: ["bun typecheck"],
        instructions: "Fix the workflow.",
        dependencies: [],
      },
    ],
    batches: [["failed"]],
    userMessage: "Plan failed.",
  },
  synthesis: {
    outcome: "failed",
    summary: "typecheck failed",
    nextActions: ["recover"],
    risks: ["verify remains red"],
    userMessage: "The original typecheck failure remains.",
  },
};

const failedAction = {
  ...createRemoteDispatchAction({
    task,
    repoRoot: "/repo/samantha-codex",
    createdAt: "2026-05-07T10:02:00.000Z",
    source: "remote" as const,
    commandId: "remote-go",
  }),
  status: "failed" as const,
  completedAt: "2026-05-07T10:09:00.000Z",
  result: {
    runId: "run-failed",
    runLogPath: "/runs/run-failed.json",
    pass: false,
    outcome: "verify_failed",
    failure: "typecheck failed",
  },
};

const runLog: WorkerRunLog = {
  schemaVersion: 1,
  runId: "run-failed",
  startedAt: "2026-05-07T10:02:00.000Z",
  finishedAt: "2026-05-07T10:09:00.000Z",
  task,
  agent,
  input: { repoRoot: "/repo/samantha-codex", allocate: true, execute: true },
  result: {
    preparation: {
      taskId: task.id,
      agentId: agent.id,
      worktreePath: "/repo/.samantha-worktrees/samantha-codex/task-failed",
      codex: { prompt: "prompt", command: ["codex", "exec"] },
    },
    setupResults: [],
    command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
    evaluation: {
      pass: false,
      harness: { status: "rework", note: "typecheck failed in recovery target", commit: "" },
      changedFiles: ["src/lib/workflow.ts"],
      scopeViolations: [],
      verifyResults: [{ command: "bun typecheck", exitCode: 1, stdout: "", stderr: "TS2322 failure" }],
    },
    pass: false,
  },
};

describe("buildRecoveryRequestText", () => {
  test("includes failed-plan context while treating worker worktrees as evidence only", () => {
    const text = buildRecoveryRequestText({
      plan,
      actions: [failedAction],
      failedActions: [failedAction],
      request,
      runLogs: [runLog],
      artifactPreviews: [{ file: "src/lib/workflow.ts", text: "broken type assignment" }],
    });

    expect(text).toContain("원 계획 범위:");
    expect(text).toContain("worker dispatch");
    expect(text).toContain("원 계획 작업:");
    expect(text).toContain("repoRoot=(project profile canonical root)");
    expect(text).toContain("canonical action repoRoot: /repo/samantha-codex");
    expect(text).toContain("worker worktree evidence path: /repo/.samantha-worktrees/samantha-codex/task-failed");
    expect(text).toContain("검증 실패:");
    expect(text).toContain("bun typecheck exited 1");
    expect(text).toContain("새 복구 계획 결과 보고서는 원래 실패 원인이 해결됐는지 명시해야 합니다.");
    expect(text).toContain("worker worktree path를 repoRoot로 복사하지 마세요.");
    expect(text).toContain("broken type assignment");
  });
});
