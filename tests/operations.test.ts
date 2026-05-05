import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import type { DaemonHeartbeat } from "../src/lib/daemon";
import { renderDashboard, renderLaneViewDashboard, writeDashboard } from "../src/lib/dashboard";
import { processInbox } from "../src/lib/inbox";
import type { RunSummary } from "../src/lib/ledger";
import { buildPlanBatches, type LoadedPlanTask } from "../src/lib/plan-runner";
import { createRemoteDispatchAction, RemoteActionStore } from "../src/lib/remote-action-store";
import { commandFromRemoteInput, enqueueRemoteCommand } from "../src/lib/remote-command";

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
    const command = commandFromRemoteInput(
      { senderId: "bk", text: "/task fixture", receivedAt: "2026-05-03T10:00:00.000Z" },
      "bk",
    );

    expect(command.type).toBe("tasks:show");
    expect(command.args?.id).toBe("fixture");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/help" }, "bk").type).toBe("remote:help");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/help_advanced" }, "bk")).toMatchObject({
      type: "remote:help",
      args: { mode: "advanced" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/help advanced" }, "bk").type).toBe("remote:help");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/now" }, "bk").type).toBe("ops:now");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/plan" }, "bk").type).toBe("drafts:plan-latest");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/plan omht planning_report" }, "bk")).toMatchObject({
      type: "drafts:plan-latest",
      args: {
        projectId: "omht",
        scopeId: "planning_report",
      },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/go" }, "bk").type).toBe("actions:go");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/check" }, "bk").type).toBe("status:show");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/problems" }, "bk").type).toBe("ops:doctor");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/status" }, "bk").type).toBe("status:show");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/doctor" }, "bk").type).toBe("ops:doctor");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/health" }, "bk").type).toBe("health:check");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/run_latest" }, "bk").type).toBe("runs:show-latest");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/run run-1" }, "bk")).toMatchObject({
      type: "runs:show",
      args: { id: "run-1" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/failures" }, "bk").type).toBe("runs:failures");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/proposals" }, "bk").type).toBe("proposals:list");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/proposal proposal-1" }, "bk")).toMatchObject({
      type: "proposals:show",
      args: { id: "proposal-1" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/proposal_next" }, "bk").type).toBe("proposals:show-latest");
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/accept proposal-1", receivedAt: "2026-05-03T10:05:00.000Z" },
        "bk",
      ),
    ).toMatchObject({
      type: "proposals:accept",
      args: {
        id: "proposal-1",
        receivedAt: "2026-05-03T10:05:00.000Z",
      },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/reject proposal-1" }, "bk")).toMatchObject({
      type: "proposals:reject",
      args: { id: "proposal-1" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/drafts" }, "bk").type).toBe("drafts:list");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/draft_next" }, "bk").type).toBe("drafts:show-latest");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/draft_prepare omht src/app.ts tests/app.test.ts" }, "bk")).toMatchObject({
      type: "drafts:prepare-latest",
      args: {
        projectId: "omht",
        targetFiles: ["src/app.ts", "tests/app.test.ts"],
      },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/draft-prepare omht" }, "bk")).toMatchObject({
      type: "drafts:prepare-latest",
      args: {
        projectId: "omht",
        targetFiles: [],
      },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/draft_approve" }, "bk").type).toBe("drafts:approve-latest");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/draft-approve" }, "bk").type).toBe("drafts:approve-latest");
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/draft_propose Improve task flow", receivedAt: "2026-05-03T10:06:00.000Z" },
        "bk",
      ),
    ).toMatchObject({
      type: "drafts:add-from-proposal-text",
      args: {
        proposalId: "proposal-2026-05-03t10-06-00.000z",
        text: "Improve task flow",
        senderId: "bk",
      },
    });
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/draft proposal-1", receivedAt: "2026-05-03T10:06:00.000Z" },
        "bk",
      ),
    ).toMatchObject({
      type: "drafts:add",
      args: {
        proposalId: "proposal-1",
        receivedAt: "2026-05-03T10:06:00.000Z",
      },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/draft draft-1" }, "bk")).toMatchObject({
      type: "drafts:show",
      args: { id: "draft-1" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/next_action" }, "bk").type).toBe("ops:next-action");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/next-action" }, "bk").type).toBe("ops:next-action");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/actions" }, "bk").type).toBe("actions:list");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/run_next" }, "bk").type).toBe("actions:run-next");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/run-next" }, "bk").type).toBe("actions:run-next");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/yes" }, "bk").type).toBe("actions:approve-latest");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/action action-1" }, "bk")).toMatchObject({
      type: "actions:show",
      args: { id: "action-1" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/action_current" }, "bk").type).toBe("actions:show-current");
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/prepare_dispatch task-pass", receivedAt: "2026-05-03T10:07:00.000Z" },
        "bk",
      ),
    ).toMatchObject({
      type: "actions:prepare-dispatch",
      args: {
        taskId: "task-pass",
        receivedAt: "2026-05-03T10:07:00.000Z",
      },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/prepare-dispatch task-pass" }, "bk").type).toBe("actions:prepare-dispatch");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/approve_action action-1" }, "bk")).toMatchObject({
      type: "actions:approve",
      args: { id: "action-1" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/approve-action action-1" }, "bk").type).toBe("actions:approve");
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/work Improve task flow", receivedAt: "2026-05-03T10:06:00.000Z" },
        "bk",
      ),
    ).toMatchObject({
      type: "drafts:add-from-proposal-text",
      args: {
        proposalId: "proposal-2026-05-03t10-06-00.000z",
        text: "Improve task flow",
        senderId: "bk",
      },
    });
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/propose Improve status reports", receivedAt: "2026-05-03T10:00:00.000Z" },
        "bk",
      ),
    ).toMatchObject({
      type: "proposals:add",
      args: {
        id: "proposal-2026-05-03t10-00-00.000z",
        text: "Improve status reports",
        senderId: "bk",
      },
    });
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/propose One more request", receivedAt: "2026-05-03T10:00:00.000Z", remoteId: 99 },
        "bk",
      ),
    ).toMatchObject({
      id: "remote-2026-05-03t10-00-00.000z-99-propose",
      args: {
        id: "proposal-2026-05-03t10-00-00.000z-99",
      },
    });
    expect(() => commandFromRemoteInput({ senderId: "other", text: "/runs" }, "bk")).toThrow("not allowed");

    const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-"));
    tmpRoots.push(root);
    const inputPath = join(root, "remote.json");
    await writeFile(inputPath, JSON.stringify({ senderId: "bk", text: "/runs" }), "utf8");
    const enqueued = await enqueueRemoteCommand({ inputPath, inboxDir: join(root, "inbox"), allowedSenderId: "bk" });

    expect(enqueued.command.type).toBe("runs:list");
    expect(await readFile(enqueued.path, "utf8")).toContain("runs:list");
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
    expect(report).toContain("No worker was dispatched yet.");
    expect(report).toContain("/approve_action");
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
    expect(report).toContain("Telegram: `/go`");
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
    expect(report).toContain("Status: `approved`");
    expect(report).toContain("waiting for `actions:watch`");
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
    expect(await readFile(join(outbox, "001.md"), "utf8")).toContain("Status: `approved`");
    expect(await store.find(action.id)).toMatchObject({ status: "approved" });
  });

  test("surfaces a work-created draft in now instead of reporting no action", async () => {
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
        type: "drafts:add-from-proposal-text",
        args: {
          proposalId: "proposal-work-now",
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
      join(inbox, "003-draft-next.json"),
      JSON.stringify({
        id: "remote-draft-next",
        type: "drafts:show-latest",
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
    const report = await readFile(join(outbox, "002-now.md"), "utf8");
    expect(report).toContain("Draft is waiting for preparation");
    expect(report).toContain("Telegram: `/plan`");
    expect(report).not.toContain("No immediate remote action");
    const draftReport = await readFile(join(outbox, "003-draft-next.md"), "utf8");
    expect(draftReport).toContain("Draft: `draft-work-now`");
    expect(draftReport).toContain("Improve Telegram now flow");
    expect(draftReport).toContain("Telegram: `/plan`");
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
    expect(await readFile(join(outbox, "002-prepare.md"), "utf8")).toContain("Ready: yes");
    expect(await readFile(join(outbox, "002-prepare.md"), "utf8")).toContain("Telegram: `/go`");
    const approveReport = await readFile(join(outbox, "003-approve.md"), "utf8");
    expect(approveReport).toContain("Created task: `task-remote-draft`");
    expect(approveReport).toContain("No worker was dispatched yet.");
    expect(approveReport).toContain("Telegram: `/go`");
    const actionReport = await readFile(join(outbox, "004-run-next.md"), "utf8");
    expect(actionReport).toContain("Repo: `/repo`");
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

  test("plans and approves execution through compressed remote commands", async () => {
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
              targetFiles: ["docs/**"],
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
        type: "drafts:add-from-proposal-text",
        args: {
          proposalId: "proposal-remote-plan-go",
          text: "Write a planning report for the Telegram flow",
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
        type: "drafts:plan-latest",
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
    const planReport = await readFile(join(outbox, "002-plan.md"), "utf8");
    expect(planReport).toContain("# plan");
    expect(planReport).toContain("Project: `omht` (inferred)");
    expect(planReport).toContain("Scope: `planning_report` - Planning report");
    expect(planReport).toContain("Execution Plan:");
    expect(planReport).toContain("Will Change:");
    expect(planReport).toContain("Telegram: `/go`");

    const goReport = await readFile(join(outbox, "003-go.md"), "utf8");
    expect(goReport).toContain("# go");
    expect(goReport).toContain("Approved draft: `draft-remote-plan-go`");
    expect(goReport).toContain("Status: `approved`");
    expect(goReport).toContain("Telegram: `/action_current`");
    expect((await new RemoteActionStore(join(state, "remote-actions.jsonl")).list())[0]).toMatchObject({
      status: "approved",
      taskId: "task-remote-plan-go",
      repoRoot: "/repo/omht",
    });
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
