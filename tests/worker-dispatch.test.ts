import { describe, expect, test } from "bun:test";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { prepareWorkerDispatch, runCommand, runSetupCommands } from "../src/lib/worker-dispatch";

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

const task: TaskSpec = {
  id: "worker-dispatch-fixture",
  title: "Prepare worker dispatch",
  targetAgent: "codex-worker",
  targetFiles: ["src/lib/worker-dispatch.ts"],
  forbiddenChanges: ["state/**", "worktrees/**"],
  verifyCommands: ["bun test tests/worker-dispatch.test.ts"],
  instructions: "Prepare the worker dispatch command.",
  status: "pending",
};

describe("prepareWorkerDispatch", () => {
  test("validates policy and prepares a dry-run command", async () => {
    const prepared = await prepareWorkerDispatch({
      task,
      agent,
      repoRoot: "/repo",
      allocate: false,
    });

    expect(prepared.taskId).toBe(task.id);
    expect(prepared.worktreePath).toBe("/repo/worktrees/worker-dispatch-fixture");
    expect(prepared.allocation).toBeUndefined();
    expect(prepared.codex.command).toContain("/repo/worktrees/worker-dispatch-fixture");
  });

  test("fails before worktree allocation when safety policy blocks dispatch", async () => {
    await expect(
      prepareWorkerDispatch({
        task: { ...task, forbiddenChanges: [] },
        agent,
        repoRoot: "/repo",
        allocate: false,
      }),
    ).rejects.toThrow("writer tasks must declare forbiddenChanges");
  });

  test("does not add git metadata write access on dry-run preparation", async () => {
    const prepared = await prepareWorkerDispatch({
      task,
      agent,
      repoRoot: "/repo",
      allocate: false,
    });

    expect(prepared.codex.command).not.toContain("--add-dir");
  });

  test("captures command stdout, stderr, and exit code", async () => {
    const result = await runCommand(["bash", "-lc", "echo out && echo err >&2"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  test("runs setup commands in order inside the worktree", async () => {
    const results = await runSetupCommands(["pwd", "echo ready"], "/tmp");

    expect(results).toHaveLength(2);
    expect(results[0]?.exitCode).toBe(0);
    expect(results[0]?.stdout.trim()).toBe("/tmp");
    expect(results[1]?.stdout.trim()).toBe("ready");
  });

  test("stops setup commands after the first failure", async () => {
    const results = await runSetupCommands(["exit 7", "echo skipped"], "/tmp");

    expect(results).toHaveLength(1);
    expect(results[0]?.exitCode).toBe(7);
  });
});
