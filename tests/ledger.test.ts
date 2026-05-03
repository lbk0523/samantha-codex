import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { RunIndex, summarizeWorkerRun } from "../src/lib/ledger";
import type { WorkerRunLogInput } from "../src/lib/run-log";
import type { WorkerDispatchExecution } from "../src/lib/worker-dispatch";

let tmpRoots: string[] = [];

const task: TaskSpec = {
  id: "ledger-fixture",
  title: "Ledger fixture",
  targetAgent: "codex-worker",
  targetFiles: ["allowed.txt"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["test -f allowed.txt"],
  instructions: "Fixture.",
  status: "pending",
};

const agent: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: { requiredBundles: [], blockedSkills: [] },
};

function input(execution: WorkerDispatchExecution): WorkerRunLogInput & { runId: string; logPath: string } {
  return {
    task,
    agent,
    repoRoot: "/repo",
    allocate: true,
    execute: true,
    startedAt: "2026-05-03T10:00:00.000Z",
    finishedAt: "2026-05-03T10:01:00.000Z",
    execution,
    runId: "run-1",
    logPath: "/logs/run-1.json",
  };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("RunIndex", () => {
  test("appends and finds run summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-ledger-"));
    tmpRoots.push(root);
    const index = new RunIndex(join(root, "runs.jsonl"));
    const summary = summarizeWorkerRun(
      input({
        preparation: {
          taskId: task.id,
          agentId: agent.id,
          worktreePath: "/repo/worktrees/ledger-fixture",
          codex: { prompt: "prompt", command: ["codex", "exec"] },
        },
        setupResults: [],
        command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
        evaluation: {
          pass: true,
          harness: { status: "pass", note: "ok", commit: "abc123" },
          changedFiles: ["allowed.txt"],
          scopeViolations: [],
          verifyResults: [],
        },
        pass: true,
      }),
    );

    await index.append(summary);

    expect(await index.list()).toEqual([summary]);
    expect(await index.find("run-1")).toEqual(summary);
    await expect(index.append(summary)).rejects.toThrow("run already exists");
  });

  test("summarizes setup and verify failures", () => {
    const setupFailed = summarizeWorkerRun(
      input({
        preparation: {
          taskId: task.id,
          agentId: agent.id,
          worktreePath: "/repo/worktrees/ledger-fixture",
          codex: { prompt: "prompt", command: ["codex", "exec"] },
        },
        setupResults: [{ command: ["bash", "-lc", "bun install"], exitCode: 1, stdout: "", stderr: "" }],
        pass: false,
      }),
    );
    const verifyFailed = summarizeWorkerRun(
      input({
        preparation: {
          taskId: task.id,
          agentId: agent.id,
          worktreePath: "/repo/worktrees/ledger-fixture",
          codex: { prompt: "prompt", command: ["codex", "exec"] },
        },
        setupResults: [],
        command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
        evaluation: {
          pass: false,
          harness: { status: "pass", note: "ok", commit: "abc123" },
          changedFiles: ["allowed.txt"],
          scopeViolations: [],
          verifyResults: [{ command: "test -f missing.txt", exitCode: 1, stdout: "", stderr: "" }],
        },
        pass: false,
      }),
    );

    expect(setupFailed.outcome).toBe("setup_failed");
    expect(setupFailed.failureReason).toContain("bun install");
    expect(verifyFailed.outcome).toBe("verify_failed");
    expect(verifyFailed.failureReason).toContain("missing.txt");
  });
});
