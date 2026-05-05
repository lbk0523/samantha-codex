import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import type { DaemonHeartbeat } from "../src/lib/daemon";
import { renderDashboard } from "../src/lib/dashboard";
import { processInbox } from "../src/lib/inbox";
import type { RunSummary } from "../src/lib/ledger";
import { buildPlanBatches, type LoadedPlanTask } from "../src/lib/plan-runner";
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
    expect(commandFromRemoteInput({ senderId: "bk", text: "/status" }, "bk").type).toBe("status:show");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/doctor" }, "bk").type).toBe("ops:doctor");
    expect(commandFromRemoteInput({ senderId: "bk", text: "/health" }, "bk").type).toBe("health:check");
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
    expect(
      commandFromRemoteInput(
        { senderId: "bk", text: "/draft-propose Improve task flow", receivedAt: "2026-05-03T10:06:00.000Z" },
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
    expect(commandFromRemoteInput({ senderId: "bk", text: "/next-action" }, "bk").type).toBe("ops:next-action");
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
    expect(html).toContain("Operation");
    expect(html).toContain("Work Intake");
    expect(html).toContain("Latest Run");
    expect(html).toContain("Heartbeat");
    expect(html).toContain("Pending inbox commands");
    expect(html).toContain("status:show");
    expect(html).toContain("merged=yes pushed=yes cleaned=yes");
    expect(html).toContain("dashboard-live-observer-dogfood");
    expect(html).toContain("/repo/runs/live/run-live.jsonl");
    expect(html).toContain("&lt;worker update&gt;");
    expect(html).toContain("&lt;task&gt;");
    expect(html).toContain("abc123");
  });
});
