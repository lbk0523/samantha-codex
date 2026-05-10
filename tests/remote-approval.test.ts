import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { createDecisionItem } from "../src/lib/decision-store";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-approval-"));
  tmpRoots.push(root);
  return root;
}

async function processInbox(input: {
  state: string;
  inbox: string;
  outbox: string;
  archive: string;
  agentProfiles?: string;
  projectProfiles?: string;
  repoRoot?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = [
    "bun",
    "run",
    "src/samantha.ts",
    "inbox:process",
    `--state-dir=${input.state}`,
    `--inbox-dir=${input.inbox}`,
    `--outbox-dir=${input.outbox}`,
    `--archive-dir=${input.archive}`,
  ];
  if (input.agentProfiles) args.push(`--agent-profiles-dir=${input.agentProfiles}`);
  if (input.projectProfiles) args.push(`--project-profiles-dir=${input.projectProfiles}`);
  if (input.repoRoot) args.push(`--repo-root=${input.repoRoot}`);
  const proc = Bun.spawn(
    args,
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function planRecord(id: string, status = "planned"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    requestId: `request-${id}`,
    status,
    createdAt: "2026-05-07T10:59:00.000Z",
    completedAt: "2026-05-07T10:59:30.000Z",
    payload: {
      summary: `Plan ${id}`,
      assumptions: [],
      questions: [],
      scope: ["dispatch"],
      nonScope: [],
      risks: [],
      tasks: [],
      batches: [],
      userMessage: "Plan ready.",
    },
  };
}

function executablePlanRecord(id: string): Record<string, unknown> {
  const record = planRecord(id);
  const payload = record.payload as Record<string, unknown>;
  return {
    ...record,
    payload: {
      ...payload,
      scope: ["focused implementation"],
      tasks: [
        {
          id: "apply-focused-change",
          title: "Apply focused change",
          targetAgent: "codex-worker",
          projectId: "samantha",
          resultMode: "write",
          targetFiles: ["src/lib/policy.ts"],
          forbiddenChanges: ["state/**"],
          setupCommands: [],
          verifyCommands: ["bun typecheck"],
          instructions: "Apply the approved focused change.",
          dependencies: [],
        },
      ],
      batches: [["apply-focused-change"]],
    },
  };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("remote approval inbox flow", () => {
  test("records deferred request admission without resolving BK decisions", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    await writeFile(
      join(state, "host-ownership.json"),
      JSON.stringify({
        schemaVersion: 1,
        role: "active_automation_host",
        hostId: process.env.SAMANTHA_HOST_ID ?? hostname(),
        updatedAt: "2026-05-07T10:58:00.000Z",
      }),
      "utf8",
    );
    const decision = createDecisionItem({
      title: "Review active plan",
      prompt: "Approve before new routine work.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-active" },
      createdAt: "2026-05-07T10:59:00.000Z",
    });
    await writeFile(join(state, "decisions.jsonl"), `${JSON.stringify(decision)}\n`, "utf8");
    await writeFile(
      join(inbox, "remote-work.json"),
      JSON.stringify({
        id: "remote-work",
        type: "orchestrator:add-request",
        args: {
          source: "remote",
          receivedAt: "2026-05-07T11:00:00.000Z",
          text: "Add routine intake while a decision is pending",
        },
      }),
      "utf8",
    );

    expect(await processInbox({ state, inbox, outbox, archive })).toMatchObject({ exitCode: 0 });

    const report = await readFile(join(outbox, "remote-work.md"), "utf8");
    expect(report).toContain("Admission:");
    expect(report).toContain("decision=`defer`");
    expect(report).toContain("pending BK decisions=1");
    const requests = (await readFile(join(state, "orchestration-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; admission?: { decision: string; pressureClass: string; reason: string } });
    expect(requests).toEqual([
      expect.objectContaining({
        status: "pending_plan",
        admission: expect.objectContaining({
          decision: "defer",
          pressureClass: "needs_bk",
          reason: "pending BK decisions=1",
        }),
      }),
    ]);
    const decisions = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string });
    expect(decisions[0]).toMatchObject({ status: "pending" });
  });

  test("approves only the single pending plan decision without exposing ids", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    const decision = createDecisionItem({
      title: "Review plan: Mobile approval",
      prompt: "Approve, revise, or cancel before dispatch.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-mobile-approval" },
      createdAt: "2026-05-07T11:00:00.000Z",
    });
    await writeFile(join(state, "decisions.jsonl"), `${JSON.stringify(decision)}\n`, "utf8");
    await writeFile(join(state, "orchestrator-plans.jsonl"), `${JSON.stringify(planRecord("plan-mobile-approval"))}\n`, "utf8");
    await writeFile(
      join(inbox, "remote-approve.json"),
      JSON.stringify({
        id: "remote-approve",
        type: "decisions:approve-latest",
        args: { source: "remote", receivedAt: "2026-05-07T11:02:00.000Z" },
      }),
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const report = await readFile(join(outbox, "remote-approve.md"), "utf8");
    expect(report).toContain("# approve");
    expect(report).toContain("텔레그램: `/go`");
    expect(report).not.toContain(decision.id);
    const decisions = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; resolution?: string; resolutionNote?: string });
    expect(decisions[0]).toMatchObject({
      status: "resolved",
      resolution: "approved",
      resolutionNote: "Approved via Telegram /approve.",
    });
  });

  test("redirects Telegram approval when more than one current plan decision is pending", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    const decisions = ["A", "B"].map((title, index) =>
      createDecisionItem({
        title: `Review plan: ${title}`,
        prompt: "Approve, revise, or cancel before dispatch.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: `plan-${index}` },
        createdAt: `2026-05-07T11:0${index}:00.000Z`,
      }),
    );
    await writeFile(join(state, "decisions.jsonl"), decisions.map((decision) => JSON.stringify(decision)).join("\n") + "\n", "utf8");
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      [planRecord("plan-0"), planRecord("plan-1")].map((item) => JSON.stringify(item)).join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(inbox, "remote-approve.json"),
      JSON.stringify({ id: "remote-approve", type: "decisions:approve-latest", args: { source: "remote" } }),
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    const report = await readFile(join(outbox, "remote-approve.md"), "utf8");
    expect(report).toContain("Telegram approval is only allowed when exactly one current plan approval decision is pending.");
    expect(report).toContain("CLI 또는 dashboard");
    expect(report).not.toContain("decision-");
    const records = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; status: string; resolution?: string });
    expect(records).toEqual([
      expect.objectContaining({ id: decisions[0]?.id, status: "pending" }),
      expect.objectContaining({ id: decisions[1]?.id, status: "pending" }),
    ]);
  });

  test("rejects the latest current pending plan decision and closes the plan", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    const decision = createDecisionItem({
      title: "Review plan: Reject me",
      prompt: "Approve, revise, or cancel before dispatch.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-reject-me" },
      createdAt: "2026-05-07T11:00:00.000Z",
    });
    await writeFile(join(state, "decisions.jsonl"), `${JSON.stringify(decision)}\n`, "utf8");
    await writeFile(join(state, "orchestrator-plans.jsonl"), `${JSON.stringify(planRecord("plan-reject-me"))}\n`, "utf8");
    await writeFile(
      join(inbox, "remote-reject.json"),
      JSON.stringify({
        id: "remote-reject",
        type: "decisions:reject-latest",
        args: { source: "remote", receivedAt: "2026-05-07T11:03:00.000Z" },
      }),
      "utf8",
    );

    expect(await processInbox({ state, inbox, outbox, archive })).toMatchObject({ exitCode: 0 });

    const report = await readFile(join(outbox, "remote-reject.md"), "utf8");
    expect(report).toContain("# reject");
    expect(report).toContain("텔레그램: `/now`");
    expect(report).not.toContain(decision.id);
    const records = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; resolution?: string; resolutionNote?: string });
    expect(records[0]).toMatchObject({
      status: "resolved",
      resolution: "rejected",
      resolutionNote: "Rejected via latest decision command.",
    });
    const plans = (await readFile(join(state, "orchestrator-plans.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; canceledAt?: string; cancelReason?: string });
    expect(plans[0]).toMatchObject({
      status: "canceled",
      canceledAt: "2026-05-07T11:03:00.000Z",
      cancelReason: "Rejected via latest decision command.",
    });

    await writeFile(
      join(inbox, "remote-go.json"),
      JSON.stringify({
        id: "remote-go",
        type: "actions:go",
        args: { source: "remote", receivedAt: "2026-05-07T11:04:00.000Z" },
      }),
      "utf8",
    );
    expect(await processInbox({ state, inbox, outbox, archive })).toMatchObject({ exitCode: 0 });
    const goReport = await readFile(join(outbox, "remote-go.md"), "utf8");
    expect(goReport).toContain("# go");
    expect(goReport).toContain("승인할 오케스트레이터 계획이나 진행할 통합 gate가 없습니다.");
    expect(goReport).not.toContain("decision-required");
    expect(goReport).not.toContain("/approve");
    expect(goReport).not.toContain("오케스트레이터 계획이 생성되어 검토를 기다리고 있습니다.");
  });

  test("no-ops when no current pending decision exists", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    const stale = createDecisionItem({
      title: "Review plan: Stale approval",
      prompt: "Approve, revise, or cancel before dispatch.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-stale" },
      createdAt: "2026-05-07T11:00:00.000Z",
    });
    const resolved = {
      ...createDecisionItem({
        title: "Review plan: Already approved",
        prompt: "Approve, revise, or cancel before dispatch.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-resolved" },
        createdAt: "2026-05-07T11:01:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-07T11:02:00.000Z",
      resolvedBy: "bk" as const,
    };
    await writeFile(join(state, "decisions.jsonl"), [stale, resolved].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      [planRecord("plan-stale", "canceled"), planRecord("plan-resolved", "planned")].map((item) => JSON.stringify(item)).join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(inbox, "remote-approve.json"),
      JSON.stringify({ id: "remote-approve", type: "decisions:approve-latest", args: { source: "remote" } }),
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    const report = await readFile(join(outbox, "remote-approve.md"), "utf8");
    expect(report).toContain("승인할 현재 pending 계획 결정이 없습니다.");
    expect(report).not.toContain("decision-");
    const records = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; status: string; resolution?: string });
    expect(records).toEqual([
      expect.objectContaining({ id: stale.id, status: "pending" }),
      expect.objectContaining({ id: resolved.id, status: "resolved", resolution: "approved" }),
    ]);
  });

  test("go does not materialize an LLM plan from stale approval alone", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const agents = join(root, "agents");
    const projects = join(root, "projects");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(projects, { recursive: true });
    await writeFile(
      join(agents, "codex-worker.json"),
      JSON.stringify({
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
      }),
      "utf8",
    );
    await writeFile(
      join(projects, "samantha.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "samantha",
        repoRoot: "/repo/samantha-codex",
        setupCommands: [],
        verifyCommands: ["bun typecheck"],
        forbiddenChanges: ["state/**"],
      }),
      "utf8",
    );
    const staleApproval = {
      ...createDecisionItem({
        title: "Review plan: Stale approval",
        prompt: "Approve, revise, or cancel before dispatch.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-stale-approved" },
        createdAt: "2026-05-07T10:58:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-07T10:58:30.000Z",
      resolvedBy: "bk" as const,
    };
    await writeFile(join(state, "decisions.jsonl"), `${JSON.stringify(staleApproval)}\n`, "utf8");
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      [planRecord("plan-stale-approved", "materialized"), executablePlanRecord("plan-current")]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(inbox, "remote-go.json"),
      JSON.stringify({ id: "remote-go", type: "actions:go", args: { source: "remote", receivedAt: "2026-05-07T11:02:00.000Z" } }),
      "utf8",
    );

    expect(await processInbox({ state, inbox, outbox, archive, agentProfiles: agents, projectProfiles: projects, repoRoot: "/repo/samantha-codex" }))
      .toMatchObject({ exitCode: 0 });

    const report = await readFile(join(outbox, "remote-go.md"), "utf8");
    expect(report).toContain("# decision-required");
    expect(report).toContain("BK decision required before Samantha materializes worker tasks.");
    const records = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; resolution?: string; subject?: { id: string } });
    expect(records).toEqual([
      expect.objectContaining({ status: "resolved", resolution: "approved", subject: { type: "orchestrator_plan", id: "plan-stale-approved" } }),
      expect.objectContaining({ status: "pending", subject: { type: "orchestrator_plan", id: "plan-current" } }),
    ]);
    await expect(readFile(join(state, "tasks.jsonl"), "utf8")).rejects.toThrow();
    await expect(readFile(join(state, "remote-actions.jsonl"), "utf8")).rejects.toThrow();
  });

  test("recover no-ops without failed plan evidence", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    await writeFile(
      join(inbox, "remote-recover.json"),
      JSON.stringify({ id: "remote-recover", type: "orchestrator:recover-latest", args: { source: "remote", receivedAt: "2026-05-07T11:02:00.000Z" } }),
      "utf8",
    );

    expect(await processInbox({ state, inbox, outbox, archive })).toMatchObject({ exitCode: 0 });

    const report = await readFile(join(outbox, "remote-recover.md"), "utf8");
    expect(report).not.toContain("# recover");
    await expect(readFile(join(state, "orchestration-requests.jsonl"), "utf8")).rejects.toThrow();
  });

  test("answer does not resolve plan approval or orchestrator question decisions", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    const approval = createDecisionItem({
      title: "Review plan: Leave pending",
      prompt: "Approve, revise, or cancel before dispatch.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-approval" },
      createdAt: "2026-05-07T11:00:00.000Z",
    });
    const questions = createDecisionItem({
      title: "Answer plan questions: Leave pending",
      prompt: "Which path should Samantha plan?",
      kind: "orchestrator_questions",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-questions" },
      options: ["answer", "revise", "cancel"],
      createdAt: "2026-05-07T11:01:00.000Z",
    });
    await writeFile(join(state, "decisions.jsonl"), [approval, questions].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      [planRecord("plan-approval"), planRecord("plan-questions", "questions")].map((item) => JSON.stringify(item)).join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(inbox, "remote-answer.json"),
      JSON.stringify({
        id: "remote-answer",
        type: "decisions:answer-blocker-clarification",
        args: { source: "remote", receivedAt: "2026-05-07T11:03:00.000Z", note: "Keep going." },
      }),
      "utf8",
    );

    expect(await processInbox({ state, inbox, outbox, archive })).toMatchObject({ exitCode: 0 });

    const report = await readFile(join(outbox, "remote-answer.md"), "utf8");
    expect(report).toContain("답변할 현재 pending blocker clarification이 없습니다.");
    expect(report).not.toContain("decision-");
    const records = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; status: string; resolution?: string });
    expect(records).toEqual([
      expect.objectContaining({ id: approval.id, status: "pending" }),
      expect.objectContaining({ id: questions.id, status: "pending" }),
    ]);
    await expect(readFile(join(state, "tasks.jsonl"), "utf8")).rejects.toThrow();
    await expect(readFile(join(state, "remote-actions.jsonl"), "utf8")).rejects.toThrow();
  });

  test("answer redirects without mutation when multiple current blocker clarifications are pending", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    const blockers = ["A", "B"].map((title, index) =>
      createDecisionItem({
        title: `Clarify blocker ${title}`,
        prompt: "Should Samantha continue?",
        kind: "blocker_clarification",
        source: "system",
        subject: { type: "run", id: `run-${index}` },
        options: ["continue", "wait", "cancel"],
        risk: "Wrong answer can unblock the wrong work.",
        createdAt: `2026-05-07T11:0${index}:00.000Z`,
      }),
    );
    await writeFile(join(state, "decisions.jsonl"), blockers.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    await writeFile(
      join(inbox, "remote-answer.json"),
      JSON.stringify({
        id: "remote-answer",
        type: "decisions:answer-blocker-clarification",
        args: { source: "remote", receivedAt: "2026-05-07T11:03:00.000Z", note: "Continue." },
      }),
      "utf8",
    );

    expect(await processInbox({ state, inbox, outbox, archive })).toMatchObject({ exitCode: 0 });

    const report = await readFile(join(outbox, "remote-answer.md"), "utf8");
    expect(report).toContain("Telegram answer is only allowed when exactly one current blocker clarification is pending.");
    expect(report).toContain("CLI 또는 dashboard");
    expect(report).not.toContain("decision-");
    const records = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; status: string; resolution?: string });
    expect(records).toEqual([
      expect.objectContaining({ id: blockers[0]?.id, status: "pending" }),
      expect.objectContaining({ id: blockers[1]?.id, status: "pending" }),
    ]);
  });
});
