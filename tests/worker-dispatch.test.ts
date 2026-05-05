import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { git } from "../src/lib/git";
import { commitWorkerChanges, executeWorkerDispatch, prepareWorkerDispatch, runCommand, runSetupCommands } from "../src/lib/worker-dispatch";

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

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-dispatch-"));
  await git(["init"], root);
  await git(["config", "user.email", "samantha@example.local"], root);
  await git(["config", "user.name", "Samantha Test"], root);
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: initial fixture"], root);
  return root;
}

describe("prepareWorkerDispatch", () => {
  test("validates policy and prepares a dry-run command", async () => {
    const prepared = await prepareWorkerDispatch({
      task,
      agent,
      repoRoot: "/repo",
      allocate: false,
    });

    expect(prepared.taskId).toBe(task.id);
    expect(prepared.worktreePath).toBe("/.samantha-worktrees/repo/worker-dispatch-fixture");
    expect(prepared.allocation).toBeUndefined();
    expect(prepared.codex.command).toContain("/.samantha-worktrees/repo/worker-dispatch-fixture");
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

  test("does not grant git metadata write access to worker agents", async () => {
    const root = await makeRepo();
    try {
      const writer = await prepareWorkerDispatch({
        task,
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
      });
      const reviewer = await prepareWorkerDispatch({
        task: {
          ...task,
          id: "worker-dispatch-reviewer-fixture",
          targetAgent: "codex-reviewer",
          targetFiles: [],
          forbiddenChanges: ["**/*"],
        },
        agent: {
          ...agent,
          id: "codex-reviewer",
          role: "reviewer",
          writerClass: "non-writer",
          worktreePolicy: "none",
          mergePolicy: "none",
        },
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
      });

      expect(writer.codex.command).not.toContain("--add-dir");
      expect(reviewer.codex.command).not.toContain("--add-dir");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures command stdout, stderr, and exit code", async () => {
    const result = await runCommand(["bash", "-lc", "echo out && echo err >&2"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  test("tees command progress to a live log when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-live-log-"));
    try {
      const path = join(root, "live.jsonl");
      const result = await runCommand(["bash", "-lc", "echo out && echo err >&2"], {
        liveLog: {
          path,
          runId: "run-fixture",
          taskId: task.id,
          phase: "worker",
        },
      });
      const raw = await readFile(path, "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; text?: string; exitCode?: number });

      expect(result.exitCode).toBe(0);
      expect(events.map((event) => event.type)).toContain("command_start");
      expect(events.find((event) => event.type === "stdout")?.text).toContain("out");
      expect(events.find((event) => event.type === "stderr")?.text).toContain("err");
      expect(events.find((event) => event.type === "command_exit")?.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test("creates a Samantha-owned commit from evaluated worker files", async () => {
    const root = await makeRepo();
    try {
      await writeFile(join(root, "README.md"), "changed\n", "utf8");

      const result = await commitWorkerChanges({
        task: { ...task, expectedCommitSubject: "test: commit worker files" },
        cwd: root,
        files: ["README.md"],
      });

      expect(result.add.exitCode).toBe(0);
      expect(result.commit.exitCode).toBe(0);
      expect(result.commitHash).toHaveLength(40);
      expect(await git(["log", "-1", "--pretty=%s"], root)).toBe("test: commit worker files");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes report-only worker tasks with no changed files", async () => {
    const root = await makeRepo();
    const fakeCodex = join(root, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        "#!/usr/bin/env bash\necho 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"report only\",\"commit\":\"\"}'\n",
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "report-only-fixture",
          targetFiles: ["README.md"],
          verifyCommands: ["test -f README.md"],
          resultMode: "report",
        },
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.evaluation?.changedFiles).toEqual([]);
      expect(result.commit).toBeUndefined();
      expect(result.pass).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps no-change write worker tasks failing", async () => {
    const root = await makeRepo();
    const fakeCodex = join(root, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        "#!/usr/bin/env bash\necho 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"no change\",\"commit\":\"\"}'\n",
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "write-no-change-fixture",
          targetFiles: ["README.md"],
          verifyCommands: ["test -f README.md"],
        },
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.evaluation?.changedFiles).toEqual([]);
      expect(result.commit?.add.stderr).toBe("no changed files to commit");
      expect(result.pass).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
