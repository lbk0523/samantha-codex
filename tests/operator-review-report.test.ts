import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSpec } from "../src/lib/contracts";
import type { DecisionItem } from "../src/lib/decision-store";
import type { RunSummary } from "../src/lib/ledger";
import { operatorReviewReport } from "../src/lib/operator-review-report";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import type { RemoteActionRecord } from "../src/lib/remote-action-store";
import type { RunLifecycleRecord } from "../src/lib/run-lifecycle-store";
import type { WorkerRunLog } from "../src/lib/run-log";

let tmpRoots: string[] = [];

const task: TaskSpec = {
  id: "task-complete",
  title: "Complete fixture",
  targetAgent: "codex-worker",
  targetFiles: ["src/lib/review.ts"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun test"],
  instructions: "Complete fixture.",
  status: "completed",
};

const request: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-complete",
  source: "remote",
  senderId: "bk",
  text: "Implement the review report.",
  status: "planned",
  createdAt: "2026-05-09T00:00:00.000Z",
  plannedAt: "2026-05-09T00:01:00.000Z",
};

const plan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-complete",
  requestId: request.id,
  status: "materialized",
  createdAt: "2026-05-09T00:01:00.000Z",
  completedAt: "2026-05-09T00:02:00.000Z",
  approvedAt: "2026-05-09T00:03:00.000Z",
  materializedAt: "2026-05-09T00:04:00.000Z",
  resultReportedAt: "2026-05-09T00:10:00.000Z",
  synthesisAt: "2026-05-09T00:10:00.000Z",
  taskIds: [task.id],
  actionIds: ["action-complete"],
  synthesis: {
    outcome: "pass",
    summary: "Review report shipped.",
    nextActions: [],
    risks: [],
    userMessage: "Done.",
  },
  payload: {
    summary: "Operator review report",
    assumptions: [],
    questions: [],
    scope: ["Add local reconstruction report"],
    nonScope: ["Telegram details"],
    risks: ["Report must stay read-only."],
    tasks: [
      {
        id: "complete",
        title: task.title,
        targetAgent: task.targetAgent,
        projectId: "samantha",
        repoRoot: "/repo/samantha",
        resultMode: "write",
        targetFiles: task.targetFiles,
        forbiddenChanges: task.forbiddenChanges,
        verifyCommands: task.verifyCommands,
        instructions: task.instructions,
        dependencies: [],
      },
    ],
    batches: [["complete"]],
    userMessage: "Plan ready.",
  },
};

const decision: DecisionItem = {
  schemaVersion: 1,
  id: "decision-complete",
  status: "resolved",
  kind: "orchestrator_plan_approval",
  title: "Review plan: Operator review report",
  prompt: "Approve before materialization.",
  options: ["approve", "revise", "cancel"],
  source: "system",
  subject: { type: "orchestrator_plan", id: plan.id },
  risk: "medium",
  createdAt: "2026-05-09T00:02:30.000Z",
  updatedAt: "2026-05-09T00:03:00.000Z",
  resolvedAt: "2026-05-09T00:03:00.000Z",
  resolvedBy: "bk",
  resolution: "approved",
};

const action: RemoteActionRecord = {
  schemaVersion: 1,
  id: "action-complete",
  kind: "dispatch_task",
  status: "completed",
  createdAt: "2026-05-09T00:04:00.000Z",
  source: "remote",
  taskId: task.id,
  taskTitle: task.title,
  targetAgent: task.targetAgent,
  repoRoot: "/repo/samantha",
  allocate: true,
  execute: true,
  liveLog: true,
  orchestratorPlanId: plan.id,
  orchestratorTaskId: "complete",
  approvedAt: "2026-05-09T00:04:00.000Z",
  startedAt: "2026-05-09T00:05:00.000Z",
  completedAt: "2026-05-09T00:06:00.000Z",
  result: {
    runId: "run-complete",
    runLogPath: "/logs/run-complete.json",
    liveLogPath: "/logs/live/run-complete.jsonl",
    pass: true,
    outcome: "pass",
  },
};

const run: RunSummary = {
  schemaVersion: 1,
  runId: "run-complete",
  taskId: task.id,
  taskTitle: task.title,
  agentId: task.targetAgent,
  repoRoot: "/repo/samantha",
  worktreePath: "/repo/samantha/.samantha-worktrees/task-complete",
  logPath: "/logs/run-complete.json",
  startedAt: "2026-05-09T00:05:00.000Z",
  finishedAt: "2026-05-09T00:06:00.000Z",
  outcome: "pass",
  pass: true,
  commit: "abcdef1234567890",
};

