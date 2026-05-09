import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, gitHead } from "../src/lib/git";
import type { WorkerRunLog } from "../src/lib/run-log";
import { allocateWorktree } from "../src/lib/worktree";
import { cleanupCompletedWorktree } from "../src/lib/worktree-cleanup";

let tmpRoots: string[] = [];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-cleanup-"));
  tmpRoots.push(root);
  await git(["init", "-b", "main"], root);
  await git(["config", "user.email", "samantha@example.local"], root);
  await git(["config", "user.name", "Samantha Test"], root);
  await writeFile(join(root, ".gitignore"), "worktrees/\n", "utf8");
  await writeFile(join(root, "allowed.txt"), "base\n", "utf8");
  await git(["add", ".gitignore", "allowed.txt"], root);
  await git(["commit", "-m", "chore: initial fixture"], root);
  return root;
}

async function makePassedRun(options: { merge: boolean }): Promise<{
  root: string;
  logPath: string;
  worktreePath: string;
  branch: string;
  commit: string;
}> {
  const root = await makeRepo();
  const allocation = await allocateWorktree({
    repoRoot: root,
    taskId: "cleanup-fixture",
    worktreesDir: "worktrees",
  });
  await writeFile(join(allocation.worktreePath, "allowed.txt"), "changed\n", "utf8");
  await git(["add", "allowed.txt"], allocation.worktreePath);
  await git(["commit", "-m", "feat: worker change"], allocation.worktreePath);
  const commit = await gitHead(allocation.worktreePath);
  if (options.merge) {
    await git(["merge", "--ff-only", commit], root);
  }

  const log: WorkerRunLog = {
    schemaVersion: 1,
    runId: "cleanup-run",
    startedAt: "2026-05-03T10:00:00.000Z",
    finishedAt: "2026-05-03T10:01:00.000Z",
    task: {
      id: "cleanup-fixture",
      title: "Cleanup fixture",
      targetAgent: "codex-worker",
      targetFiles: ["allowed.txt"],
      forbiddenChanges: ["state/**"],
      verifyCommands: [],
      instructions: "Fixture.",
      status: "pending",
    },
    agent: {
      id: "codex-worker",
      role: "writer",
      model: "gpt-5.5",
      writerClass: "writer",
      worktreePolicy: "per-task",
      mergePolicy: "samantha-controlled",
      skillPolicy: { requiredBundles: [], blockedSkills: [] },
    },
    input: { repoRoot: root, allocate: true, execute: true },
    result: {
      preparation: {
        taskId: "cleanup-fixture",
        agentId: "codex-worker",
        worktreePath: allocation.worktreePath,
        allocation,
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
        commitHash: commit,
      },
      pass: true,
    },
  };
  const logRoot = await mkdtemp(join(tmpdir(), "samantha-codex-cleanup-log-"));
  tmpRoots.push(logRoot);
  const logPath = join(logRoot, "run.json");
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");

  return {
    root,
    logPath,
    worktreePath: allocation.worktreePath,
    branch: allocation.branch,
    commit,
  };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("cleanupCompletedWorktree", () => {
  test("removes a clean completed worktree and deletes its merged branch", async () => {
    const { root, logPath, worktreePath, branch } = await makePassedRun({ merge: true });

    const result = await cleanupCompletedWorktree({ runLogPath: logPath, repoRoot: root });

    expect(result.cleaned).toBe(true);
    expect(result.remove?.exitCode).toBe(0);
    expect(result.deleteBranch?.exitCode).toBe(0);
    expect(await exists(worktreePath)).toBe(false);
    await expect(git(["rev-parse", "--verify", branch], root)).rejects.toThrow();
  });

  test("blocks cleanup before the worker commit is integrated", async () => {
    const { root, logPath, worktreePath, branch } = await makePassedRun({ merge: false });

    const result = await cleanupCompletedWorktree({ runLogPath: logPath, repoRoot: root });

    expect(result.cleaned).toBe(false);
    expect(result.violations).toContain("target repo HEAD does not contain the worker commit");
    expect(await exists(worktreePath)).toBe(true);
    expect(await git(["rev-parse", "--verify", branch], root)).toBeTruthy();
  });

  test("blocks cleanup when the worker worktree is dirty", async () => {
    const { root, logPath, worktreePath } = await makePassedRun({ merge: true });
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    const result = await cleanupCompletedWorktree({ runLogPath: logPath, repoRoot: root });

    expect(result.cleaned).toBe(false);
    expect(result.violations).toContain("worker worktree has uncommitted changes");
    expect(await exists(worktreePath)).toBe(true);
  });

  test("refuses cleanup when the run log points at the target repo worktree", async () => {
    const { root, logPath, worktreePath } = await makePassedRun({ merge: true });
    const log = JSON.parse(await readFile(logPath, "utf8")) as WorkerRunLog;
    log.result.preparation.worktreePath = root;
    if (log.result.preparation.allocation) {
      log.result.preparation.allocation.worktreePath = root;
    }
    await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");

    const result = await cleanupCompletedWorktree({ runLogPath: logPath, repoRoot: root });

    expect(result.cleaned).toBe(false);
    expect(result.violations).toContain("refusing to remove the target repo main worktree");
    expect(await exists(root)).toBe(true);
    expect(await exists(worktreePath)).toBe(true);
  });
});
