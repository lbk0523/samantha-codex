import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import type { AgentProfile } from "../src/lib/contracts";
import { createDecisionItem, DecisionStore } from "../src/lib/decision-store";
import { OrchestratorPlanStore, type OrchestratorPlanPayload } from "../src/lib/orchestrator-store";
import { commandFromRemoteInput } from "../src/lib/remote-command";
import { createRoutineTriggerRecord } from "../src/lib/routine-trigger-store";

let tmpRoots: string[] = [];

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

function ancestry(projectId: string, workItemId: string) {
  return {
    mode: "assigned" as const,
    projectId,
    goalId: `goal-${projectId}-operations`,
    workItemId,
  };
}

function payload(projectId: string, id: string): OrchestratorPlanPayload {
  return {
    summary: `${projectId} plan`,
    assumptions: [],
    questions: [],
    scope: ["focused change"],
    nonScope: [],
    risks: [],
    tasks: [
      {
        id,
        title: `${projectId} task`,
        targetAgent: "codex-worker",
        projectId,
        resultMode: "write",
        targetFiles: ["src/allowed.ts"],
        forbiddenChanges: ["state/**"],
        setupCommands: [],
        verifyCommands: ["bun test tests/remote-project-selection.test.ts"],
        instructions: "Make the focused change.",
      },
    ],
    batches: [[id]],
    userMessage: "계획을 만들었습니다.",
  };
}