const runLog: WorkerRunLog = {
  schemaVersion: 1,
  runId: run.runId,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  task,
  agent: {
    id: "codex-worker",
    role: "writer",
    model: "gpt-5.5",
    writerClass: "writer",
    worktreePolicy: "per-task",
    mergePolicy: "samantha-controlled",
    skillPolicy: { requiredBundles: [], blockedSkills: [] },
  },
  input: { repoRoot: run.repoRoot, allocate: true, execute: true },
  result: {
    preparation: {
      taskId: task.id,
      agentId: "codex-worker",
      worktreePath: run.worktreePath,
      codex: { prompt: "prompt", command: ["codex", "exec"] },
    },
    setupResults: [],
    command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
    evaluation: {
      pass: true,
      harness: { status: "pass", note: "done", commit: "" },
      changedFiles: ["src/lib/review.ts"],
      scopeViolations: [],
      verifyResults: [{ command: "bun test", exitCode: 0, stdout: "", stderr: "" }],
    },
    commit: {
      subject: "feat: review report",
      files: ["src/lib/review.ts"],
      add: { command: ["git", "add", "src/lib/review.ts"], exitCode: 0, stdout: "", stderr: "" },
      commit: { command: ["git", "commit", "-m", "feat: review report"], exitCode: 0, stdout: "", stderr: "" },
      commitHash: run.commit,
    },
    pass: true,
  },
};

const lifecycle: RunLifecycleRecord = {
  schemaVersion: 1,
  runId: run.runId,
  taskId: task.id,
  repoRoot: run.repoRoot,
  runLogPath: run.logPath,
  commit: run.commit,
  mergedAt: "2026-05-09T00:07:00.000Z",
  pushedAt: "2026-05-09T00:08:00.000Z",
  cleanedAt: "2026-05-09T00:09:00.000Z",
  updatedAt: "2026-05-09T00:09:00.000Z",
};

function completedInput(overrides: Partial<Parameters<typeof operatorReviewReport>[0]> = {}): Parameters<typeof operatorReviewReport>[0] {
  return {
    subject: { type: "request", id: request.id },
    requests: [request],
    plans: [plan],
    decisions: [decision],
    tasks: [task],
    actions: [action],
    runs: [run],
    runLogs: [runLog],
    lifecycles: [lifecycle],
    ...overrides,
  };
}

