import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import type { DaemonHeartbeat } from "../src/lib/daemon";
import { renderDashboard, renderLaneViewDashboard, writeDashboard } from "../src/lib/dashboard";
import { createDecisionItem, DecisionStore } from "../src/lib/decision-store";
import { git, gitHead } from "../src/lib/git";
import { processInbox } from "../src/lib/inbox";
import type { RunSummary } from "../src/lib/ledger";
import { buildPlanBatches, type LoadedPlanTask } from "../src/lib/plan-runner";
import { OrchestrationRequestStore, OrchestratorPlanStore, type OrchestratorPlanPayload } from "../src/lib/orchestrator-store";
import { materializeOrchestratorPlan } from "../src/lib/orchestrator-materializer";
import { createRemoteDispatchAction, RemoteActionStore } from "../src/lib/remote-action-store";
import { commandFromRemoteInput, enqueueRemoteCommand } from "../src/lib/remote-command";
import type { WorkerRunLog } from "../src/lib/run-log";

let tmpRoots: string[] = [];

const writer: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: { requiredBundles: [], blockedSkills: [] },
};

const reviewer: AgentProfile = {
  ...writer,
  id: "codex-reviewer",
  role: "reviewer",
  writerClass: "non-writer",
  worktreePolicy: "none",
  mergePolicy: "none",
};

const orchestrator: AgentProfile = {
  ...reviewer,
  id: "codex-orchestrator",
  role: "spec",
};

const task: TaskSpec = {
  id: "fixture",
  title: "Fixture",
  targetAgent: "codex-worker",
  targetFiles: ["allowed.txt"],
  forbiddenChanges: ["state/**"],
  verifyCommands: [],
  instructions: "Fixture.",
  status: "pending",
};

