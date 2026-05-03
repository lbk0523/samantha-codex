import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
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
    expect(await readFile(join(outbox, "001.md"), "utf8")).toBe("handled runs:list\n");
    expect(await readFile(join(archive, "001.json"), "utf8")).toContain("runs:list");
  });

  test("normalizes allowed remote commands into inbox commands", async () => {
    const command = commandFromRemoteInput(
      { senderId: "bk", text: "/task fixture", receivedAt: "2026-05-03T10:00:00.000Z" },
      "bk",
    );

    expect(command.type).toBe("tasks:show");
    expect(command.args?.id).toBe("fixture");
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

    const html = renderDashboard(runs);

    expect(html).toContain("Samantha Dashboard");
    expect(html).toContain("&lt;task&gt;");
    expect(html).toContain("abc123");
  });
});
