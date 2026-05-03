import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, gitHead } from "../src/lib/git";
import { evaluateMergeGate } from "../src/lib/merge-gate";
import type { WorkerRunLog } from "../src/lib/run-log";

let tmpRoots: string[] = [];

async function makeRepo(): Promise<{ root: string; baseCommit: string; workerCommit: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-merge-"));
  tmpRoots.push(root);
  await git(["init", "-b", "main"], root);
  await git(["config", "user.email", "samantha@example.local"], root);
  await git(["config", "user.name", "Samantha Test"], root);
  await writeFile(join(root, "allowed.txt"), "base\n", "utf8");
  await git(["add", "allowed.txt"], root);
  await git(["commit", "-m", "chore: initial"], root);
  const baseCommit = await gitHead(root);
  await git(["checkout", "-b", "samantha/fixture"], root);
  await writeFile(join(root, "allowed.txt"), "changed\n", "utf8");
  await git(["add", "allowed.txt"], root);
  await git(["commit", "-m", "feat: worker change"], root);
  const workerCommit = await gitHead(root);
  await git(["checkout", "main"], root);
  const log: WorkerRunLog = {
    schemaVersion: 1,
    runId: "run-1",
    startedAt: "2026-05-03T10:00:00.000Z",
    finishedAt: "2026-05-03T10:01:00.000Z",
    task: {
      id: "merge-fixture",
      title: "Merge fixture",
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
        taskId: "merge-fixture",
        agentId: "codex-worker",
        worktreePath: join(root, "worktrees/merge-fixture"),
        allocation: {
          taskId: "merge-fixture",
          repoRoot: root,
          worktreePath: join(root, "worktrees/merge-fixture"),
          branch: "samantha/fixture",
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
  const logRoot = await mkdtemp(join(tmpdir(), "samantha-codex-merge-log-"));
  tmpRoots.push(logRoot);
  const logPath = join(logRoot, "run.json");
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return { root, baseCommit, workerCommit, logPath };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("evaluateMergeGate", () => {
  test("allows a clean fast-forward merge candidate", async () => {
    const { root, workerCommit, logPath } = await makeRepo();

    const result = await evaluateMergeGate({ runLogPath: logPath, repoRoot: root });

    expect(result.mayMerge).toBe(true);
    expect(result.commit).toBe(workerCommit);
    expect(result.command).toEqual(["git", "merge", "--ff-only", workerCommit]);
  });

  test("blocks dirty target repositories", async () => {
    const { root, logPath } = await makeRepo();
    await writeFile(join(root, "dirty.txt"), "dirty\n", "utf8");

    const result = await evaluateMergeGate({ runLogPath: logPath, repoRoot: root });

    expect(result.mayMerge).toBe(false);
    expect(result.violations).toContain("target repo has uncommitted changes");
  });
});