async function writeFakeCodex(root: string, payload: OrchestratorPlanPayload): Promise<string> {
  const path = join(root, "fake-codex");
  await writeFile(
    path,
    [
      "#!/usr/bin/env bun",
      `const payload = ${JSON.stringify(payload)};`,
      'const text = "계획 생성 완료\\n\\nORCHESTRATOR_PLAN: " + JSON.stringify(payload);',
      'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

async function makeMergeCandidate(): Promise<{ repo: string; workerCommit: string; logPath: string; summary: RunSummary }> {
  const repo = await mkdtemp(join(tmpdir(), "samantha-codex-remote-merge-"));
  tmpRoots.push(repo);
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "samantha@example.local"], repo);
  await git(["config", "user.name", "Samantha Test"], repo);
  await writeFile(join(repo, "allowed.txt"), "base\n", "utf8");
  await git(["add", "allowed.txt"], repo);
  await git(["commit", "-m", "chore: initial"], repo);
  const baseCommit = await gitHead(repo);
  await git(["checkout", "-b", "samantha/remote-merge"], repo);
  await writeFile(join(repo, "allowed.txt"), "changed\n", "utf8");
  await git(["add", "allowed.txt"], repo);
  await git(["commit", "-m", "feat: worker change"], repo);
  const workerCommit = await gitHead(repo);
  await git(["checkout", "main"], repo);

  const log: WorkerRunLog = {
    schemaVersion: 1,
    runId: "run-remote-merge",
    startedAt: "2026-05-05T10:00:00.000Z",
    finishedAt: "2026-05-05T10:01:00.000Z",
    task: {
      ...task,
      id: "remote-merge-fixture",
      title: "Remote merge fixture",
      verifyCommands: ["grep -q changed allowed.txt"],
    },
    agent: writer,
    input: { repoRoot: repo, allocate: true, execute: true },
    result: {
      preparation: {
        taskId: "remote-merge-fixture",
        agentId: "codex-worker",
        worktreePath: join(repo, "worktrees/remote-merge-fixture"),
        allocation: {
          taskId: "remote-merge-fixture",
          repoRoot: repo,
          worktreePath: join(repo, "worktrees/remote-merge-fixture"),
          branch: "samantha/remote-merge",
          baseCommit,
        },
        codex: { prompt: "prompt", command: ["codex", "exec"] },
      },
      setupResults: [],
      command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
      evaluation: {
        pass: true,
        harness: { status: "pass", note: "ok", commit: "" },
        changedFiles: ["allowed.txt"],
        scopeViolations: [],
        verifyResults: [],
      },
      commit: {
        subject: "feat: worker change",
        files: ["allowed.txt"],
        add: { command: ["git", "add", "--", "allowed.txt"], exitCode: 0, stdout: "", stderr: "" },
        commit: { command: ["git", "commit", "-m", "feat: worker change"], exitCode: 0, stdout: "", stderr: "" },
        commitHash: workerCommit,
      },
      pass: true,
    },
  };
  const logRoot = await mkdtemp(join(tmpdir(), "samantha-codex-remote-merge-log-"));
  tmpRoots.push(logRoot);
  const logPath = join(logRoot, "run.json");
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return {
    repo,
    workerCommit,
    logPath,
    summary: {
      schemaVersion: 1,
      runId: log.runId,
      taskId: log.task.id,
      taskTitle: log.task.title,
      agentId: log.agent.id,
      repoRoot: repo,
      worktreePath: join(repo, "worktrees/remote-merge-fixture"),
      logPath,
      startedAt: log.startedAt,
      finishedAt: log.finishedAt,
      outcome: "pass",
      pass: true,
      commit: workerCommit,
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("plan batches", () => {
  test("runs ready non-writers in parallel before serialized writers", () => {
    const tasks: LoadedPlanTask[] = [
      { ref: { id: "review-a", task: "a.json", agent: "reviewer.json", repoRoot: "." }, task, agent: reviewer },
      { ref: { id: "review-b", task: "b.json", agent: "reviewer.json", repoRoot: "." }, task, agent: reviewer },
      { ref: { id: "write", task: "w.json", agent: "writer.json", repoRoot: ".", dependsOn: ["review-a"] }, task, agent: writer },
    ];

    expect(buildPlanBatches(tasks)).toEqual([["review-a", "review-b"], ["write"]]);
  });

  test("serializes ready writers under writer cap one", () => {
    const tasks: LoadedPlanTask[] = [
      { ref: { id: "write-a", task: "a.json", agent: "writer.json", repoRoot: "." }, task, agent: writer },
      { ref: { id: "write-b", task: "b.json", agent: "writer.json", repoRoot: "." }, task, agent: writer },
      { ref: { id: "review", task: "r.json", agent: "reviewer.json", repoRoot: "." }, task, agent: reviewer },
    ];

    expect(buildPlanBatches(tasks)).toEqual([["review"], ["write-a"], ["write-b"]]);
  });
});

describe("inbox and remote commands", () => {
  test("processes local inbox commands into outbox reports and archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-inbox-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, "001.json"), JSON.stringify({ type: "runs:list" }), "utf8");

    const result = await processInbox({
      inboxDir: inbox,
      outboxDir: outbox,
      archiveDir: archive,
      handle: async (command) => `handled ${command.type}`,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.ok).toBe(true);
    expect(await readFile(join(outbox, "001.md"), "utf8")).toBe("handled runs:list\n");
    expect(await readFile(join(archive, "001.json"), "utf8")).toContain("runs:list");
  });

  test("archives failed inbox commands with an outbox report", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-inbox-fail-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, "bad.json"), "{", "utf8");

    const result = await processInbox({
      inboxDir: inbox,
      outboxDir: outbox,
      archiveDir: archive,
      handle: async () => "unreachable",
    });

    expect(result[0]?.ok).toBe(false);
    expect(await readFile(join(outbox, "bad.md"), "utf8")).toContain("inbox command failed");
    expect(await readFile(join(archive, "bad.json"), "utf8")).toBe("{");
  });

  test("normalizes allowed remote commands into inbox commands", async () => {
    const deprecated = commandFromRemoteInput(
      { senderId: "bk", text: "/task fixture", receivedAt: "2026-05-03T10:00:00.000Z" },
      "bk",
    );

    expect(deprecated).toMatchObject({
      type: "remote:deprecated",
      args: { command: "/task", replacement: "/now" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/help" }, "bk").type).toBe("remote:help");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/help_advanced" }, "bk")).toMatchObject({
      type: "remote:deprecated",
      args: { command: "/help_advanced", replacement: "/help" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/help advanced" }, "bk")).toMatchObject({
      type: "remote:deprecated",
      args: { command: "/help advanced", replacement: "/help" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/now" }, "bk").type).toBe("ops:now");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/plan_current" }, "bk").type).toBe("orchestrator:show-current-plan");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/plan" }, "bk").type).toBe("orchestrator:plan-latest");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/plan omht planning_report" }, "bk")).toMatchObject({
      type: "orchestrator:plan-latest",
      args: {
        projectId: "omht",
        scopeId: "planning_report",
      },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/go" }, "bk").type).toBe("actions:go");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/approve" }, "bk").type).toBe("decisions:approve-latest");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/answer 계속 진행" }, "bk")).toMatchObject({
      type: "decisions:answer-blocker-clarification",
      args: { note: "계속 진행" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/recover" }, "bk")).toMatchObject({
      type: "orchestrator:recover-latest",
      args: { senderId: "bk" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/revise 구현 범위를 줄여줘" }, "bk")).toMatchObject({
      type: "orchestrator:revise-latest",
      args: {
        feedback: "구현 범위를 줄여줘",
        senderId: "bk",
      },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/cancel stale plan" }, "bk")).toMatchObject({
      type: "orchestrator:cancel-current",
      args: { reason: "stale plan" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/check" }, "bk").type).toBe("status:show");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/problems" }, "bk").type).toBe("ops:doctor");
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/work Improve task flow", receivedAt: "2026-05-03T10:06:00.000Z" },
        "bk",
      ),
    ).toMatchObject({
      type: "orchestrator:add-request",
      args: {
        requestId: expect.stringMatching(/^request-20260503-100600-work-[0-9a-f]{8}$/),
        text: "Improve task flow",
        senderId: "bk",
      },
    });

    for (const [text, replacement] of [
      ["/status", "/check"],
      ["/doctor", "/problems"],
      ["/health", "/problems"],
      ["/dashboard", "/check"],
      ["/run_latest", "/now"],
      ["/run run-1", "/now"],
      ["/failures", "/problems"],
      ["/proposal_next", "/now"],
      ["/accept proposal-1", "/approve"],
      ["/reject proposal-1", "/cancel"],
      ["/draft_next", "/now"],
      ["/draft-prepare omht", "/plan"],
      ["/draft_approve", "/go"],
      ["/draft-propose Improve task flow", "/work <요청>"],
      ["/draft proposal-1", "/work <요청>"],
      ["/next_action", "/now"],
      ["/next-action", "/now"],
      ["/actions", "/now"],
      ["/run_next", "/go"],
      ["/run-next", "/go"],
      ["/yes", "/approve"],
      ["/action action-1", "/now"],
      ["/action_current", "/now"],
      ["/prepare_dispatch task-pass", "/go"],
      ["/prepare-dispatch task-pass", "/go"],
      ["/approve_action action-1", "/go"],
      ["/approve-action action-1", "/go"],
      ["/propose Improve status reports", "/work <요청>"],
    ] as const) {
      expect(commandFromRemoteInput({ senderId: "bk", text }, "bk")).toMatchObject({
        type: "remote:deprecated",
        args: { replacement },
      });
    }
    expect(() => commandFromRemoteInput({ senderId: "other", text: "/runs" }, "bk")).toThrow("not allowed");

    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-"));
    tmpRoots.push(root);
    const inputPath = join(root, "remote.json");
    await writeFile(inputPath, JSON.stringify({ senderId: "bk", text: "/runs" }), "utf8");
    const enqueued = await enqueueRemoteCommand({ inputPath, inboxDir: join(root, "inbox"), allowedSenderId: "bk" });

    expect(enqueued.command.type).toBe("remote:deprecated");
    expect(await readFile(enqueued.path, "utf8")).toContain("remote:deprecated");
  });

  test("processes remote dispatch preparation into a pending action without executing", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-action-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const agents = join(root, "agents");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(state, "tasks.jsonl"), `${JSON.stringify({ ...task, id: "task-pass" })}\n`, "utf8");
    await writeFile(
      join(inbox, "001.json"),
      JSON.stringify({
        id: "remote-prepare",
        type: "actions:prepare-dispatch",
        args: { taskId: "task-pass", receivedAt: "2026-05-03T10:07:00.000Z" },
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
        `--agent-profiles-dir=${agents}`,
        "--repo-root=/repo",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const report = await readFile(join(outbox, "001.md"), "utf8");
    const actions = await new RemoteActionStore(join(state, "remote-actions.jsonl")).list();
    expect(report).toContain("아직 worker는 실행하지 않았습니다.");
    expect(report).not.toContain("/approve_action");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "dispatch_task",
      status: "pending",
      taskId: "task-pass",
      repoRoot: "/repo",
      allocate: true,
      execute: true,
      tmux: true,
    });
  });

  test("processes run-next into a pending action for the first pending task", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-run-next-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const agents = join(root, "agents");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(state, "tasks.jsonl"), `${JSON.stringify({ ...task, id: "task-pass" })}\n`, "utf8");
    await writeFile(
      join(inbox, "001.json"),
      JSON.stringify({
        id: "remote-run-next",
        type: "actions:run-next",
        args: { receivedAt: "2026-05-03T10:07:00.000Z" },
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
        `--agent-profiles-dir=${agents}`,
        "--repo-root=/repo",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const report = await readFile(join(outbox, "001.md"), "utf8");
    const actions = await new RemoteActionStore(join(state, "remote-actions.jsonl")).list();
    expect(report).toContain("텔레그램: `/go`");
    expect(actions[0]).toMatchObject({
      status: "pending",
      taskId: "task-pass",
    });
  });

  test("approves remote dispatch actions without running workers in inbox processing", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-approve-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    const store = new RemoteActionStore(join(state, "remote-actions.jsonl"));
    const action = createRemoteDispatchAction({
      task: { ...task, id: "task-pass" },
      repoRoot: "/repo",
      createdAt: "2026-05-03T10:07:00.000Z",
      source: "remote",
      commandId: "remote-prepare",
    });
    await store.append(action);
    await writeFile(
      join(inbox, "001.json"),
      JSON.stringify({
        id: "remote-approve",
        type: "actions:approve",
        args: { id: action.id, receivedAt: "2026-05-03T10:08:00.000Z" },
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
    const report = await readFile(join(outbox, "001.md"), "utf8");
    const approved = await store.find(action.id);
    expect(report).toContain("상태: `approved`");
    expect(report).toContain("actions:watch");
    expect(approved).toMatchObject({
      status: "approved",
      approvedAt: "2026-05-03T10:08:00.000Z",
    });
  });

  test("approves the latest pending action with yes", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-yes-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    const store = new RemoteActionStore(join(state, "remote-actions.jsonl"));
    const action = createRemoteDispatchAction({
      task: { ...task, id: "task-pass" },
      repoRoot: "/repo",
      createdAt: "2026-05-03T10:07:00.000Z",
      source: "remote",
      commandId: "remote-prepare",
    });
    await store.append(action);
    await writeFile(
      join(inbox, "001.json"),
      JSON.stringify({
        id: "remote-yes",
        type: "actions:approve-latest",
        args: { receivedAt: "2026-05-03T10:08:00.000Z" },
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
    expect(await readFile(join(outbox, "001.md"), "utf8")).toContain("상태: `approved`");
    expect(await store.find(action.id)).toMatchObject({ status: "approved" });
  });

  test("surfaces a work-created orchestration request in now instead of reporting no action", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-work-now-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "daemon.lock"),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        command: "inbox:watch",
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await writeFile(
      join(state, "heartbeat.json"),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        command: "inbox:watch",
        status: "running",
        lockPath: join(state, "daemon.lock"),
        inboxDir: inbox,
        outboxDir: outbox,
        archiveDir: archive,
        processedTotal: 0,
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await writeFile(join(state, "telegram-offset.json"), JSON.stringify({ nextOffset: 1 }), "utf8");
    await writeFile(
      join(state, "telegram-replies.json"),
      JSON.stringify({
        schemaVersion: 1,
        sentFiles: [],
        failures: [],
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "001-work.json"),
      JSON.stringify({
        id: "remote-work",
        type: "orchestrator:add-request",
        args: {
          requestId: "request-work-now",
          text: "Improve Telegram now flow",
          senderId: "bk",
          receivedAt: "2026-05-05T10:40:00.000Z",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "002-now.json"),
      JSON.stringify({
        id: "remote-now",
        type: "ops:now",
        args: { receivedAt: "2026-05-05T10:41:00.000Z" },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "003-go.json"),
      JSON.stringify({
        id: "remote-go",
        type: "actions:go",
        args: { receivedAt: "2026-05-05T10:42:00.000Z" },
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
    const workReport = await readFile(join(outbox, "001-work.md"), "utf8");
    expect(workReport).toContain("저장된 요청: `request-work-now`");
    expect(workReport).toContain("텔레그램: `/plan`");
    const report = await readFile(join(outbox, "002-now.md"), "utf8");
    expect(report).toContain("작업 요청이 오케스트레이터 계획 생성을 기다리고 있습니다.");
    expect(report).toContain("텔레그램: `/plan`");
    expect(report).not.toContain("지금 바로 필요한 원격 액션은 없습니다.");
    const goReport = await readFile(join(outbox, "003-go.md"), "utf8");
    expect(goReport).toContain("작업 요청이 오케스트레이터 계획 생성을 기다리고 있습니다.");
    expect(await new OrchestrationRequestStore(join(state, "orchestration-requests.jsonl")).latestPending()).toMatchObject({
      id: "request-work-now",
      status: "pending_plan",
    });
  });

  test("remote go does not approve or create worker actions from stale task/action/draft state", async () => {
    async function runGoFixture(name: string, seed: (input: { state: string; agents: string }) => Promise<void>) {
      const root = await mkdtemp(join(tmpdir(), name));
      tmpRoots.push(root);
      const inbox = join(root, "inbox");
      const outbox = join(root, "outbox");
      const archive = join(root, "archive");
      const state = join(root, "state");
      const agents = join(root, "agents");
      await mkdir(inbox, { recursive: true });
      await mkdir(state, { recursive: true });
      await mkdir(agents, { recursive: true });
      await writeFile(
        join(agents, "codex-worker.json"),
        `${JSON.stringify(
          {
            ...writer,
            skillPolicy: {
              requiredBundles: [],
              blockedSkills: [
                "using-git-worktrees",
                "dispatching-parallel-agents",
                "subagent-driven-development",
              ],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await seed({ state, agents });
      await writeFile(
        join(inbox, "001-go.json"),
        JSON.stringify({
          id: "remote-go-stale",
          type: "actions:go",
          args: { receivedAt: "2026-05-05T10:42:00.000Z" },
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
          `--agent-profiles-dir=${agents}`,
          "--repo-root=/repo",
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      expect({
        stdout: await new Response(proc.stdout).text(),
        stderr: await new Response(proc.stderr).text(),
        exitCode: await proc.exited,
      }).toMatchObject({ exitCode: 0 });

      return { state, outbox };
    }

    const pendingAction = createRemoteDispatchAction({
      task: { ...task, id: "stale-action-task", verifyCommands: ["test -f allowed.txt"] },
      repoRoot: "/repo",
      createdAt: "2026-05-05T10:00:00.000Z",
      source: "remote",
      commandId: "remote-old-prepare",
    });
    const actionFixture = await runGoFixture("samantha-codex-stale-go-action-", async ({ state }) => {
      await writeFile(join(state, "remote-actions.jsonl"), `${JSON.stringify(pendingAction)}\n`, "utf8");
    });
    expect(await readFile(join(actionFixture.outbox, "001-go.md"), "utf8")).toContain("통합 gate가 없습니다.");
    expect(await new RemoteActionStore(join(actionFixture.state, "remote-actions.jsonl")).find(pendingAction.id)).toMatchObject({
      status: "pending",
    });

    const taskFixture = await runGoFixture("samantha-codex-stale-go-task-", async ({ state }) => {
      await writeFile(
        join(state, "tasks.jsonl"),
        `${JSON.stringify({ ...task, id: "stale-pending-task", verifyCommands: ["test -f allowed.txt"] })}\n`,
        "utf8",
      );
    });
    expect(await new RemoteActionStore(join(taskFixture.state, "remote-actions.jsonl")).list()).toEqual([]);
    expect(await readFile(join(taskFixture.outbox, "001-go.md"), "utf8")).not.toContain("실행을 승인했습니다.");

    const draftFixture = await runGoFixture("samantha-codex-stale-go-draft-", async ({ state }) => {
      await writeFile(
        join(state, "task-drafts.jsonl"),
        `${JSON.stringify({
          schemaVersion: 1,
          id: "stale-draft",
          sourceProposalId: "proposal-stale",
          status: "drafted",
          title: "Stale draft",
          targetAgent: "codex-worker",
          targetFiles: ["allowed.txt"],
          forbiddenChanges: ["state/**"],
          verifyCommands: ["test -f allowed.txt"],
          instructions: "This draft has no actionable orchestrator plan.",
          createdAt: "2026-05-05T10:00:00.000Z",
        })}\n`,
        "utf8",
      );
    });
    await expect(readFile(join(draftFixture.state, "tasks.jsonl"), "utf8")).rejects.toThrow();
    expect(await new RemoteActionStore(join(draftFixture.state, "remote-actions.jsonl")).list()).toEqual([]);
    expect(await readFile(join(draftFixture.outbox, "001-go.md"), "utf8")).toContain("pending task/action/draft");
  });

  test("prepares and approves the latest draft from remote commands without dispatching a worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-draft-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const agents = join(root, "agents");
    const projects = join(root, "projects");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(projects, { recursive: true });
    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(projects, "omht.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "omht",
          repoRoot: "/repo",
          setupCommands: ["bun install"],
          verifyCommands: ["bun typecheck"],
          forbiddenChanges: ["state/**"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-work.json"),
      JSON.stringify({
        id: "remote-work",
        type: "drafts:add-from-proposal-text",
        args: {
          proposalId: "proposal-remote-draft",
          text: "Improve Telegram draft promotion",
          senderId: "bk",
          receivedAt: "2026-05-05T10:40:00.000Z",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "002-prepare.json"),
      JSON.stringify({
        id: "remote-draft-prepare",
        type: "drafts:prepare-latest",
        args: {
          projectId: "omht",
          targetFiles: ["src/lib/operator-reports.ts", "tests/operator-reports.test.ts"],
          receivedAt: "2026-05-05T10:41:00.000Z",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "003-approve.json"),
      JSON.stringify({
        id: "remote-draft-approve",
        type: "drafts:approve-latest",
        args: { receivedAt: "2026-05-05T10:42:00.000Z" },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "004-run-next.json"),
      JSON.stringify({
        id: "remote-run-next",
        type: "actions:run-next",
        args: { receivedAt: "2026-05-05T10:43:00.000Z" },
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
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(outbox, "002-prepare.md"), "utf8")).toContain("준비 상태: 가능");
    expect(await readFile(join(outbox, "002-prepare.md"), "utf8")).toContain("텔레그램: `/go`");
    const approveReport = await readFile(join(outbox, "003-approve.md"), "utf8");
    expect(approveReport).toContain("생성된 task: `task-remote-draft`");
    expect(approveReport).toContain("아직 worker는 실행하지 않았습니다.");
    expect(approveReport).toContain("텔레그램: `/go`");
    const actionReport = await readFile(join(outbox, "004-run-next.md"), "utf8");
    expect(actionReport).toContain("대상 repo: `repo`");
    expect(actionReport).toContain("--repo-root=/repo");

    const taskRecords = (await readFile(join(state, "tasks.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TaskSpec);
    expect(taskRecords).toMatchObject([
      {
        id: "task-remote-draft",
        projectId: "omht",
        repoRoot: "/repo",
        status: "pending",
        targetFiles: ["src/lib/operator-reports.ts", "tests/operator-reports.test.ts"],
        setupCommands: ["bun install"],
        verifyCommands: ["bun typecheck"],
        forbiddenChanges: ["state/**"],
      },
    ]);
    expect((await new RemoteActionStore(join(state, "remote-actions.jsonl")).list())[0]).toMatchObject({
      taskId: "task-remote-draft",
      repoRoot: "/repo",
    });
  });

  test("plans through the orchestrator and materializes tasks/actions on go", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-plan-go-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const agents = join(root, "agents");
    const projects = join(root, "projects");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(projects, { recursive: true });
    const fakeCodex = await writeFakeCodex(root, {
      summary: "텔레그램 작업 흐름을 계획합니다.",
      assumptions: ["기존 Telegram UX 테스트를 유지합니다."],
      questions: [],
      scope: ["operator report와 remote command 경로를 점검합니다."],
      nonScope: ["worker dispatch는 이번 단계에서 하지 않습니다."],
      risks: ["worker 검증 실패 시 후속 확인이 필요합니다."],
      tasks: [
        {
          id: "telegram-orchestration-plan",
          title: "Telegram orchestration planning flow",
          targetAgent: "codex-worker",
          projectId: "omht",
          resultMode: "write",
          targetFiles: ["src/lib/operator-reports.ts", "src/samantha.ts", "tests/operations.test.ts"],
          forbiddenChanges: ["state/**"],
          setupCommands: [],
          verifyCommands: ["bun test tests/operations.test.ts"],
          instructions: "Implement the Telegram orchestration planning flow.",
          dependencies: [],
        },
      ],
      batches: [["telegram-orchestration-plan"]],
      userMessage: "계획을 만들었습니다. `/go`로 실행 큐에 등록할 수 있습니다.",
    });
    await writeFile(
      join(agents, "codex-orchestrator.json"),
      `${JSON.stringify(orchestrator, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(projects, "omht.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "omht",
          repoRoot: "/repo/omht",
          setupCommands: ["bun install"],
          verifyCommands: ["bun typecheck"],
          forbiddenChanges: ["state/**"],
          defaultRemoteScopeId: "planning_report",
          remoteScopes: [
            {
              id: "planning_report",
              label: "Planning report",
              description: "Planning documents only.",
              risk: "low",
              resultMode: "report",
              targetFiles: ["docs/**"],
              keywords: ["보고", "계획"],
              planSteps: ["Read context.", "Write the report.", "Run verification."],
              successCriteria: ["Report is actionable.", "Verification passes."],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-work.json"),
      JSON.stringify({
        id: "remote-work",
        type: "orchestrator:add-request",
        args: {
          requestId: "request-remote-plan-go",
          text: "다음 작업 계획 보고",
          senderId: "bk",
          receivedAt: "2026-05-05T10:40:00.000Z",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "002-plan.json"),
      JSON.stringify({
        id: "remote-plan",
        type: "orchestrator:plan-latest",
        args: { receivedAt: "2026-05-05T10:41:00.000Z" },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "003-go.json"),
      JSON.stringify({
        id: "remote-go",
        type: "actions:go",
        args: { receivedAt: "2026-05-05T10:42:00.000Z" },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "004-approve.json"),
      JSON.stringify({
        id: "remote-approve",
        type: "decisions:approve-latest",
        args: { receivedAt: "2026-05-05T10:43:00.000Z" },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "005-go.json"),
      JSON.stringify({
        id: "remote-go-approved",
        type: "actions:go",
        args: { receivedAt: "2026-05-05T10:44:00.000Z" },
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
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
        `--codex-bin=${fakeCodex}`,
        `--orchestrator-repo-root=${root}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const planReport = await readFile(join(outbox, "002-plan.md"), "utf8");
    expect(planReport).toContain("# plan");
    expect(planReport).toContain("상태: `planned`");
    expect(planReport).toContain("계획을 만들었습니다.");
    expect(planReport).toContain("작업 후보:");
    expect(planReport).toContain("`telegram-orchestration-plan`");
    expect(planReport).toContain("계획 승인 및 worker 실행 큐 등록: `/go`");

    const gateReport = await readFile(join(outbox, "003-go.md"), "utf8");
    expect(gateReport).toContain("# decision-required");
    const approveReport = await readFile(join(outbox, "004-approve.md"), "utf8");
    expect(approveReport).toContain("# approve");
    const goReport = await readFile(join(outbox, "005-go.md"), "utf8");
    expect(goReport).toContain("# go");
    expect(goReport).toContain("오케스트레이터 계획을 승인했고 worker 실행 큐에 등록했습니다.");
    expect(goReport).toContain("`task-telegram-orchestration-plan`");
    expect(goReport).toContain("status=`approved`");
    const actions = await new RemoteActionStore(join(state, "remote-actions.jsonl")).list();
    expect(actions[0]).toMatchObject({
      status: "approved",
      taskId: "task-telegram-orchestration-plan",
      repoRoot: "/repo/omht",
    });
    const taskRecords = (await readFile(join(state, "tasks.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TaskSpec);
    expect(taskRecords[0]).toMatchObject({
      id: "task-telegram-orchestration-plan",
      projectId: "omht",
      repoRoot: "/repo/omht",
      status: "pending",
      verifyCommands: ["bun test tests/operations.test.ts"],
    });
    expect(await new OrchestrationRequestStore(join(state, "orchestration-requests.jsonl")).find("request-remote-plan-go")).toMatchObject({
      status: "planned",
    });
    expect((await new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl")).list())[0]).toMatchObject({
      requestId: "request-remote-plan-go",
      status: "materialized",
      taskIds: ["task-telegram-orchestration-plan"],
      payload: {
        tasks: [{ id: "telegram-orchestration-plan" }],
      },
    });
  });

  test("blocks plan materialization while current blocker clarification is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-blocker-gate-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const agents = join(root, "agents");
    const projects = join(root, "projects");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(projects, { recursive: true });
    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(projects, "omht.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "omht",
          repoRoot: "/repo/omht",
          setupCommands: [],
          verifyCommands: [],
          forbiddenChanges: ["state/**"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const payloadFor = (proposalId: string): OrchestratorPlanPayload => ({
      summary: `Clarification-gated plan ${proposalId}`,
      assumptions: [],
      questions: [],
      scope: ["safe implementation"],
      nonScope: [],
      risks: [],
      tasks: [
        {
          id: proposalId,
          title: `Implement ${proposalId}`,
          targetAgent: "codex-worker",
          projectId: "omht",
          repoRoot: "/repo/omht",
          resultMode: "write",
          targetFiles: ["src/safe.ts"],
          forbiddenChanges: ["state/**"],
          setupCommands: [],
          verifyCommands: ["bun test tests/operations.test.ts"],
          instructions: "Implement the approved selected path.",
          dependencies: [],
        },
      ],
      batches: [[proposalId]],
      userMessage: "Plan ready.",
    });
    const approved = {
      ...createDecisionItem({
        title: "Review clarification-gated plan",
        prompt: "Approve before materialization.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-blocker-gated" },
        options: ["approve", "revise", "cancel"],
        createdAt: "2026-05-06T10:00:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-06T10:01:00.000Z",
      resolvedBy: "bk" as const,
    };
    const blocker = createDecisionItem({
      title: "Clarify failed run recovery",
      prompt: "Should Samantha recover the failed run before materializing new work?",
      kind: "blocker_clarification",
      source: "system",
      subject: { type: "run", id: "run-failed-before-plan" },
      options: ["recover", "wait", "cancel"],
      risk: "Materializing before BK answers can dispatch the wrong work.",
      createdAt: "2026-05-06T10:02:00.000Z",
    });
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-blocker-gated",
        requestId: "request-blocker-gated",
        status: "planned",
        createdAt: "2026-05-06T10:00:00.000Z",
        payload: payloadFor("blocker-gated"),
      })}\n`,
      "utf8",
    );
    await writeFile(join(state, "decisions.jsonl"), `${JSON.stringify(approved)}\n${JSON.stringify(blocker)}\n`, "utf8");
    await writeFile(
      join(inbox, "001-go.json"),
      JSON.stringify({ id: "remote-go-blocked-by-clarification", type: "actions:go", args: { receivedAt: "2026-05-06T10:03:00.000Z" } }),
      "utf8",
    );
    await writeFile(
      join(inbox, "002-now.json"),
      JSON.stringify({ id: "remote-now-blocked-by-clarification", type: "ops:now", args: { receivedAt: "2026-05-06T10:04:00.000Z" } }),
      "utf8",
    );

    const blockedProcess = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect({
      stdout: await new Response(blockedProcess.stdout).text(),
      stderr: await new Response(blockedProcess.stderr).text(),
      exitCode: await blockedProcess.exited,
    }).toMatchObject({ exitCode: 0 });

    const blockedGo = await readFile(join(outbox, "001-go.md"), "utf8");
    expect(blockedGo).toContain("# decision-required");
    expect(blockedGo).toContain("BK clarification required before Samantha materializes worker tasks.");
    expect(blockedGo).toContain("답변: `/answer <답변>`");
    expect(blockedGo).not.toContain("/approve");
    const blockedNow = await readFile(join(outbox, "002-now.md"), "utf8");
    expect(blockedNow).toContain("BK 확인이 필요한 blocker clarification이 있습니다.");
    expect(blockedNow).toContain("답변: `/answer <답변>`");
    expect(blockedNow).not.toContain("계획 승인 및 worker 실행 큐 등록: `/go`");
    await expect(readFile(join(state, "tasks.jsonl"), "utf8")).rejects.toThrow();
    expect(await new RemoteActionStore(join(state, "remote-actions.jsonl")).list()).toEqual([]);
    expect(await new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl")).find("plan-blocker-gated")).toMatchObject({
      status: "planned",
    });

    await writeFile(
      join(inbox, "003-answer.json"),
      JSON.stringify({
        id: "remote-answer-blocker",
        type: "decisions:answer-blocker-clarification",
        args: {
          receivedAt: "2026-05-06T10:05:00.000Z",
          note: "Recover later; continue with this approved plan.",
        },
      }),
      "utf8",
    );

    const answerProcess = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect({
      stdout: await new Response(answerProcess.stdout).text(),
      stderr: await new Response(answerProcess.stderr).text(),
      exitCode: await answerProcess.exited,
    }).toMatchObject({ exitCode: 0 });

    const answerReport = await readFile(join(outbox, "003-answer.md"), "utf8");
    expect(answerReport).toContain("# answer");
    expect(answerReport).toContain("현재 계획은 변경하지 않았고 task/action도 만들지 않았습니다.");
    expect(answerReport).not.toContain(blocker.id);
    const decisionsAfterAnswer = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; status: string; resolution?: string; resolutionNote?: string });
    expect(decisionsAfterAnswer.find((decision) => decision.id === blocker.id)).toMatchObject({
      status: "resolved",
      resolution: "answered",
      resolutionNote: "Recover later; continue with this approved plan.",
    });
    await expect(readFile(join(state, "tasks.jsonl"), "utf8")).rejects.toThrow();
    expect(await new RemoteActionStore(join(state, "remote-actions.jsonl")).list()).toEqual([]);
    expect(await new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl")).find("plan-blocker-gated")).toMatchObject({
      status: "planned",
    });

    await writeFile(
      join(inbox, "004-go-after-answer.json"),
      JSON.stringify({ id: "remote-go-after-answer", type: "actions:go", args: { receivedAt: "2026-05-06T10:06:00.000Z" } }),
      "utf8",
    );

    const resolvedProcess = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect({
      stdout: await new Response(resolvedProcess.stdout).text(),
      stderr: await new Response(resolvedProcess.stderr).text(),
      exitCode: await resolvedProcess.exited,
    }).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(outbox, "004-go-after-answer.md"), "utf8")).toContain("오케스트레이터 계획을 승인했고 worker 실행 큐에 등록했습니다.");
    expect(await new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl")).find("plan-blocker-gated")).toMatchObject({
      status: "materialized",
    });

    const planStore = new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl"));
    await planStore.append({
      schemaVersion: 1,
      id: "plan-archived-blocker",
      requestId: "request-archived-blocker",
      status: "planned",
      createdAt: "2026-05-06T10:07:00.000Z",
      payload: payloadFor("archived-blocker"),
    });
    const decisionStore = new DecisionStore(join(state, "decisions.jsonl"));
    await decisionStore.append({
      ...createDecisionItem({
        title: "Review archived-blocker plan",
        prompt: "Approve before materialization.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: "plan-archived-blocker" },
        options: ["approve", "revise", "cancel"],
        createdAt: "2026-05-06T10:07:00.000Z",
      }),
      status: "resolved",
      resolution: "approved",
      resolvedAt: "2026-05-06T10:08:00.000Z",
      resolvedBy: "bk",
    });
    await decisionStore.append({
      ...createDecisionItem({
        title: "Archived blocker clarification",
        prompt: "This blocker is no longer active.",
        kind: "blocker_clarification",
        source: "system",
        subject: { type: "task", id: "task-old-blocker" },
        options: ["answer", "revise", "cancel"],
        risk: "None; archived.",
        createdAt: "2026-05-06T10:09:00.000Z",
      }),
      status: "archived",
      archivedAt: "2026-05-06T10:10:00.000Z",
      archiveReason: "No longer current.",
    });
    await writeFile(
      join(inbox, "004-go-after-archived-blocker.json"),
      JSON.stringify({ id: "remote-go-after-archived-blocker", type: "actions:go", args: { receivedAt: "2026-05-06T10:11:00.000Z" } }),
      "utf8",
    );

    const archivedProcess = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect({
      stdout: await new Response(archivedProcess.stdout).text(),
      stderr: await new Response(archivedProcess.stderr).text(),
      exitCode: await archivedProcess.exited,
    }).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(outbox, "004-go-after-archived-blocker.md"), "utf8")).toContain(
      "오케스트레이터 계획을 승인했고 worker 실행 큐에 등록했습니다.",
    );
    expect(await planStore.find("plan-archived-blocker")).toMatchObject({ status: "materialized" });
  });

  test("blocks unsafe orchestrator plan materialization before creating tasks or actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-plan-block-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const agents = join(root, "agents");
    const projects = join(root, "projects");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(projects, { recursive: true });
    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(projects, "omht.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "omht",
          repoRoot: "/repo/omht",
          setupCommands: [],
          verifyCommands: [],
          forbiddenChanges: ["state/**"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const invalidPayload: OrchestratorPlanPayload = {
      summary: "Unsafe plan",
      assumptions: [],
      questions: [],
      scope: ["unsafe write"],
      nonScope: [],
      risks: [],
      tasks: [
        {
          id: "unsafe-plan",
          title: "Unsafe plan",
          targetAgent: "codex-worker",
          projectId: "omht",
          repoRoot: "/repo/.samantha-worktrees/oh-my-health-trainer/task-unsafe-plan",
          resultMode: "write",
          targetFiles: ["state/secret.json"],
          forbiddenChanges: ["state/**"],
          setupCommands: [],
          verifyCommands: [],
          instructions: "Change forbidden state.",
          dependencies: ["missing-task"],
        },
      ],
      batches: [["missing-task"], ["unsafe-plan"]],
      userMessage: "Unsafe.",
    };
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-unsafe",
        requestId: "request-unsafe",
        status: "planned",
        createdAt: "2026-05-05T10:41:00.000Z",
        payload: invalidPayload,
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-go.json"),
      JSON.stringify({
        id: "remote-go",
        type: "actions:go",
        args: { receivedAt: "2026-05-05T10:42:00.000Z" },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "002-now.json"),
      JSON.stringify({
        id: "remote-now",
        type: "ops:now",
        args: { receivedAt: "2026-05-05T10:43:00.000Z" },
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
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const goReport = await readFile(join(outbox, "001-go.md"), "utf8");
    expect(goReport).toContain("오케스트레이터 계획을 실행 큐에 등록하지 못했습니다.");
    expect(goReport).toContain("verifyCommands must not be empty");
    expect(goReport).toContain("matches state/**");
    expect(goReport).toContain("dependency references unknown task proposal: missing-task");
    expect(goReport).toContain("repoRoot must not point to a Samantha worker worktree");
    expect(goReport).toContain("repoRoot must match project profile repoRoot for project omht");
    expect(goReport).toContain("계획 수정: `/revise <피드백>`");
    expect(goReport).not.toContain("# decision-required");
    expect(goReport).not.toContain("/approve");
    const now = await readFile(join(outbox, "002-now.md"), "utf8");
    expect(now).toContain("진행 차단:");
    expect(now).toContain("계획 수정: `/revise <피드백>`");
    expect(now).not.toContain("계획 승인 및 worker 실행 큐 등록: `/go`");
    const ceo = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "ceo:status",
        `--state-dir=${state}`,
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const ceoReport = await new Response(ceo.stdout).text();
    expect({
      stderr: await new Response(ceo.stderr).text(),
      exitCode: await ceo.exited,
    }).toMatchObject({ exitCode: 0 });
    expect(ceoReport).toContain("Telegram: /revise <피드백>");
    expect(ceoReport).not.toContain("Telegram: /go");
    await expect(readFile(join(state, "tasks.jsonl"), "utf8")).rejects.toThrow();
    await expect(readFile(join(state, "decisions.jsonl"), "utf8")).rejects.toThrow();
    expect(await new RemoteActionStore(join(state, "remote-actions.jsonl")).list()).toEqual([]);
  });

  test("materializes report-only writer tasks without target files", () => {
    const result = materializeOrchestratorPlan({
      plan: {
        schemaVersion: 1,
        id: "plan-report-only",
        requestId: "request-report-only",
        status: "planned",
        createdAt: "2026-05-06T01:00:00.000Z",
        payload: {
          summary: "감사 task를 실행합니다.",
          assumptions: [],
          questions: [],
          scope: ["read-only audit"],
          nonScope: [],
          risks: [],
          tasks: [
            {
              id: "read-only-audit",
              title: "Read-only audit",
              targetAgent: "codex-worker",
              projectId: "omht",
              repoRoot: "/repo/omht",
              resultMode: "report",
              targetFiles: [],
              forbiddenChanges: ["**/*"],
              setupCommands: [],
              verifyCommands: ["git status --short"],
              instructions: "Inspect files only and report the result.",
              dependencies: [],
            },
          ],
          batches: [["read-only-audit"]],
          userMessage: "감사 task를 만들었습니다.",
        },
      },
      agents: [
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
      ],
      projects: [
        {
          schemaVersion: 1,
          id: "omht",
          repoRoot: "/repo/omht",
          setupCommands: [],
          verifyCommands: ["bun typecheck"],
          forbiddenChanges: ["state/**"],
        },
      ],
      createdAt: "2026-05-06T01:01:00.000Z",
      commandId: "remote-go",
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.tasks[0]).toMatchObject({
      id: "task-read-only-audit",
      resultMode: "report",
      targetFiles: [],
      forbiddenChanges: ["**/*"],
    });
    expect(result.actions[0]).toMatchObject({
      taskId: "task-read-only-audit",
      repoRoot: "/repo/omht",
      status: "pending",
    });
  });

  test("materializes a role-aware reviewer to writer canary plan", () => {
    const blockedSkills = [
      "using-git-worktrees",
      "dispatching-parallel-agents",
      "subagent-driven-development",
    ];
    const result = materializeOrchestratorPlan({
      plan: {
        schemaVersion: 1,
        id: "plan-role-aware-canary",
        requestId: "request-role-aware-canary",
        status: "planned",
        createdAt: "2026-05-06T02:00:00.000Z",
        payload: {
          summary: "reviewer가 위험을 먼저 확인한 뒤 worker가 작은 변경을 수행합니다.",
          assumptions: [],
          questions: [],
          scope: ["reviewer report-only preflight", "single writer implementation"],
          nonScope: ["parallel writers", "post-write review of unmerged worker files"],
          risks: ["dependent worker tasks do not share unmerged worktree changes"],
          tasks: [
            {
              id: "review-risk",
              title: "Review implementation risk",
              targetAgent: "codex-reviewer",
              projectId: "samantha",
              resultMode: "report",
              repoRoot: "",
              targetFiles: [],
              forbiddenChanges: ["state/**"],
              setupCommands: [],
              verifyCommands: ["bun run typecheck"],
              instructions: "Inspect existing Samantha workflow risk. Do not edit files.",
              dependencies: [],
            },
            {
              id: "apply-small-change",
              title: "Apply small workflow change",
              targetAgent: "codex-worker",
              projectId: "samantha",
              resultMode: "write",
              repoRoot: "",
              targetFiles: ["src/**", "tests/**"],
              forbiddenChanges: ["state/**"],
              setupCommands: [],
              verifyCommands: ["bun run typecheck"],
              instructions: "Apply the smallest code change after considering the reviewer report.",
              dependencies: ["review-risk"],
            },
          ],
          batches: [["review-risk"], ["apply-small-change"]],
          userMessage: "역할을 나눠 안전하게 진행합니다.",
        },
      },
      agents: [
        { ...reviewer, skillPolicy: { requiredBundles: [], blockedSkills } },
        { ...writer, skillPolicy: { requiredBundles: [], blockedSkills } },
      ],
      projects: [
        {
          schemaVersion: 1,
          id: "samantha",
          repoRoot: "/repo/samantha-codex",
          setupCommands: [],
          verifyCommands: ["bun run typecheck"],
          forbiddenChanges: ["state/**"],
        },
      ],
      createdAt: "2026-05-06T02:01:00.000Z",
      commandId: "remote-go",
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.tasks.map((task) => [task.id, task.targetAgent, task.resultMode, task.repoRoot])).toEqual([
      ["task-review-risk", "codex-reviewer", "report", "/repo/samantha-codex"],
      ["task-apply-small-change", "codex-worker", "write", "/repo/samantha-codex"],
    ]);
    expect(result.actions.map((action) => [action.taskId, action.status, action.dependsOnActionIds?.length ?? 0])).toEqual([
      ["task-review-risk", "pending", 0],
      ["task-apply-small-change", "waiting", 1],
    ]);
  });

  test("materializes recovery plans from canonical project roots only", () => {
    const basePlan = {
      schemaVersion: 1 as const,
      id: "plan-recovery-canonical-root",
      requestId: "request-recovery-canonical-root",
      status: "planned" as const,
      createdAt: "2026-05-06T01:10:00.000Z",
      payload: {
        summary: "복구 계획",
        assumptions: [],
        questions: [],
        scope: ["failed plan recovery"],
        nonScope: [],
        risks: [],
        tasks: [
          {
            id: "recover-failed-plan",
            title: "Recover failed plan",
            targetAgent: "codex-worker",
            projectId: "omht",
            resultMode: "write" as const,
            targetFiles: ["src/recovery.ts"],
            forbiddenChanges: ["state/**"],
            setupCommands: [],
            verifyCommands: ["bun typecheck"],
            instructions: "Recover from the failed materialized plan.",
            dependencies: [],
          },
        ],
        batches: [["recover-failed-plan"]],
        userMessage: "복구 계획입니다.",
      },
    };
    const projects = [
      {
        schemaVersion: 1 as const,
        id: "omht",
        repoRoot: "/repo/omht",
        setupCommands: [],
        verifyCommands: ["bun typecheck"],
        forbiddenChanges: ["state/**"],
      },
    ];
    const agents = [
      {
        ...writer,
        skillPolicy: {
          requiredBundles: [],
          blockedSkills: [
            "using-git-worktrees",
            "dispatching-parallel-agents",
            "subagent-driven-development",
          ],
        },
      },
    ];

    const canonical = materializeOrchestratorPlan({
      plan: basePlan,
      agents,
      projects,
      createdAt: "2026-05-06T01:11:00.000Z",
      commandId: "remote-go-recovery",
    });

    expect(canonical.ok).toBe(true);
    expect(canonical.tasks[0]).toMatchObject({ repoRoot: "/repo/omht" });
    expect(canonical.actions[0]).toMatchObject({ repoRoot: "/repo/omht" });

    const workerWorktree = materializeOrchestratorPlan({
      plan: {
        ...basePlan,
        id: "plan-recovery-worker-root",
        payload: {
          ...basePlan.payload,
          tasks: [
            {
              ...basePlan.payload.tasks[0],
              repoRoot: "/repo/.samantha-worktrees/omht/task-failed-plan",
            },
          ],
        },
      },
      agents,
      projects,
      createdAt: "2026-05-06T01:12:00.000Z",
      commandId: "remote-go-recovery-worker-root",
    });

    expect(workerWorktree.ok).toBe(false);
    expect(workerWorktree.violations).toContain("task proposal recover-failed-plan: repoRoot must not point to a Samantha worker worktree");
    expect(workerWorktree.violations).toContain("task proposal recover-failed-plan: repoRoot must match project profile repoRoot for project omht");
  });

  test("revises the latest orchestrator plan into a new pending request", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-revise-plan-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });

    const planPayload: OrchestratorPlanPayload = {
      summary: "너무 넓은 구현 계획",
      assumptions: [],
      questions: [],
      scope: ["전체 구현"],
      nonScope: [],
      risks: ["범위가 큼"],
      tasks: [
        {
          id: "large-implementation",
          title: "Large implementation",
          targetAgent: "codex-worker",
          projectId: "samantha",
          repoRoot: "/repo/samantha",
          resultMode: "write",
          targetFiles: ["src/**"],
          forbiddenChanges: ["state/**"],
          setupCommands: [],
          verifyCommands: ["bun run typecheck"],
          instructions: "Implement everything.",
          dependencies: [],
        },
      ],
      batches: [["large-implementation"]],
      userMessage: "넓은 구현 계획입니다.",
    };
    await writeFile(
      join(state, "orchestration-requests.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "request-wide-plan",
        source: "remote",
        senderId: "bk",
        text: "사만다 원격 업무 시스템 개선",
        status: "planned",
        createdAt: "2026-05-06T13:00:00.000Z",
        plannedAt: "2026-05-06T13:01:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-wide",
        requestId: "request-wide-plan",
        status: "planned",
        createdAt: "2026-05-06T13:01:00.000Z",
        payload: planPayload,
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-revise.json"),
      JSON.stringify({
        id: "remote-revise",
        type: "orchestrator:revise-latest",
        args: {
          feedback: "범위가 너무 넓음. Telegram 계획 수정 루프만 먼저 구현해줘.",
          senderId: "bk",
          receivedAt: "2026-05-06T13:02:00.000Z",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "002-now.json"),
      JSON.stringify({ id: "remote-now-after-revise", type: "ops:now", args: { source: "remote" } }),
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
    const report = await readFile(join(outbox, "001-revise.md"), "utf8");
    expect(report).toContain("# revise");
    expect(report).toContain("현재 계획을 폐기하고 수정 요청을 만들었습니다.");
    expect(report).toContain("텔레그램: `/plan`");

    const requests = await new OrchestrationRequestStore(join(state, "orchestration-requests.jsonl")).list();
    expect(requests.at(-1)).toMatchObject({
      status: "pending_plan",
      text: expect.stringContaining("Telegram 계획 수정 루프만 먼저 구현해줘."),
    });
    expect(await new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl")).find("plan-wide")).toMatchObject({
      status: "superseded",
      supersededByRequestId: requests.at(-1)?.id,
    });
    expect(await readFile(join(outbox, "002-now.md"), "utf8")).toContain("텔레그램: `/plan`");
  });

  test("shows the current orchestrator plan without rerunning the orchestrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-plan-current-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });

    const planPayload: OrchestratorPlanPayload = {
      summary: "현재 계획 재조회",
      assumptions: [],
      questions: [],
      scope: ["현재 계획을 다시 보여준다."],
      nonScope: [],
      risks: [],
      tasks: [
        {
          id: "show-current-plan",
          title: "Show current plan",
          targetAgent: "codex-worker",
          projectId: "samantha",
          repoRoot: "",
          resultMode: "report",
          targetFiles: ["docs/**"],
          forbiddenChanges: ["state/**"],
          setupCommands: [],
          verifyCommands: ["bun run typecheck"],
          instructions: "Report only.",
          dependencies: [],
        },
      ],
      batches: [["show-current-plan"]],
      userMessage: "현재 계획 전문입니다.",
    };
    await writeFile(
      join(state, "orchestration-requests.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "request-plan-current",
        source: "remote",
        senderId: "bk",
        text: "현재 계획 다시 보여줘",
        status: "planned",
        createdAt: "2026-05-06T15:00:00.000Z",
        plannedAt: "2026-05-06T15:01:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-current",
        requestId: "request-plan-current",
        status: "planned",
        createdAt: "2026-05-06T15:01:00.000Z",
        payload: planPayload,
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-plan-current.json"),
      JSON.stringify({ id: "remote-plan-current", type: "orchestrator:show-current-plan", args: { source: "remote" } }),
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
    const report = await readFile(join(outbox, "001-plan-current.md"), "utf8");
    expect(report).toContain("# plan");
    expect(report).toContain("현재 계획 전문입니다.");
    expect(report).toContain("계획 다시 보기: `/plan_current`");
    expect((await new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl")).list())).toHaveLength(1);
  });

  test("cancels the current unapproved orchestrator plan before pending requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-cancel-plan-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });

    await writeFile(
      join(state, "orchestration-requests.jsonl"),
      [
        JSON.stringify({
          schemaVersion: 1,
          id: "request-planned",
          source: "remote",
          senderId: "bk",
          text: "계획 완료 요청",
          status: "planned",
          createdAt: "2026-05-06T14:00:00.000Z",
          plannedAt: "2026-05-06T14:01:00.000Z",
        }),
        JSON.stringify({
          schemaVersion: 1,
          id: "request-pending-after-plan",
          source: "remote",
          senderId: "bk",
          text: "대기 중 요청",
          status: "pending_plan",
          createdAt: "2026-05-06T14:02:00.000Z",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-cancel-me",
        requestId: "request-planned",
        status: "planned",
        createdAt: "2026-05-06T14:01:00.000Z",
        payload: {
          summary: "취소 대상 계획",
          assumptions: [],
          questions: [],
          scope: [],
          nonScope: [],
          risks: [],
          tasks: [],
          batches: [],
          userMessage: "취소 대상",
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-cancel.json"),
      JSON.stringify({
        id: "remote-cancel",
        type: "orchestrator:cancel-current",
        args: {
          reason: "stale",
          receivedAt: "2026-05-06T14:03:00.000Z",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "002-now.json"),
      JSON.stringify({ id: "remote-now-after-cancel", type: "ops:now", args: { source: "remote" } }),
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
    expect(await readFile(join(outbox, "001-cancel.md"), "utf8")).toContain("승인 전 계획을 취소했습니다.");
    expect(await new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl")).find("plan-cancel-me")).toMatchObject({
      status: "canceled",
      cancelReason: "stale",
    });
    expect(await new OrchestrationRequestStore(join(state, "orchestration-requests.jsonl")).find("request-pending-after-plan")).toMatchObject({
      status: "pending_plan",
    });
    expect(await readFile(join(outbox, "002-now.md"), "utf8")).toContain("요청: `request-pending-after-plan`");
  });

  test("creates a recovery orchestration request from the latest failed plan result", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-recover-plan-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    const logs = join(root, "runs");
    const worktree = join(root, "failed-worktree");
    await mkdir(join(worktree, "docs"), { recursive: true });
    await mkdir(logs, { recursive: true });
    await writeFile(join(worktree, "docs", "recovery-note.md"), "# 실패 산출\n\n타입체크 실패 분석입니다.", "utf8");
    const runLogPath = join(logs, "failed-plan.json");
    const failedRunLog: WorkerRunLog = {
      schemaVersion: 1,
      runId: "run-failed-plan",
      startedAt: "2026-05-06T10:12:00.000Z",
      finishedAt: "2026-05-06T10:20:00.000Z",
      task: {
        ...task,
        id: "task-failed-plan",
        title: "Failed plan task",
        targetFiles: ["docs/**"],
        verifyCommands: ["bun typecheck"],
        resultMode: "report",
      },
      agent: writer,
      input: { repoRoot: "/repo/samantha", allocate: true, execute: true },
      result: {
        preparation: {
          taskId: "task-failed-plan",
          agentId: "codex-worker",
          worktreePath: worktree,
          codex: { prompt: "prompt", command: ["codex", "exec"] },
        },
        setupResults: [],
        command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
        evaluation: {
          pass: false,
          harness: { status: "rework", note: "typecheck failed", commit: "" },
          changedFiles: ["docs/recovery-note.md"],
          scopeViolations: [],
          verifyResults: [{ command: "bun typecheck", exitCode: 1, stdout: "", stderr: "typecheck failed" }],
        },
        pass: false,
      },
    };
    await writeFile(runLogPath, `${JSON.stringify(failedRunLog, null, 2)}\n`, "utf8");

    const failedAction = {
      ...createRemoteDispatchAction({
        task: { ...task, id: "task-failed-plan", title: "Failed plan task" },
        repoRoot: "/repo/samantha",
        createdAt: "2026-05-06T10:10:00.000Z",
        source: "remote" as const,
        commandId: "remote-go-recover",
      }),
      status: "failed" as const,
      completedAt: "2026-05-06T10:20:00.000Z",
      result: {
        pass: false,
        outcome: "fail",
        failure: "typecheck failed",
        runLogPath,
      },
    };
    await writeFile(
      join(state, "orchestration-requests.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "request-failed-plan",
        source: "remote",
        senderId: "bk",
        text: "사만다 실패 복구 테스트",
        status: "planned",
        createdAt: "2026-05-06T10:00:00.000Z",
        plannedAt: "2026-05-06T10:05:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(join(state, "remote-actions.jsonl"), `${JSON.stringify(failedAction)}\n`, "utf8");
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-failed-result",
        requestId: "request-failed-plan",
        status: "materialized",
        createdAt: "2026-05-06T10:05:00.000Z",
        materializedAt: "2026-05-06T10:10:00.000Z",
        resultReportedAt: "2026-05-06T10:21:00.000Z",
        actionIds: [failedAction.id],
        taskIds: [failedAction.taskId],
        payload: { summary: "실패 복구 대상 계획" },
        synthesis: {
          outcome: "failed",
          summary: "typecheck 실패",
          nextActions: ["복구 계획 작성"],
          risks: [],
          userMessage: "worker 검증 실패를 복구해야 합니다.",
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-recover.json"),
      JSON.stringify({
        id: "remote-recover",
        type: "orchestrator:recover-latest",
        args: {
          senderId: "bk",
          receivedAt: "2026-05-06T10:22:00.000Z",
        },
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
    const report = await readFile(join(outbox, "001-recover.md"), "utf8");
    expect(report).toContain("# recover");
    expect(report).toContain("복구 계획 요청을 만들었습니다.");
    expect(report).toContain("복구 대상: 실패 복구 대상 계획");
    expect(report).toContain("텔레그램: `/plan`");
    const requests = await new OrchestrationRequestStore(join(state, "orchestration-requests.jsonl")).list();
    const latestRequest = requests.at(-1);
    const recoveryText = String(latestRequest?.text ?? "");
    expect(latestRequest?.id).toMatch(/^request-20260506-102200-recover-plan-failed-result-[0-9a-f]{8}$/);
    expect(latestRequest?.status).toBe("pending_plan");
    expect(recoveryText).toContain("무작정 retry하지 말고 복구 계획을 제안하세요.");
    expect(recoveryText).toContain("docs/recovery-note.md");
    expect(recoveryText).toContain(runLogPath);
    expect(recoveryText).toContain("# 실패 산출");
    expect(recoveryText).toContain("canonical repoRoot");
    expect(recoveryText).toContain("worker worktree path를 repoRoot로 복사하지 마세요.");
  });

  test("remote next action uses recoverable orchestrator plan context", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-next-recover-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });

    const failedAction = {
      ...createRemoteDispatchAction({
        task: { ...task, id: "task-failed-next-action", title: "Failed next action" },
        repoRoot: "/repo/samantha",
        createdAt: "2026-05-06T11:00:00.000Z",
        source: "remote" as const,
        commandId: "remote-go-next-recover",
      }),
      status: "failed" as const,
      completedAt: "2026-05-06T11:10:00.000Z",
      result: {
        pass: false,
        outcome: "blocked",
        failure: "worker blocked",
      },
    };
    await writeFile(join(state, "remote-actions.jsonl"), `${JSON.stringify(failedAction)}\n`, "utf8");
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-next-recover",
        requestId: "request-next-recover",
        status: "materialized",
        createdAt: "2026-05-06T11:00:00.000Z",
        materializedAt: "2026-05-06T11:01:00.000Z",
        resultReportedAt: "2026-05-06T11:11:00.000Z",
        actionIds: [failedAction.id],
        taskIds: [failedAction.taskId],
        synthesis: {
          outcome: "failed",
          summary: "worker blocked",
          nextActions: ["복구 계획 필요"],
          risks: [],
          userMessage: "복구가 필요합니다.",
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-next-action.json"),
      JSON.stringify({ id: "remote-next-action", type: "ops:next-action", args: { source: "remote" } }),
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
    expect({
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      exitCode: await proc.exited,
    }).toMatchObject({ exitCode: 0 });

    const report = await readFile(join(outbox, "001-next-action.md"), "utf8");
    expect(report).toContain("# now");
    expect(report).toContain("실패한 오케스트레이터 계획 결과가 있습니다.");
    expect(report).toContain("텔레그램: `/recover`");
    expect(report).not.toContain("tasks:retry");
  });

  test("runs dependent orchestrator actions only after prerequisite actions pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-dependent-actions-"));
    tmpRoots.push(root);
    const repo = join(root, "repo");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const agents = join(root, "agents");
    const projects = join(root, "projects");
    const logs = join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(projects, { recursive: true });

    await git(["init"], repo);
    await git(["config", "user.email", "samantha@example.com"], repo);
    await git(["config", "user.name", "Samantha Test"], repo);
    await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
    await git(["add", "README.md"], repo);
    await git(["commit", "-m", "initial"], repo);

    const fakeCodex = join(root, "fake-codex");
    const agentMessage = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "의존 작업 완료\n\nHARNESS_RESULT: {\"status\":\"pass\",\"note\":\"done\",\"commit\":\"\"}",
      },
    });
    await writeFile(fakeCodex, `#!/usr/bin/env bash\nprintf '%s\\n' '${agentMessage}'\n`, "utf8");
    await chmod(fakeCodex, 0o755);

    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(projects, "omht.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "omht",
          repoRoot: repo,
          setupCommands: [],
          verifyCommands: ["test -f README.md"],
          forbiddenChanges: ["state/**"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const planPayload: OrchestratorPlanPayload = {
      summary: "Dependent action plan",
      assumptions: [],
      questions: [],
      scope: ["run two dependent report tasks"],
      nonScope: [],
      risks: [],
      tasks: [
        {
          id: "prepare-context",
          title: "Prepare context",
          targetAgent: "codex-worker",
          projectId: "omht",
          repoRoot: repo,
          resultMode: "report",
          targetFiles: ["README.md"],
          forbiddenChanges: ["state/**"],
          setupCommands: [],
          verifyCommands: ["test -f README.md"],
          instructions: "Read context.",
          dependencies: [],
        },
        {
          id: "use-context",
          title: "Use context",
          targetAgent: "codex-worker",
          projectId: "omht",
          repoRoot: repo,
          resultMode: "report",
          targetFiles: ["README.md"],
          forbiddenChanges: ["state/**"],
          setupCommands: [],
          verifyCommands: ["test -f README.md"],
          instructions: "Use prepared context.",
          dependencies: ["prepare-context"],
        },
      ],
      batches: [["prepare-context"], ["use-context"]],
      userMessage: "의존 작업 계획입니다.",
    };
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-dependent",
        requestId: "request-dependent",
        status: "planned",
        createdAt: "2026-05-06T10:00:00.000Z",
        payload: planPayload,
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-go.json"),
      JSON.stringify({
        id: "remote-go-dependent",
        type: "actions:go",
        args: { receivedAt: "2026-05-06T10:01:00.000Z" },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "002-approve.json"),
      JSON.stringify({
        id: "remote-approve-dependent",
        type: "decisions:approve-latest",
        args: { receivedAt: "2026-05-06T10:02:00.000Z" },
      }),
      "utf8",
    );
    await writeFile(
      join(inbox, "003-go.json"),
      JSON.stringify({
        id: "remote-go-dependent-approved",
        type: "actions:go",
        args: { receivedAt: "2026-05-06T10:03:00.000Z" },
      }),
      "utf8",
    );

    const processGo = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect({
      stdout: await new Response(processGo.stdout).text(),
      stderr: await new Response(processGo.stderr).text(),
      exitCode: await processGo.exited,
    }).toMatchObject({ exitCode: 0 });

    let actions = await new RemoteActionStore(join(state, "remote-actions.jsonl")).list();
    expect(actions.map((action) => ({ taskId: action.taskId, status: action.status }))).toEqual([
      { taskId: "task-prepare-context", status: "approved" },
      { taskId: "task-use-context", status: "waiting" },
    ]);
    expect(actions[1]?.dependsOnActionIds).toEqual([actions[0]?.id]);

    for (let index = 0; index < 2; index += 1) {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "src/samantha.ts",
          "actions:run-pending",
          "--limit=1",
          `--state-dir=${state}`,
          `--outbox-dir=${outbox}`,
          `--agent-profiles-dir=${agents}`,
          `--log-dir=${logs}`,
          `--codex-bin=${fakeCodex}`,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      expect({
        stdout: await new Response(proc.stdout).text(),
        stderr: await new Response(proc.stderr).text(),
        exitCode: await proc.exited,
      }).toMatchObject({ exitCode: 0 });

      if (index === 0) {
        const midwayActions = await new RemoteActionStore(join(state, "remote-actions.jsonl")).list();
        expect(midwayActions.map((action) => action.status)).toEqual(["completed", "waiting"]);
        const midwayReports = await Promise.all((await readdir(outbox)).map((file) => readFile(join(outbox, file), "utf8")));
        expect(midwayReports.some((report) => report.includes("# plan-result"))).toBe(false);
      }
    }

    actions = await new RemoteActionStore(join(state, "remote-actions.jsonl")).list();
    expect(actions.map((action) => action.status)).toEqual(["completed", "completed"]);
    const reports = await Promise.all((await readdir(outbox)).map((file) => readFile(join(outbox, file), "utf8")));
    expect(reports.some((report) => report.includes("# plan-result"))).toBe(true);
  });

  test("marks waiting task failed when its prerequisite action fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-dependent-action-fail-"));
    tmpRoots.push(root);
    const state = join(root, "state");
    const outbox = join(root, "outbox");
    await mkdir(state, { recursive: true });

    const firstTask: TaskSpec = {
      ...task,
      id: "task-prerequisite-failed",
      title: "Prerequisite failed",
      status: "failed",
    };
    const secondTask: TaskSpec = {
      ...task,
      id: "task-dependent-waiting",
      title: "Dependent waiting",
      status: "pending",
    };
    const firstAction = {
      ...createRemoteDispatchAction({
        task: firstTask,
        repoRoot: "/repo",
        createdAt: "2026-05-06T10:00:00.000Z",
        source: "remote" as const,
        commandId: "remote-first",
      }),
      status: "failed" as const,
      completedAt: "2026-05-06T10:01:00.000Z",
      result: { pass: false, outcome: "rework", failure: "prerequisite failed" },
    };
    const secondAction = {
      ...createRemoteDispatchAction({
        task: secondTask,
        repoRoot: "/repo",
        createdAt: "2026-05-06T10:02:00.000Z",
        source: "remote" as const,
        commandId: "remote-second",
        dependsOnActionIds: [firstAction.id],
      }),
      status: "waiting" as const,
      dependsOnActionIds: [firstAction.id],
    };
    await writeFile(
      join(state, "tasks.jsonl"),
      `${JSON.stringify(firstTask)}\n${JSON.stringify(secondTask)}\n`,
      "utf8",
    );
    await writeFile(
      join(state, "remote-actions.jsonl"),
      `${JSON.stringify(firstAction)}\n${JSON.stringify(secondAction)}\n`,
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "actions:run-pending",
        "--limit=1",
        `--state-dir=${state}`,
        `--outbox-dir=${outbox}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect({
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      exitCode: await proc.exited,
    }).toMatchObject({ exitCode: 0 });

    const actions = await new RemoteActionStore(join(state, "remote-actions.jsonl")).list();
    expect(actions[1]).toMatchObject({
      status: "failed",
      result: {
        pass: false,
        outcome: "dependency_failed",
        failure: expect.stringContaining(firstAction.id),
      },
    });
    const taskRecords = (await readFile(join(state, "tasks.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TaskSpec);
    expect(taskRecords[1]).toMatchObject({
      id: "task-dependent-waiting",
      status: "failed",
    });

    const next = Bun.spawn(
      ["bun", "run", "src/samantha.ts", "next-action", `--state-dir=${state}`],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const nextOutput = await new Response(next.stdout).text();
    expect(await next.exited).toBe(0);
    expect(nextOutput).not.toContain("Pending task found.");
    expect(nextOutput).not.toContain("task-dependent-waiting --repo-root");
  });

  test("plans Samantha requests against the Samantha project profile instead of the OMHT fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-project-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const agents = join(root, "agents");
    const projects = join(root, "projects");
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(projects, { recursive: true });
    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify({ ...writer, skillPolicy: { requiredBundles: [], blockedSkills: [] } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(projects, "omht.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "omht",
          repoRoot: "/repo/omht",
          keywords: ["omht", "ohmt"],
          setupCommands: ["bun install"],
          verifyCommands: ["bun typecheck"],
          forbiddenChanges: ["state/**"],
          defaultRemoteScopeId: "planning_report",
          remoteScopes: [
            {
              id: "planning_report",
              label: "OMHT report",
              description: "OMHT docs.",
              risk: "low",
              resultMode: "report",
              targetFiles: ["omht-docs/**"],
              keywords: ["계획", "보고"],
              planSteps: ["Read OMHT docs."],
              successCriteria: ["Report is actionable."],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(projects, "samantha.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "samantha",
          repoRoot: "/repo/samantha",
          keywords: ["samantha", "samantha-codex", "사만다"],
          setupCommands: ["bun install"],
          verifyCommands: ["bun typecheck"],
          forbiddenChanges: ["state/**"],
          defaultRemoteScopeId: "planning_report",
          remoteScopes: [
            {
              id: "planning_report",
              label: "Samantha report",
              description: "Samantha docs.",
              risk: "low",
              resultMode: "report",
              targetFiles: ["samantha-docs/**"],
              keywords: ["계획", "보고"],
              planSteps: ["Read Samantha docs."],
              successCriteria: ["Report is actionable."],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(state, "task-drafts.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "draft-samantha-plan",
        sourceProposalId: "proposal-samantha-plan",
        status: "drafted",
        title: "samantha 프로젝트 대시보드 디자인 개선 계획 보고",
        targetAgent: "codex-worker",
        targetFiles: ["omht-docs/**"],
        forbiddenChanges: ["omht-state/**"],
        setupCommands: ["omht setup"],
        verifyCommands: ["omht verify"],
        instructions: "samantha 프로젝트 대시보드 디자인 개선 계획 보고",
        createdAt: "2026-05-05T13:28:23.000Z",
        projectId: "omht",
        repoRoot: "/repo/omht",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-plan.json"),
      JSON.stringify({
        id: "remote-plan",
        type: "drafts:plan-latest",
        args: { receivedAt: "2026-05-05T13:28:36.000Z" },
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
        `--agent-profiles-dir=${agents}`,
        `--project-profiles-dir=${projects}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const planReport = await readFile(join(outbox, "001-plan.md"), "utf8");
    expect(planReport).toContain("프로젝트: `samantha` (자동 선택)");
    expect(planReport).toContain("분류: 계획/보고 (`planning_report` - Samantha report)");
    expect(planReport).toContain("변경 허용 범위:");
    expect(planReport).toContain("`samantha-docs/**`");
    const draftRecords = (await readFile(join(state, "task-drafts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(draftRecords[0]).toMatchObject({
      projectId: "samantha",
      repoRoot: "/repo/samantha",
      targetFiles: ["samantha-docs/**"],
      forbiddenChanges: ["state/**"],
      setupCommands: ["bun install"],
      verifyCommands: ["bun typecheck"],
      resultMode: "report",
    });
  });

  test("writes a Telegram outbox result report when an approved remote action finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-result-"));
    tmpRoots.push(root);
    const repo = join(root, "repo");
    const state = join(root, "state");
    const outbox = join(root, "outbox");
    const agents = join(root, "agents");
    const logs = join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });

    await git(["init"], repo);
    await git(["config", "user.email", "samantha@example.com"], repo);
    await git(["config", "user.name", "Samantha Test"], repo);
    await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
    await git(["add", "README.md"], repo);
    await git(["commit", "-m", "initial"], repo);

    const fakeCodex = join(root, "fake-codex");
    const workerMessage = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "계획 보고 완료\n\n- 확인: README.md\n\nHARNESS_RESULT: {\"status\":\"pass\",\"note\":\"report done\",\"commit\":\"\"}",
      },
    });
    const synthesisMessage = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text:
          "최종 종합 완료\n\nORCHESTRATOR_SYNTHESIS: {\"outcome\":\"pass\",\"summary\":\"계획 완료\",\"nextActions\":[\"텔레그램: /now\"],\"risks\":[],\"userMessage\":\"오케스트레이터 최종 종합입니다.\"}",
      },
    });
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env bash",
        'args="$*"',
        'cwd=""',
        'while [[ $# -gt 0 ]]; do',
        '  if [[ "$1" == "--cd" ]]; then cwd="$2"; shift 2; else shift; fi',
        "done",
        'if [[ -n "$cwd" ]]; then cd "$cwd"; fi',
        `if [[ "$args" == *ORCHESTRATOR_SYNTHESIS* ]]; then printf '%s\\n' '${synthesisMessage}'; else`,
        "  mkdir -p docs",
        "  printf '# 원격 보고서\\n\\nTelegram에서 읽을 수 있어야 하는 산출물입니다.\\n' > docs/remote-report.md",
        `  printf '%s\\n' '${workerMessage}'`,
        "fi",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);

    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(agents, "codex-orchestrator.json"), `${JSON.stringify(orchestrator, null, 2)}\n`, "utf8");
    const remoteTask: TaskSpec = {
      ...task,
      id: "task-report-result",
      title: "Remote report result",
      targetFiles: ["docs/**"],
      forbiddenChanges: ["state/**"],
      verifyCommands: ["test -f README.md"],
      resultMode: "report",
      status: "pending",
    };
    await writeFile(join(state, "tasks.jsonl"), `${JSON.stringify(remoteTask)}\n`, "utf8");
    const store = new RemoteActionStore(join(state, "remote-actions.jsonl"));
    const action = createRemoteDispatchAction({
      task: remoteTask,
      repoRoot: repo,
      createdAt: "2026-05-05T10:45:00.000Z",
      source: "remote",
      commandId: "remote-go",
    });
    await store.append(action);
    await store.markApproved(action.id, "2026-05-05T10:46:00.000Z");
    await writeFile(
      join(state, "orchestrator-plans.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "plan-report-result",
        requestId: "request-report-result",
        status: "materialized",
        createdAt: "2026-05-05T10:44:00.000Z",
        materializedAt: "2026-05-05T10:46:00.000Z",
        taskIds: [remoteTask.id],
        actionIds: [action.id],
      })}\n`,
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "actions:run-pending",
        "--limit=1",
        `--state-dir=${state}`,
        `--outbox-dir=${outbox}`,
        `--agent-profiles-dir=${agents}`,
        `--log-dir=${logs}`,
        `--codex-bin=${fakeCodex}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    expect((await new RemoteActionStore(join(state, "remote-actions.jsonl")).list())[0]).toMatchObject({
      status: "completed",
      taskId: "task-report-result",
      result: { pass: true, outcome: "pass" },
    });
    const remoteReports = (await readdir(outbox)).filter((file) => file.startsWith("remote-") && file.endsWith(".md"));
    expect(remoteReports).toHaveLength(2);
    const reports = await Promise.all(remoteReports.map((file) => readFile(join(outbox, file), "utf8")));
    const report = reports.find((item) => item.includes("# execution-result")) ?? "";
    expect(report).toContain("# execution-result");
    expect(report).toContain("실행 결과: 통과");
    expect(report).toContain("계획 보고 완료");
    expect(report).not.toContain("HARNESS_RESULT");
    expect(report).toContain("`docs/remote-report.md`");
    expect(report).toContain("산출물 미리보기");
    expect(report).toContain("# 원격 보고서");
    expect(report).toContain("Telegram에서 읽을 수 있어야 하는 산출물입니다.");
    expect(report).toContain("텔레그램: `/now`");
    const planReport = reports.find((item) => item.includes("# plan-result")) ?? "";
    expect(planReport).toContain("계획 결과: 보고 완료");
    expect(planReport).toContain("오케스트레이터 종합:");
    expect(planReport).toContain("오케스트레이터 최종 종합입니다.");
    expect(planReport).toContain("완료 작업: 1/1");
    expect(planReport).toContain("계획 보고 완료");
    const reportedPlan = await new OrchestratorPlanStore(join(state, "orchestrator-plans.jsonl")).find("plan-report-result");
    expect(typeof reportedPlan?.resultReportedAt).toBe("string");
    expect(reportedPlan?.synthesis).toMatchObject({ outcome: "pass", summary: "계획 완료" });
  });

  test("includes report artifact previews even when verification is blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-blocked-report-result-"));
    tmpRoots.push(root);
    const repo = join(root, "repo");
    const state = join(root, "state");
    const outbox = join(root, "outbox");
    const agents = join(root, "agents");
    const logs = join(root, "runs");
    await mkdir(repo, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(agents, { recursive: true });

    await git(["init"], repo);
    await git(["config", "user.email", "samantha@example.com"], repo);
    await git(["config", "user.name", "Samantha Test"], repo);
    await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
    await git(["add", "README.md"], repo);
    await git(["commit", "-m", "initial"], repo);

    const fakeCodex = join(root, "fake-codex");
    const workerMessage = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text:
          "보고서는 작성됐지만 검증은 막혔습니다.\n\nHARNESS_RESULT: {\"status\":\"blocked\",\"note\":\"report written; verification unavailable\",\"commit\":\"\"}",
      },
    });
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env bash",
        'cwd=""',
        'while [[ $# -gt 0 ]]; do',
        '  if [[ "$1" == "--cd" ]]; then cwd="$2"; shift 2; else shift; fi',
        "done",
        'if [[ -n "$cwd" ]]; then cd "$cwd"; fi',
        "mkdir -p docs",
        "printf '# Blocked Report\\n\\n검증은 막혔지만 Telegram에서 읽어야 하는 산출물입니다.\\n' > docs/blocked-report.md",
        `printf '%s\\n' '${workerMessage}'`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);

    await writeFile(
      join(agents, "codex-worker.json"),
      `${JSON.stringify(
        {
          ...writer,
          skillPolicy: {
            requiredBundles: [],
            blockedSkills: [
              "using-git-worktrees",
              "dispatching-parallel-agents",
              "subagent-driven-development",
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const remoteTask: TaskSpec = {
      ...task,
      id: "task-blocked-report-result",
      title: "Blocked report result",
      targetFiles: ["docs/**"],
      forbiddenChanges: ["state/**"],
      verifyCommands: [],
      resultMode: "report",
      status: "pending",
    };
    await writeFile(join(state, "tasks.jsonl"), `${JSON.stringify(remoteTask)}\n`, "utf8");
    const store = new RemoteActionStore(join(state, "remote-actions.jsonl"));
    const action = createRemoteDispatchAction({
      task: remoteTask,
      repoRoot: repo,
      createdAt: "2026-05-05T10:55:00.000Z",
      source: "remote",
      commandId: "remote-go",
    });
    await store.append(action);
    await store.markApproved(action.id, "2026-05-05T10:56:00.000Z");

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "actions:run-pending",
        "--limit=1",
        `--state-dir=${state}`,
        `--outbox-dir=${outbox}`,
        `--agent-profiles-dir=${agents}`,
        `--log-dir=${logs}`,
        `--codex-bin=${fakeCodex}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    expect((await new RemoteActionStore(join(state, "remote-actions.jsonl")).list())[0]).toMatchObject({
      status: "failed",
      taskId: "task-blocked-report-result",
      result: { pass: false, outcome: "blocked" },
    });
    const remoteReports = (await readdir(outbox)).filter((file) => file.startsWith("remote-") && file.endsWith(".md"));
    expect(remoteReports).toHaveLength(1);
    const report = await readFile(join(outbox, remoteReports[0]), "utf8");
    expect(report).toContain("실행 결과: 실패");
    expect(report).toContain("산출물 미리보기");
    expect(report).toContain("파일: `docs/blocked-report.md`");
    expect(report).toContain("# Blocked Report");
    expect(report).toContain("검증은 막혔지만 Telegram에서 읽어야 하는 산출물입니다.");
  });

  test("go advances the latest unmerged passed run through the remote merge gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-integration-"));
    tmpRoots.push(root);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const { repo, workerCommit, summary } = await makeMergeCandidate();
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "runs.jsonl"),
      `${JSON.stringify(summary)}\n${JSON.stringify({
        ...summary,
        runId: "run-later-failed-verify",
        pass: false,
        outcome: "rework",
        commit: "",
        failureReason: "later verify failed",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(state, "task-drafts.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "draft-stale",
        sourceProposalId: "proposal-stale",
        status: "drafted",
        title: "Stale draft",
        targetAgent: "codex-worker",
        targetFiles: ["README.md"],
        forbiddenChanges: ["state/**"],
        verifyCommands: ["test -f README.md"],
        instructions: "This stale draft must not block integration closure.",
        createdAt: "2026-05-05T10:05:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-go.json"),
      JSON.stringify({
        id: "remote-go-integration",
        type: "actions:go",
        args: { receivedAt: "2026-05-05T10:10:00.000Z" },
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
    expect(await gitHead(repo)).toBe(workerCommit);
    const report = await readFile(join(outbox, "001-go.md"), "utf8");
    expect(report).toContain("# integration-result");
    expect(report).toContain("단계: merge 적용");
    expect(report).toContain("결과: 통과");
    expect(report).toContain("텔레그램: `/now`");
    const lifecycles = (await readFile(join(state, "run-lifecycle.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lifecycles[0]).toMatchObject({ runId: "run-remote-merge" });
    expect(typeof lifecycles[0]?.mergedAt).toBe("string");
  });

  test("go advances the latest merged run through the remote push gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-push-"));
    const remote = await mkdtemp(join(tmpdir(), "samantha-codex-remote-push-origin-"));
    tmpRoots.push(root, remote);
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const { repo, workerCommit, summary } = await makeMergeCandidate();
    await git(["init", "--bare"], remote);
    await git(["remote", "add", "origin", remote], repo);
    await git(["push", "origin", "main"], repo);
    await git(["merge", "--ff-only", workerCommit], repo);
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "runs.jsonl"), `${JSON.stringify(summary)}\n`, "utf8");
    await writeFile(
      join(state, "run-lifecycle.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        runId: summary.runId,
        taskId: summary.taskId,
        repoRoot: summary.repoRoot,
        runLogPath: summary.logPath,
        commit: summary.commit,
        mergedAt: "2026-05-05T10:09:00.000Z",
        updatedAt: "2026-05-05T10:09:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-go.json"),
      JSON.stringify({
        id: "remote-go-push",
        type: "actions:go",
        args: { receivedAt: "2026-05-05T10:10:00.000Z" },
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
    expect(await git(["rev-parse", "refs/heads/main"], remote)).toBe(workerCommit);
    const report = await readFile(join(outbox, "001-go.md"), "utf8");
    expect(report).toContain("단계: push");
    expect(report).toContain("결과: 통과");
    const lifecycles = (await readFile(join(state, "run-lifecycle.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(typeof lifecycles[0]?.pushedAt).toBe("string");
  });

  test("go advances the latest pushed run through the remote cleanup gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-cleanup-"));
    tmpRoots.push(root);
    const repo = join(root, "repo");
    const worktree = join(root, "worker-worktree");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    const state = join(root, "state");
    const logDir = join(root, "logs");
    await mkdir(repo, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "samantha@example.local"], repo);
    await git(["config", "user.name", "Samantha Test"], repo);
    await writeFile(join(repo, "allowed.txt"), "base\n", "utf8");
    await git(["add", "allowed.txt"], repo);
    await git(["commit", "-m", "chore: initial"], repo);
    const baseCommit = await gitHead(repo);
    await git(["worktree", "add", "-b", "samantha/remote-cleanup", worktree], repo);
    await writeFile(join(worktree, "allowed.txt"), "changed\n", "utf8");
    await git(["add", "allowed.txt"], worktree);
    await git(["commit", "-m", "feat: worker cleanup"], worktree);
    const workerCommit = await gitHead(worktree);
    await git(["merge", "--ff-only", workerCommit], repo);

    const log: WorkerRunLog = {
      schemaVersion: 1,
      runId: "run-remote-cleanup",
      startedAt: "2026-05-05T10:00:00.000Z",
      finishedAt: "2026-05-05T10:01:00.000Z",
      task: {
        ...task,
        id: "remote-cleanup-fixture",
        title: "Remote cleanup fixture",
        verifyCommands: [],
      },
      agent: writer,
      input: { repoRoot: repo, allocate: true, execute: true },
      result: {
        preparation: {
          taskId: "remote-cleanup-fixture",
          agentId: "codex-worker",
          worktreePath: worktree,
          allocation: {
            taskId: "remote-cleanup-fixture",
            repoRoot: repo,
            worktreePath: worktree,
            branch: "samantha/remote-cleanup",
            baseCommit,
          },
          codex: { prompt: "prompt", command: ["codex", "exec"] },
        },
        setupResults: [],
        command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
        evaluation: {
          pass: true,
          harness: { status: "pass", note: "ok", commit: "" },
          changedFiles: ["allowed.txt"],
          scopeViolations: [],
          verifyResults: [],
        },
        commit: {
          subject: "feat: worker cleanup",
          files: ["allowed.txt"],
          add: { command: ["git", "add", "--", "allowed.txt"], exitCode: 0, stdout: "", stderr: "" },
          commit: { command: ["git", "commit", "-m", "feat: worker cleanup"], exitCode: 0, stdout: "", stderr: "" },
          commitHash: workerCommit,
        },
        pass: true,
      },
    };
    const logPath = join(logDir, "run.json");
    const summary: RunSummary = {
      schemaVersion: 1,
      runId: log.runId,
      taskId: log.task.id,
      taskTitle: log.task.title,
      agentId: log.agent.id,
      repoRoot: repo,
      worktreePath: worktree,
      logPath,
      startedAt: log.startedAt,
      finishedAt: log.finishedAt,
      outcome: "pass",
      pass: true,
      commit: workerCommit,
    };
    await mkdir(inbox, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
    await writeFile(join(state, "runs.jsonl"), `${JSON.stringify(summary)}\n`, "utf8");
    await writeFile(
      join(state, "run-lifecycle.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        runId: summary.runId,
        taskId: summary.taskId,
        repoRoot: summary.repoRoot,
        runLogPath: summary.logPath,
        commit: summary.commit,
        mergedAt: "2026-05-05T10:08:00.000Z",
        pushedAt: "2026-05-05T10:09:00.000Z",
        updatedAt: "2026-05-05T10:09:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(inbox, "001-go.json"),
      JSON.stringify({
        id: "remote-go-cleanup",
        type: "actions:go",
        args: { receivedAt: "2026-05-05T10:10:00.000Z" },
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
    expect(await pathExists(worktree)).toBe(false);
    const report = await readFile(join(outbox, "001-go.md"), "utf8");
    expect(report).toContain("단계: worktree cleanup");
    expect(report).toContain("결과: 통과");
    const lifecycles = (await readFile(join(state, "run-lifecycle.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(typeof lifecycles[0]?.cleanedAt).toBe("string");
  });
});

describe("dashboard", () => {
  test("renders escaped run summaries", () => {
    const runs: RunSummary[] = [
      {
        schemaVersion: 1,
        runId: "run-1",
        taskId: "<task>",
        taskTitle: "Task",
        agentId: "codex-worker",
        repoRoot: "/repo",
        worktreePath: "/repo/worktrees/task",
        logPath: "/logs/run-1.json",
        startedAt: "2026-05-03T10:00:00.000Z",
        finishedAt: "2026-05-03T10:01:00.000Z",
        outcome: "pass",
        pass: true,
        commit: "abc123",
      },
    ];

    const heartbeat: DaemonHeartbeat = {
      schemaVersion: 1,
      pid: 123,
      command: "inbox:watch",
      status: "running",
      lockPath: "/state/daemon.lock",
      inboxDir: "/repo/inbox",
      outboxDir: "/repo/outbox",
      archiveDir: "/repo/archive",
      processedTotal: 2,
      updatedAt: "2026-05-03T10:02:00.000Z",
    };
    const html = renderDashboard(runs, {
      heartbeat,
      pendingInboxCount: 4,
      ops: {
        ok: true,
        checkedAt: "2026-05-03T10:03:00.000Z",
        env: {
          envFilePath: "/repo/.env",
          envFileExists: true,
          hasBotToken: true,
          hasPollChatId: true,
          hasReplyChatId: true,
          codexCommand: "codex",
          hasCodexExecutable: true,
        },
        health: { ok: true, heartbeat, ageMs: 1000, violations: [] },
        queues: {
          pendingInboxCount: 4,
          outboxCount: 2,
          remoteOutboxCount: 1,
          unsentRemoteOutboxCount: 0,
          latestRemoteCommand: {
            file: "remote-status.json",
            updatedAt: "2026-05-03T10:02:00.000Z",
            id: "remote-status",
            type: "status:show",
            receivedAt: "2026-05-03T10:02:00.000Z",
          },
          latestRemoteOutbox: {
            file: "remote-status.md",
            updatedAt: "2026-05-03T10:02:01.000Z",
          },
        },
        telegram: {
          offset: { nextOffset: 11 },
          replyState: { schemaVersion: 1, sentFiles: ["remote-status.md"], updatedAt: "2026-05-03T10:02:02.000Z" },
        },
        systemd: { directory: "/systemd", files: [] },
        warnings: [],
        failures: [],
      },
      proposals: [],
      drafts: [],
      tasks: [task],
      liveRuns: [
        {
          runId: "run-live",
          taskId: "dashboard-live-observer-dogfood",
          agentId: "codex-reviewer",
          phase: "execute",
          lastEventType: "stdout",
          lastAt: "2026-05-03T10:06:00.000Z",
          liveLogPath: "/repo/runs/live/run-live.jsonl",
          latestText: "<worker update>",
          events: [
            {
              at: "2026-05-03T10:05:00.000Z",
              type: "command_start",
              phase: "worker",
              command: "bun test",
            },
            {
              at: "2026-05-03T10:06:00.000Z",
              type: "stdout",
              phase: "worker",
              text: "<worker update>",
            },
          ],
        },
      ],
      lifecycles: [
        {
          schemaVersion: 1,
          runId: "run-1",
          taskId: "<task>",
          repoRoot: "/repo",
          runLogPath: "/runs/run-1.json",
          commit: "abc123",
          mergedAt: "2026-05-03T10:03:00.000Z",
          pushedAt: "2026-05-03T10:04:00.000Z",
          cleanedAt: "2026-05-03T10:05:00.000Z",
          updatedAt: "2026-05-03T10:05:00.000Z",
        },
      ],
    });

    expect(html).toContain("Samantha Dashboard");
    expect(html).toContain("Overview");
    expect(html).toContain("Lane View");
    expect(html).toContain("Running Workers");
    expect(html).toContain("Current Problems");
    expect(html).toContain("Recent Run Failures");
    expect(html).toContain("Next Action");
    expect(html).toContain("Live Timeline");
    expect(html).toContain("Current Attention");
    expect(html).toContain("Run History Attention");
    expect(html).toContain("Heartbeat");
    expect(html).toContain("Pending inbox commands");
    expect(html).toContain("status:show");
    expect(html).toContain("merged=yes pushed=yes cleaned=yes");
    expect(html).toContain("dashboard-live-observer-dogfood");
    expect(html).toContain("&lt;worker update&gt;");
    expect(html).toContain("&lt;task&gt;");
    expect(html).toContain("abc123");
    expect(html).toContain("Worker output");
    expect(html).toContain("Started: bun test");
    expect(html).not.toContain("/repo/runs/live/run-live.jsonl");
    expect(html).not.toContain(">Runs<");
    expect(html).not.toContain(">Intake<");
    expect(html).not.toContain(">System<");
    expect(html).not.toContain(">Docs<");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });

  test("separates current problems from historical run failures", () => {
    const failedRun: RunSummary = {
      schemaVersion: 1,
      runId: "run-failed",
      taskId: "old-failed-task",
      taskTitle: "Old failed task",
      agentId: "codex-worker",
      repoRoot: "/repo",
      worktreePath: "/repo/worktrees/old-failed-task",
      logPath: "/logs/run-failed.json",
      startedAt: "2026-05-03T10:00:00.000Z",
      finishedAt: "2026-05-03T10:01:00.000Z",
      outcome: "verify_failed",
      pass: false,
      commit: "",
      failureReason: "verify command failed",
    };
    const html = renderDashboard([failedRun], {
      tasks: [
        {
          ...task,
          id: "pending-task",
          status: "pending",
        },
      ],
      ops: {
        ok: true,
        checkedAt: "2026-05-05T10:00:00.000Z",
        env: {
          envFilePath: "/repo/.env",
          envFileExists: true,
          hasBotToken: true,
          hasPollChatId: true,
          hasReplyChatId: true,
          codexCommand: "codex",
          hasCodexExecutable: true,
        },
        health: { ok: true, ageMs: 1000, violations: [] },
        queues: {
          pendingInboxCount: 0,
          outboxCount: 0,
          remoteOutboxCount: 0,
          unsentRemoteOutboxCount: 0,
        },
        telegram: {
          replyState: { schemaVersion: 1, sentFiles: [], updatedAt: "2026-05-05T10:00:00.000Z" },
        },
        systemd: { directory: "/systemd", files: [] },
        warnings: [],
        failures: [],
      },
      liveRuns: [],
    });

    expect(html).toContain('<div class="label">Current Problems</div>');
    expect(html).toContain('<div class="value">0</div>');
    expect(html).toContain('<div class="label">Recent Run Failures</div>');
    expect(html).toContain("old-failed-task");
    expect(html).toContain("Dispatch pending task: pending-task");
    expect(html).toContain("run failed: old-failed-task - verify command failed");
  });

  test("does not count stale live logs as running workers", () => {
    const html = renderDashboard([], {
      liveRuns: [
        {
          runId: "orphan-live-run",
          taskId: "stale-task",
          agentId: "codex-worker",
          phase: "worker",
          lastEventType: "command_start",
          lastAt: "2000-01-01T00:00:00.000Z",
          liveLogPath: "/repo/runs/live/orphan-live-run.jsonl",
          events: [
            {
              at: "2000-01-01T00:00:00.000Z",
              type: "command_start",
              phase: "worker",
              command: "codex exec",
            },
          ],
        },
      ],
    });

    expect(html).toContain('<div class="label">Running Workers</div>\n    <div class="value">0</div>\n    <div class="detail">Stale 1');
    expect(html).toContain("stale-task is stale");
    expect(html).toContain("Inspect current attention");
  });

  test("renders live log events by worker lane", () => {
    const now = new Date().toISOString();
    const html = renderLaneViewDashboard([], {
      liveRuns: [
        {
          runId: "run-live",
          taskId: "lane-task",
          agentId: "codex-worker",
          phase: "worker",
          lastEventType: "command_exit",
          lastAt: now,
          liveLogPath: "/repo/runs/live/run-live.jsonl",
          latestText: "done",
          events: [
            {
              at: now,
              type: "command_start",
              phase: "setup:1",
              command: "bun install",
            },
            {
              at: now,
              type: "stdout",
              phase: "worker",
              text: "working",
            },
            {
              at: now,
              type: "command_exit",
              phase: "worker",
              command: "codex exec",
              exitCode: 0,
            },
          ],
        },
      ],
    });

    expect(html).toContain("Lane View");
    expect(html).toContain("lane-task");
    expect(html).toContain("run-live");
    expect(html).toContain("setup:1");
    expect(html).toContain("Worker output");
    expect(html).toContain("running");
    expect(html).toContain("result");
    expect(html).toContain("exit 0");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });

  test("renders live timeline timestamps as local clock labels", () => {
    const now = new Date();
    const eventAt = now.toISOString();
    const expectedTime = [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join(":");
    const html = renderDashboard([], {
      liveRuns: [
        {
          runId: "run-live",
          taskId: "time-task",
          agentId: "codex-worker",
          phase: "worker",
          lastEventType: "stdout",
          lastAt: eventAt,
          liveLogPath: "/repo/runs/live/run-live.jsonl",
          events: [
            {
              at: eventAt,
              type: "stdout",
              phase: "worker",
              text: "time check",
            },
          ],
        },
      ],
    });

    expect(html).toContain(expectedTime);
    expect(html).not.toContain(`<span>${eventAt}</span>`);
  });

  test("summarizes structured file change events instead of showing raw JSON", () => {
    const now = new Date().toISOString();
    const html = renderDashboard([], {
      liveRuns: [
        {
          runId: "run-live",
          taskId: "file-change-task",
          agentId: "codex-worker",
          phase: "worker",
          lastEventType: "stdout",
          lastAt: now,
          liveLogPath: "/repo/runs/live/run-live.jsonl",
          events: [
            {
              at: now,
              type: "stdout",
              phase: "worker",
              text: JSON.stringify({
                type: "item.completed",
                item: {
                  type: "file_change",
                  changes: [
                    { path: "/home/lbk0523/projects/samantha-codex/src/lib/dashboard.ts", kind: "update" },
                    { path: "/home/lbk0523/projects/samantha-codex/tests/operations.test.ts", kind: "update" },
                  ],
                },
              }),
            },
          ],
        },
      ],
    });

    expect(html).toContain("File changes");
    expect(html).toContain("Changed 2 files");
    expect(html).toContain("/home/lbk0523/projects/samantha-codex/src/lib/dashboard.ts");
    expect(html).not.toContain("&quot;file_change&quot;");
  });

  test("highlights failed command events with a readable failure summary", () => {
    const now = new Date().toISOString();
    const html = renderDashboard([], {
      liveRuns: [
        {
          runId: "run-live",
          taskId: "failed-command-task",
          agentId: "codex-worker",
          phase: "worker",
          lastEventType: "command_exit",
          lastAt: now,
          liveLogPath: "/repo/runs/live/run-live.jsonl",
          events: [
            {
              at: now,
              type: "command_exit",
              phase: "worker",
              command: "bun test",
              exitCode: 1,
            },
          ],
        },
      ],
    });

    expect(html).toContain("Command failed");
    expect(html).toContain("Failed exit 1: bun test");
    expect(html).toContain("timeline-item high");
  });

  test("summarizes combined command output chunks", () => {
    const now = new Date().toISOString();
    const html = renderDashboard([], {
      liveRuns: [
        {
          runId: "run-live",
          taskId: "combined-command-task",
          agentId: "codex-worker",
          phase: "worker",
          lastEventType: "stdout",
          lastAt: now,
          liveLogPath: "/repo/runs/live/run-live.jsonl",
          events: [
            {
              at: now,
              type: "stdout",
              phase: "worker",
              text: "[cmd:start] bun test\n[cmd:exit 2] bun test\nfailed output",
            },
          ],
        },
      ],
    });

    expect(html).toContain("Command failed");
    expect(html).toContain("Failed exit 2: bun test");
    expect(html).toContain("failed output");
    expect(html).not.toContain("[cmd:start]");
  });

  test("renders responsive safeguards that keep timeline and attention panels from overlapping", () => {
    const html = renderDashboard([], { liveRuns: [] });

    expect(html).toContain(".layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr);");
    expect(html).toContain(".layout > .stack, .panel, .lane-card { min-width: 0; }");
    expect(html).toContain(".timeline { display: grid; gap: 8px; min-width: 0; }");
    expect(html).toContain(".event-text { min-width: 0;");
    expect(html).toContain("@media (max-width: 1120px)");
    expect(html).toContain(".layout { grid-template-columns: 1fr; }");
  });

  test("sorts completed lane cards after active problem lanes", () => {
    const now = new Date().toISOString();
    const completedRun: RunSummary = {
      schemaVersion: 1,
      runId: "run-completed",
      taskId: "completed-task",
      taskTitle: "Completed task",
      agentId: "codex-worker",
      repoRoot: "/repo",
      worktreePath: "/repo/worktrees/completed-task",
      logPath: "/logs/run-completed.json",
      startedAt: "2026-05-05T10:00:00.000Z",
      finishedAt: "2026-05-05T10:01:00.000Z",
      outcome: "pass",
      pass: true,
      commit: "abc123",
    };
    const html = renderLaneViewDashboard([completedRun], {
      liveRuns: [
        {
          runId: "run-completed",
          taskId: "completed-task",
          agentId: "codex-worker",
          phase: "worker",
          lastEventType: "command_exit",
          lastAt: now,
          liveLogPath: "/repo/runs/live/run-completed.jsonl",
          events: [
            {
              at: now,
              type: "command_exit",
              phase: "worker",
              exitCode: 0,
            },
          ],
        },
        {
          runId: "run-active-failed",
          taskId: "active-failed-task",
          agentId: "codex-worker",
          phase: "worker",
          lastEventType: "command_exit",
          lastAt: "2026-05-05T09:59:00.000Z",
          liveLogPath: "/repo/runs/live/run-active-failed.jsonl",
          events: [
            {
              at: "2026-05-05T09:59:00.000Z",
              type: "command_exit",
              phase: "worker",
              exitCode: 1,
            },
          ],
        },
      ],
    });

    expect(html.indexOf("active-failed-task")).toBeLessThan(html.indexOf("completed-task"));
  });

  test("renders an empty lane view state", () => {
    const html = renderLaneViewDashboard([], { liveRuns: [] });
    expect(html).toContain("No live worker logs found.");
  });

  test("writes overview and lane view dashboard files", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-dashboard-"));
    tmpRoots.push(root);
    const out = join(root, "dashboard", "index.html");

    await writeDashboard(out, [], { liveRuns: [] });

    expect(await readFile(out, "utf8")).toContain("Overview");
    expect(await readFile(join(root, "dashboard", "lane-view.html"), "utf8")).toContain("Lane View");
  });

  test("builds dashboards from live logs without malformed or token-only events", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-live-dashboard-"));
    tmpRoots.push(root);
    const logDir = join(root, "runs");
    const liveDir = join(logDir, "live");
    const out = join(root, "dashboard", "index.html");
    await mkdir(liveDir, { recursive: true });
    await writeFile(
      join(liveDir, "run-live.jsonl"),
      [
        JSON.stringify({
          schemaVersion: 1,
          type: "meta",
          at: "2026-05-05T10:00:00.000Z",
          runId: "run-live",
          taskId: "live-task",
          agentId: "codex-worker",
        }),
        "{malformed",
        JSON.stringify({
          schemaVersion: 1,
          type: "stdout",
          at: "2026-05-05T10:00:01.000Z",
          runId: "run-live",
          taskId: "live-task",
          phase: "worker",
          text: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
        }),
        JSON.stringify({
          schemaVersion: 1,
          type: "stdout",
          at: "2026-05-05T10:00:02.000Z",
          runId: "run-live",
          taskId: "live-task",
          phase: "worker",
          text: JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "<useful update>" },
          }),
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "samantha",
        "dashboard:build",
        `--state-dir=${join(root, "state")}`,
        `--log-dir=${logDir}`,
        `--out=${out}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const overview = await readFile(out, "utf8");
    const laneView = await readFile(join(root, "dashboard", "lane-view.html"), "utf8");
    expect(overview).toContain("live-task");
    expect(overview).toContain("&lt;useful update&gt;");
    expect(laneView).toContain("&lt;useful update&gt;");
    expect(overview).not.toContain("turn.completed");
    expect(laneView).not.toContain("turn.completed");
    expect(overview).not.toContain("malformed");
  });
});
