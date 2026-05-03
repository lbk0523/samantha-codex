import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { buildWorkerRunLog, writeWorkerRunLog } from "../src/lib/run-log";
import type { WorkerDispatchExecution } from "../src/lib/worker-dispatch";

const tmpRoots: string[] = [];

const task: TaskSpec = {
  id: "Audit Log Fixture",
  title: "Write audit log",
  targetAgent: "codex-worker",
  targetFiles: ["allowed.txt"],
  forbiddenChanges: ["forbidden/**"],
  setupCommands: ["bun install"],
  verifyCommands: ["test -f allowed.txt"],
  instructions: "Write an audit log fixture.",
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
    blockedSkills: [],
  },
};

const execution: WorkerDispatchExecution = {
  preparation: {
    taskId: task.id,
    agentId: agent.id,
    worktreePath: "/tmp/samantha-worktree",
    codex: {
      prompt: "prompt",
      command: ["codex", "exec"],
    },
  },
  setupResults: [
    {
      command: ["bash", "-lc", "bun install"],
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  ],
  command: {
    command: ["codex", "exec"],
    exitCode: 0,
    stdout: 'HARNESS_RESULT: {"status":"pass","note":"ok","commit":"abc123"}',
    stderr: "",
  },
  evaluation: {
    pass: true,
    harness: {
      status: "pass",
      note: "ok",
      commit: "abc123",
    },
    changedFiles: ["allowed.txt"],
    scopeViolations: [],
    verifyResults: [],
  },
  pass: true,
};

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

describe("worker run logs", () => {
  test("builds a stable human-readable run log shape", () => {
    const log = buildWorkerRunLog({
      task,
      agent,
      repoRoot: "/repo",
      allocate: true,
      execute: true,
      worktreesDir: "samantha/worktrees",
      startedAt: "2026-05-03T10:00:00.000Z",
      finishedAt: "2026-05-03T10:01:00.000Z",
      execution,
    });

    expect(log.runId).toBe("2026-05-03T10-00-00-000Z-audit-log-fixture");
    expect(log.schemaVersion).toBe(1);
    expect(log.task).toEqual(task);
    expect(log.agent).toEqual(agent);
    expect(log.input).toEqual({
      repoRoot: "/repo",
      allocate: true,
      execute: true,
      worktreesDir: "samantha/worktrees",
    });
    expect(log.result).toEqual(execution);
  });

  test("records setup failures before Codex starts", () => {
    const blockedExecution: WorkerDispatchExecution = {
      preparation: execution.preparation,
      setupResults: [
        {
          command: ["bash", "-lc", "bun install"],
          exitCode: 1,
          stdout: "",
          stderr: "install failed",
        },
      ],
      pass: false,
    };
    const log = buildWorkerRunLog({
      task,
      agent,
      repoRoot: "/repo",
      allocate: true,
      execute: true,
      startedAt: "2026-05-03T10:00:00.000Z",
      finishedAt: "2026-05-03T10:00:05.000Z",
      execution: blockedExecution,
    });

    const result = log.result as WorkerDispatchExecution;
    expect(result.pass).toBe(false);
    expect(result.command).toBeUndefined();
    expect(result.evaluation).toBeUndefined();
    expect(result.setupResults[0]?.stderr).toBe("install failed");
  });

  test("writes a pretty JSON file under the log directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-run-log-"));
    tmpRoots.push(root);

    const written = await writeWorkerRunLog(root, {
      task,
      agent,
      repoRoot: "/repo",
      allocate: false,
      execute: true,
      startedAt: "2026-05-03T10:00:00.000Z",
      finishedAt: "2026-05-03T10:01:00.000Z",
      execution,
    });
    const raw = await readFile(written.path, "utf8");
    const parsed = JSON.parse(raw);

    expect(written.runId).toBe("2026-05-03T10-00-00-000Z-audit-log-fixture");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "schemaVersion": 1,\n');
    expect(parsed.result.pass).toBe(true);
    expect(parsed.result.setupResults[0].command).toEqual(["bash", "-lc", "bun install"]);
  });
});
