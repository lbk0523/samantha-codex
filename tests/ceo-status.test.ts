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
    tasks: [],
    batches: [],
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
    expect(report).toContain("Summary: decisions=0 active=0 blocked=0 completed=0 risks=0");
    expect(report).toContain("BK decisions:\n- none");
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

  test("planned and question plans appear under BK decisions", () => {
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
    expect(report).toContain("BK decisions:\n- Decision: Review CEO status plan");
    expect(report).toContain("subject=orchestrator_plan:plan-1");
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
    const retryReportLedger = await readFile(join(stateDir, "ceo-reports.jsonl"), "utf8");
    expect(retryReportLedger.split("\n").filter(Boolean)).toHaveLength(1);
  });
});