async function setupRoot() {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-m6-"));
  tmpRoots.push(root);
  const inbox = join(root, "inbox");
  const outbox = join(root, "outbox");
  const archive = join(root, "archive");
  const state = join(root, "state");
  const agents = join(root, "agents");
  const projects = join(root, "projects");
  await Promise.all([inbox, state, agents, projects].map((path) => mkdir(path, { recursive: true })));
  await writeFile(
    join(state, "host-ownership.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        role: "active_automation_host",
        hostId: process.env.SAMANTHA_HOST_ID ?? hostname(),
        updatedAt: "2026-05-10T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(agents, "codex-worker.json"), `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  for (const projectId of ["samantha", "omht"]) {
    await writeFile(
      join(projects, `${projectId}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: projectId,
          repoRoot: `/repo/${projectId}`,
          setupCommands: [],
          verifyCommands: ["bun test"],
          forbiddenChanges: [],
          defaultRemoteScopeId: "implementation",
          remoteScopes: [
            {
              id: "implementation",
              label: "Implementation",
              description: "Implementation work.",
              risk: "medium",
              targetFiles: ["src/**"],
              verifyCommands: ["bun test"],
              planSteps: ["Inspect", "Change", "Verify"],
              successCriteria: ["Verified"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return { root, inbox, outbox, archive, state, agents, projects };
}

async function seedPlan(input: { state: string; projectId: string; planId: string; createdAt: string }) {
  const workItemId = `request-${input.projectId}`;
  const plan = {
    schemaVersion: 1 as const,
    id: input.planId,
    ancestry: ancestry(input.projectId, workItemId),
    requestId: workItemId,
    status: "planned" as const,
    createdAt: input.createdAt,
    completedAt: input.createdAt,
    payload: payload(input.projectId, `${input.projectId}-task`),
  };
  await new OrchestratorPlanStore(join(input.state, "orchestrator-plans.jsonl")).append(plan);
  await new DecisionStore(join(input.state, "decisions.jsonl")).append(
    createDecisionItem({
      kind: "orchestrator_plan_approval",
      ancestry: plan.ancestry,
      title: `Review ${input.projectId}`,
      prompt: "Approve or revise.",
      options: ["approve", "revise", "cancel"],
      subject: { type: "orchestrator_plan", id: input.planId },
      source: "system",
      createdAt: input.createdAt,
    }),
  );
}

async function runInbox(ctx: Awaited<ReturnType<typeof setupRoot>>) {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "src/samantha.ts",
      "inbox:process",
      `--state-dir=${ctx.state}`,
      `--inbox-dir=${ctx.inbox}`,
      `--outbox-dir=${ctx.outbox}`,
      `--archive-dir=${ctx.archive}`,
      `--agent-profiles-dir=${ctx.agents}`,
      `--project-profiles-dir=${ctx.projects}`,
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
  return stdout;
}

async function runSamantha(ctx: Awaited<ReturnType<typeof setupRoot>>, command: string[]) {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "src/samantha.ts",
      ...command,
      `--state-dir=${ctx.state}`,
      `--agent-profiles-dir=${ctx.agents}`,
      `--project-profiles-dir=${ctx.projects}`,
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
  return stdout;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("remote project selection guards", () => {
  test("routine observations create only one project-scoped pending request before normal gates", async () => {
    const ctx = await setupRoot();
    const routine = createRoutineTriggerRecord({
      triggerId: "daily-samantha-review",
      sourceKind: "schedule",
      projectId: "samantha",
      enabled: true,
      riskClass: "medium",
      sourceEvidence: ["docs/CONTINUOUS_24_7_OPERATIONS.md M6"],
      fingerprintInputs: [
        { key: "cadence", value: "daily" },
        { key: "intent", value: "review-open-work" },
      ],
      activationDecisionId: "decision-routine-activation",
      createdAt: "2026-05-10T01:00:00.000Z",
    });
    const approval = {
      ...createDecisionItem({
        kind: "routine_change",
        title: "Activate routine",
        prompt: "Approve routine activation.",
        options: ["approve", "reject"],
        source: "system",
        subject: { type: "routine", id: routine.id },
        createdAt: "2026-05-10T01:00:10.000Z",
      }),
      id: "decision-routine-activation",
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-10T01:00:20.000Z",
      resolvedBy: "bk" as const,
    };
    await writeFile(join(ctx.state, "routine-triggers.jsonl"), `${JSON.stringify(routine)}\n`, "utf8");
    await writeFile(join(ctx.state, "decisions.jsonl"), `${JSON.stringify(approval)}\n`, "utf8");

    const first = JSON.parse(await runSamantha(ctx, [
      "routine:observe",
      routine.id,
      "--text=Review open Samantha work and propose the next bounded plan.",
      "--observed-at=2026-05-10T01:01:00.000Z",
    ]));
    const second = JSON.parse(await runSamantha(ctx, [
      "routine:observe",
      routine.id,
      "--text=Review open Samantha work and propose the next bounded plan.",
      "--observed-at=2026-05-10T01:02:00.000Z",
    ]));

    expect(first.request).toMatchObject({
      status: "pending_plan",
      routineTriggerId: routine.triggerId,
      routineFingerprint: routine.fingerprint,
      ancestry: {
        mode: "assigned",
        projectId: "samantha",
        goalId: "goal-samantha-operations",
      },
      admission: { subjectKind: "routine_trigger", decision: "accept" },
    });
    expect(second.request).toBeUndefined();
    expect(second.observation.status).toBe("coalesced");
    expect(second.observation.coalescedWith).toEqual([
      {
        kind: "request",
        id: first.request.id,
        status: "pending_plan",
        routineTriggerId: routine.triggerId,
        routineFingerprint: routine.fingerprint,
      },
    ]);
    expect(await readFile(join(ctx.state, "orchestration-requests.jsonl"), "utf8")).toContain(first.request.id);
    await expect(readFile(join(ctx.state, "tasks.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(ctx.state, "remote-actions.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("ambiguous remote approve, go, and now refuse cross-project current plans", async () => {
    const ctx = await setupRoot();
    await seedPlan({ state: ctx.state, projectId: "samantha", planId: "plan-samantha", createdAt: "2026-05-10T01:00:00.000Z" });
    await seedPlan({ state: ctx.state, projectId: "omht", planId: "plan-omht", createdAt: "2026-05-10T01:01:00.000Z" });
    await writeFile(join(ctx.inbox, "001-approve.json"), JSON.stringify({ type: "decisions:approve-latest", args: { receivedAt: "2026-05-10T01:02:00.000Z" } }), "utf8");
    await writeFile(join(ctx.inbox, "002-go.json"), JSON.stringify({ type: "actions:go", args: { receivedAt: "2026-05-10T01:03:00.000Z" } }), "utf8");
    await writeFile(join(ctx.inbox, "003-now.json"), JSON.stringify({ type: "ops:now", args: { receivedAt: "2026-05-10T01:04:00.000Z" } }), "utf8");

    await runInbox(ctx);

    expect(await readFile(join(ctx.outbox, "001-approve.md"), "utf8")).toContain("두 개 이상의 현재 계획 승인 결정");
    expect(await readFile(join(ctx.outbox, "002-go.md"), "utf8")).toContain("두 개 이상의 현재 계획");
    const now = await readFile(join(ctx.outbox, "003-now.md"), "utf8");
    expect(now).toContain("여러 프로젝트에 현재 계획");
    expect(now).toContain("samantha: 계획 검토");
    expect(now).toContain("omht: 계획 검토");
    expect(now).not.toContain("계획 승인 및 worker 실행 큐 등록: `/go`");
  });

  test("stale project context cannot approve or materialize another project's newer plan", async () => {
    const ctx = await setupRoot();
    await seedPlan({ state: ctx.state, projectId: "samantha", planId: "plan-samantha", createdAt: "2026-05-10T01:00:00.000Z" });
    await seedPlan({ state: ctx.state, projectId: "omht", planId: "plan-omht", createdAt: "2026-05-10T01:05:00.000Z" });
    await writeFile(join(ctx.inbox, "001-approve.json"), JSON.stringify({ type: "decisions:approve-latest", args: { projectId: "samantha", receivedAt: "2026-05-10T01:06:00.000Z" } }), "utf8");
    await writeFile(join(ctx.inbox, "002-go.json"), JSON.stringify({ type: "actions:go", args: { projectId: "samantha", receivedAt: "2026-05-10T01:07:00.000Z" } }), "utf8");

    await runInbox(ctx);

    const decisions = await new DecisionStore(join(ctx.state, "decisions.jsonl")).list();
    expect(decisions.find((decision) => decision.subject?.id === "plan-samantha")).toMatchObject({ status: "resolved", resolution: "approved" });
    expect(decisions.find((decision) => decision.subject?.id === "plan-omht")).toMatchObject({ status: "pending" });
    expect(await readFile(join(ctx.outbox, "002-go.md"), "utf8")).toContain("오케스트레이터 계획을 승인했고 worker 실행 큐에 등록했습니다.");
    expect(await new OrchestratorPlanStore(join(ctx.state, "orchestrator-plans.jsonl")).find("plan-samantha")).toMatchObject({ status: "materialized" });
    expect(await new OrchestratorPlanStore(join(ctx.state, "orchestrator-plans.jsonl")).find("plan-omht")).toMatchObject({ status: "planned" });
  });

  test("unsupported project and scope ids fail closed before planning writes work", async () => {
    const ctx = await setupRoot();
    await writeFile(
      join(ctx.state, "orchestration-requests.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "request-samantha",
        ancestry: ancestry("samantha", "request-samantha"),
        source: "remote",
        text: "samantha work",
        status: "pending_plan",
        createdAt: "2026-05-10T01:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(join(ctx.inbox, "001-bad-project.json"), JSON.stringify({ type: "orchestrator:plan-latest", args: { projectId: "missing", receivedAt: "2026-05-10T01:01:00.000Z" } }), "utf8");
    await writeFile(join(ctx.inbox, "002-bad-scope.json"), JSON.stringify({ type: "orchestrator:plan-latest", args: { projectId: "samantha", scopeId: "missing", receivedAt: "2026-05-10T01:02:00.000Z" } }), "utf8");

    const stdout = await runInbox(ctx);

    expect(stdout).toContain('"ok": false');
    expect(await readFile(join(ctx.outbox, "001-bad-project.md"), "utf8")).toContain("project profile not found: missing");
    expect(await readFile(join(ctx.outbox, "002-bad-scope.md"), "utf8")).toContain("remote scope not found: missing");
    expect(await new OrchestratorPlanStore(join(ctx.state, "orchestrator-plans.jsonl")).list()).toEqual([]);
  });

  test("local current inspection reports precise project-filtered ids", async () => {
    const ctx = await setupRoot();
    await seedPlan({ state: ctx.state, projectId: "samantha", planId: "plan-samantha", createdAt: "2026-05-10T01:00:00.000Z" });
    await seedPlan({ state: ctx.state, projectId: "omht", planId: "plan-omht", createdAt: "2026-05-10T01:01:00.000Z" });

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "orchestrator:current",
        `--state-dir=${ctx.state}`,
        `--project-profiles-dir=${ctx.projects}`,
        "--project=samantha",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stderr, exitCode }).toMatchObject({ stderr: "", exitCode: 0 });
    const report = JSON.parse(stdout) as { currentPlans: Array<{ id: string }>; currentDecisions: Array<{ subject?: { id: string } }> };
    expect(report.currentPlans.map((plan) => plan.id)).toEqual(["plan-samantha"]);
    expect(report.currentDecisions.map((decision) => decision.subject?.id)).toEqual(["plan-samantha"]);
  });

  test("remote parser accepts project-qualified compact commands without accepting internal ids", () => {
    expect(commandFromRemoteInput({ senderId: "bk", text: "/approve project:samantha" }, "bk")).toMatchObject({
      type: "decisions:approve-latest",
      args: { projectId: "samantha" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/answer project:samantha 계속 진행" }, "bk")).toMatchObject({
      type: "decisions:answer-blocker-clarification",
      args: { projectId: "samantha", note: "계속 진행" },
    });
    expect(() => commandFromRemoteInput({ senderId: "bk", text: "/approve decision-abc123" }, "bk")).toThrow("unsupported remote command");
  });
});