async function writeJsonl<T>(path: string, items: T[]): Promise<void> {
  await writeFile(path, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("operator review report", () => {
  test("reconstructs a completed request through cleanup", () => {
    const report = operatorReviewReport(completedInput());

    expect(report).toContain("Final state: completed");
    expect(report).toContain("Audit gaps: none");
    expect(report).toContain("request -> plan -> decision -> task -> action -> run -> verify -> merge -> push -> cleanup -> recovery");
    expect(report).toContain("decision `decision-complete` kind=`orchestrator_plan_approval` status=`approved` resolution=`approved`");
    expect(report).toContain("risk=`medium`");
    expect(report).toContain("changedFiles=`src/lib/review.ts`");
    expect(report).toContain("pass exit=`0` command=`bun test`");
    expect(report).toContain("commit=`abcdef1234567890`");
    expect(report).toContain("merge run=`run-complete` status=yes");
    expect(report).toContain("push run=`run-complete` status=yes");
    expect(report).toContain("cleanup run=`run-complete` status=yes");
    expect(report).toContain("recovery: none recorded");

    expect(report.indexOf("Request:")).toBeLessThan(report.indexOf("Plan:"));
    expect(report.indexOf("Plan:")).toBeLessThan(report.indexOf("Decision / Approval:"));
    expect(report.indexOf("Decision / Approval:")).toBeLessThan(report.indexOf("Task:"));
    expect(report.indexOf("Task:")).toBeLessThan(report.indexOf("Action:"));
    expect(report.indexOf("Action:")).toBeLessThan(report.indexOf("Run:"));
    expect(report.indexOf("Run:")).toBeLessThan(report.indexOf("Verify:"));
    expect(report.indexOf("Verify:")).toBeLessThan(report.indexOf("Merge / Push / Cleanup:"));
    expect(report.indexOf("Merge / Push / Cleanup:")).toBeLessThan(report.indexOf("Recovery:"));
  });

  test("shows a failed source plan fixed by a recovery plan", () => {
    const sourceRequest = { ...request, id: "request-source", text: "Fix a broken workflow." };
    const sourceTask = { ...task, id: "task-source", status: "failed" as const };
    const sourceAction: RemoteActionRecord = {
      ...action,
      id: "action-source",
      taskId: sourceTask.id,
      taskTitle: sourceTask.title,
      status: "failed",
      result: {
        runId: "run-source",
        runLogPath: "/logs/run-source.json",
        pass: false,
        outcome: "verify_failed",
        failure: "verify command failed",
      },
    };
    const sourceRun: RunSummary = {
      ...run,
      runId: "run-source",
      taskId: sourceTask.id,
      taskTitle: sourceTask.title,
      outcome: "verify_failed",
      pass: false,
      commit: "",
      failureReason: "verify command failed (1): bun test",
      logPath: "/logs/run-source.json",
    };
    const sourceRunLog: WorkerRunLog = {
      ...runLog,
      runId: sourceRun.runId,
      task: sourceTask,
      result: {
        ...runLog.result,
        evaluation: {
          pass: false,
          harness: { status: "rework", note: "verify failed", commit: "" },
          changedFiles: ["src/lib/broken.ts"],
          scopeViolations: [],
          verifyResults: [{ command: "bun test", exitCode: 1, stdout: "", stderr: "TS2322" }],
        },
        commit: undefined,
        pass: false,
      },
    };
    const sourcePlan: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-source",
      requestId: sourceRequest.id,
      taskIds: [sourceTask.id],
      actionIds: [sourceAction.id],
      synthesis: {
        outcome: "failed",
        summary: "verify failed",
        nextActions: [],
        risks: ["Typecheck still fails."],
        userMessage: "Recovery needed.",
      },
    };
    const sourceDecision = { ...decision, id: "decision-source", subject: { type: "orchestrator_plan" as const, id: sourcePlan.id } };
    const recoveryRequest: OrchestrationRequestRecord = {
      ...request,
      id: "request-recovery",
      text: "Recover the failed workflow.",
      recoveryOfPlanId: sourcePlan.id,
    };
    const recoveryPlan: OrchestratorPlanRecord = {
      ...plan,
      id: "plan-recovery",
      requestId: recoveryRequest.id,
      actionIds: ["action-recovery"],
      taskIds: ["task-recovery"],
      synthesis: {
        outcome: "pass",
        summary: "source failure fixed",
        nextActions: [],
        risks: [],
        userMessage: "Recovered.",
      },
    };
    const recoveryAction = {
      ...action,
      id: "action-recovery",
      taskId: "task-recovery",
      orchestratorPlanId: recoveryPlan.id,
      result: { runId: "run-recovery", runLogPath: "/logs/run-recovery.json", pass: true, outcome: "pass" },
    };

    const report = operatorReviewReport({
      subject: { type: "plan", id: sourcePlan.id },
      requests: [sourceRequest, recoveryRequest],
      plans: [sourcePlan, recoveryPlan],
      decisions: [sourceDecision],
      tasks: [sourceTask, { ...task, id: "task-recovery" }],
      actions: [sourceAction, recoveryAction],
      runs: [sourceRun, { ...run, runId: "run-recovery", taskId: "task-recovery", commit: "" }],
      runLogs: [sourceRunLog, { ...runLog, runId: "run-recovery", task: { ...task, id: "task-recovery" }, result: { ...runLog.result, commit: undefined } }],
      lifecycles: [],
    });

    expect(report).toContain("Final state: failed, recovered");
    expect(report).toContain("verify failed");
    expect(report).toContain("fail exit=`1` command=`bun test`");
    expect(report).toContain("recovery request `request-recovery`");
    expect(report).toContain("plan `plan-recovery` status=`materialized` synthesis=`pass` verdict=`fixed`");
    expect(report).toContain("Audit gaps: none");
  });

  test("flags missing links and partially integrated runs as audit gaps", () => {
    const partial = operatorReviewReport(
      completedInput({
        lifecycles: [{ ...lifecycle, pushedAt: undefined, cleanedAt: undefined }],
      }),
    );
    expect(partial).toContain("Final state: partially_integrated");
    expect(partial).toContain("push: no pushedAt timestamp for committed run run-complete");
    expect(partial).toContain("cleanup: no cleanedAt timestamp for committed run run-complete");

    const missing = operatorReviewReport({
      subject: { type: "plan", id: "plan-missing" },
      requests: [request],
      plans: [{ ...plan, id: "plan-missing", actionIds: ["action-missing"], taskIds: ["task-missing"], synthesis: undefined }],
      decisions: [],
      tasks: [],
      actions: [],
      runs: [],
      runLogs: [],
      lifecycles: [],
    });
    expect(missing).toContain("Audit gaps:");
    expect(missing).toContain("decision: no decision record for plan plan-missing");
    expect(missing).toContain("task: missing task record task-missing");
    expect(missing).toContain("action: missing action record action-missing");
  });

  test("CLI review path reads stored state without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-review-report-"));
    tmpRoots.push(root);
    const state = join(root, "state");
    await mkdir(state, { recursive: true });
    const logPath = join(root, "run-complete.json");
    const storedRun = { ...run, logPath };
    const storedAction = { ...action, result: { ...action.result, runLogPath: logPath } };
    await writeFile(logPath, `${JSON.stringify({ ...runLog, runId: storedRun.runId }, null, 2)}\n`, "utf8");
    await writeJsonl(join(state, "orchestration-requests.jsonl"), [request]);
    await writeJsonl(join(state, "orchestrator-plans.jsonl"), [plan]);
    await writeJsonl(join(state, "decisions.jsonl"), [decision]);
    await writeJsonl(join(state, "tasks.jsonl"), [task]);
    await writeJsonl(join(state, "remote-actions.jsonl"), [storedAction]);
    await writeJsonl(join(state, "runs.jsonl"), [storedRun]);
    await writeJsonl(join(state, "run-lifecycle.jsonl"), [{ ...lifecycle, runLogPath: logPath }]);

    const proc = Bun.spawn(
      ["bun", "run", "src/samantha.ts", "review:show", request.id, `--state-dir=${state}`],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stderr, exitCode }).toMatchObject({ stderr: "", exitCode: 0 });
    expect(stdout).toContain("# operator-review");
    expect(stdout).toContain("Final state: completed");
    expect(stdout).toContain("Audit gaps: none");
  });
});
