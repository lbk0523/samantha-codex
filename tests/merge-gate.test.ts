import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, gitHead } from "../src/lib/git";
import { applyMerge, evaluateMergeGate, evaluateMergeQueue, pushMerge } from "../src/lib/merge-gate";
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
      verifyCommands: ["grep -q changed allowed.txt"],
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

async function makePushRepo(): Promise<{ root: string; remote: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-push-"));
  const remote = await mkdtemp(join(tmpdir(), "samantha-codex-push-remote-"));
  tmpRoots.push(root, remote);
  await git(["init", "-b", "main"], root);
  await git(["config", "user.email", "samantha@example.local"], root);
  await git(["config", "user.name", "Samantha Test"], root);
  await writeFile(join(root, "allowed.txt"), "base\n", "utf8");
  await git(["add", "allowed.txt"], root);
  await git(["commit", "-m", "chore: initial"], root);
  await git(["init", "--bare"], remote);
  await git(["remote", "add", "origin", remote], root);
  await git(["push", "origin", "main"], root);
  await writeFile(join(root, "allowed.txt"), "changed\n", "utf8");
  await git(["add", "allowed.txt"], root);
  await git(["commit", "-m", "feat: local integration"], root);
  return { root, remote, head: await gitHead(root) };
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
    expect(result.alreadyMerged).toBe(false);
    expect(result.status).toBe("mergeable");
    expect(result.commit).toBe(workerCommit);
    expect(result.command).toEqual(["git", "merge", "--ff-only", workerCommit]);
  });

  test("recognizes an already integrated worker commit", async () => {
    const { root, workerCommit, logPath } = await makeRepo();
    await git(["merge", "--ff-only", workerCommit], root);

    const result = await evaluateMergeGate({ runLogPath: logPath, repoRoot: root });
    const apply = await applyMerge({ runLogPath: logPath, repoRoot: root });

    expect(result.mayMerge).toBe(false);
    expect(result.alreadyMerged).toBe(true);
    expect(result.status).toBe("already_merged");
    expect(result.command).toBeUndefined();
    expect(result.violations).toEqual([]);
    expect(apply.applied).toBe(false);
    expect(apply.verified).toBe(true);
  });

  test("blocks dirty target repositories", async () => {
    const { root, logPath } = await makeRepo();
    await writeFile(join(root, "dirty.txt"), "dirty\n", "utf8");

    const result = await evaluateMergeGate({ runLogPath: logPath, repoRoot: root });

    expect(result.mayMerge).toBe(false);
    expect(result.status).toBe("dirty_target_repo");
    expect(result.violations).toContain("target repo has uncommitted changes");
  });

  test("blocks non-fast-forward merge candidates before a conflict can apply", async () => {
    const { root, baseCommit, logPath } = await makeRepo();
    await writeFile(join(root, "allowed.txt"), "conflicting main change\n", "utf8");
    await git(["add", "allowed.txt"], root);
    await git(["commit", "-m", "feat: target change"], root);

    const result = await evaluateMergeGate({ runLogPath: logPath, repoRoot: root });
    const apply = await applyMerge({ runLogPath: logPath, repoRoot: root });

    expect(result.mayMerge).toBe(false);
    expect(result.status).toBe("stale_base");
    expect(result.command).toBeUndefined();
    expect(result.violations).toContain("target repo HEAD no longer matches the worker base commit");
    expect(apply.applied).toBe(false);
    expect(apply.merge).toBeUndefined();
    expect(await git(["merge-base", "--is-ancestor", baseCommit, "HEAD"], root)).toBe("");
  });

  test("applies a clean fast-forward merge and runs post-merge verification", async () => {
    const { root, workerCommit, logPath } = await makeRepo();

    const result = await applyMerge({ runLogPath: logPath, repoRoot: root });

    expect(result.applied).toBe(true);
    expect(result.status).toBe("mergeable");
    expect(result.verified).toBe(true);
    expect(result.merge?.exitCode).toBe(0);
    expect(result.verifyResults[0]?.exitCode).toBe(0);
    expect(await gitHead(root)).toBe(workerCommit);
  });

  test("records failed post-merge verification without treating the merge as verified", async () => {
    const { root, logPath } = await makeRepo();
    const log = JSON.parse(await readFile(logPath, "utf8")) as WorkerRunLog;
    log.task.verifyCommands = ["grep -q missing allowed.txt"];
    await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");

    const result = await applyMerge({ runLogPath: logPath, repoRoot: root });

    expect(result.applied).toBe(true);
    expect(result.status).toBe("failed_verification");
    expect(result.verified).toBe(false);
    expect(result.verifyResults[0]).toMatchObject({
      command: "grep -q missing allowed.txt",
      exitCode: 1,
    });
    expect(result.violations).toContain("post-merge verify command failed (1): grep -q missing allowed.txt");
  });

  test("does not apply merge when the gate is blocked", async () => {
    const { root, baseCommit, logPath } = await makeRepo();
    await writeFile(join(root, "dirty.txt"), "dirty\n", "utf8");

    const result = await applyMerge({ runLogPath: logPath, repoRoot: root });

    expect(result.applied).toBe(false);
    expect(result.status).toBe("dirty_target_repo");
    expect(result.merge).toBeUndefined();
    expect(await gitHead(root)).toBe(baseCommit);
  });

  test("classifies failed verification and missing commit candidates before merge", async () => {
    const failed = await makeRepo();
    const failedLog = JSON.parse(await readFile(failed.logPath, "utf8")) as WorkerRunLog;
    const failedEvaluation = failedLog.result.evaluation;
    if (!failedEvaluation) throw new Error("fixture evaluation missing");
    failedLog.result.pass = false;
    failedLog.result.evaluation = {
      ...failedEvaluation,
      pass: false,
      verifyResults: [{ command: "bun typecheck", exitCode: 1, stdout: "", stderr: "TS2322" }],
    };
    await writeFile(failed.logPath, `${JSON.stringify(failedLog, null, 2)}\n`, "utf8");

    const missing = await makeRepo();
    const missingLog = JSON.parse(await readFile(missing.logPath, "utf8")) as WorkerRunLog;
    const missingEvaluation = missingLog.result.evaluation;
    if (!missingEvaluation) throw new Error("fixture evaluation missing");
    missingLog.result.commit = undefined;
    missingLog.result.evaluation = {
      ...missingEvaluation,
      harness: { status: "pass", note: "commit missing", commit: "" },
    };
    await writeFile(missing.logPath, `${JSON.stringify(missingLog, null, 2)}\n`, "utf8");

    const failedResult = await evaluateMergeGate({ runLogPath: failed.logPath, repoRoot: failed.root });
    const missingResult = await evaluateMergeGate({ runLogPath: missing.logPath, repoRoot: missing.root });

    expect(failedResult.status).toBe("failed_verification");
    expect(failedResult.mayMerge).toBe(false);
    expect(failedResult.violations).toContain("run did not pass Samantha evaluation");
    expect(missingResult.status).toBe("missing_commit");
    expect(missingResult.mayMerge).toBe(false);
    expect(missingResult.violations).toContain("run did not report a commit");
  });

  test("classifies non-merge safety blockers separately from push", async () => {
    const { root, logPath } = await makeRepo();

    const result = await evaluateMergeGate({ runLogPath: logPath, repoRoot: root, targetBranch: "release" });

    expect(result.status).toBe("blocked");
    expect(result.command).toBeUndefined();
    expect(result.violations).toContain("target repo is on main, expected release");
  });

  test("orders multiple merge candidates deterministically without creating push commands", async () => {
    const mergeable = await makeRepo();
    const stale = await makeRepo();
    await writeFile(join(stale.root, "allowed.txt"), "target changed\n", "utf8");
    await git(["add", "allowed.txt"], stale.root);
    await git(["commit", "-m", "feat: target change"], stale.root);
    const failed = await makeRepo();
    const failedLog = JSON.parse(await readFile(failed.logPath, "utf8")) as WorkerRunLog;
    const queueFailedEvaluation = failedLog.result.evaluation;
    if (!queueFailedEvaluation) throw new Error("fixture evaluation missing");
    failedLog.runId = "run-failed";
    failedLog.finishedAt = "2026-05-03T10:03:00.000Z";
    failedLog.result.pass = false;
    failedLog.result.evaluation = {
      ...queueFailedEvaluation,
      pass: false,
      verifyResults: [{ command: "bun typecheck", exitCode: 1, stdout: "", stderr: "TS2322" }],
    };
    await writeFile(failed.logPath, `${JSON.stringify(failedLog, null, 2)}\n`, "utf8");

    const candidates = [
      { id: "failed", runLogPath: failed.logPath, repoRoot: failed.root },
      { id: "stale", runLogPath: stale.logPath, repoRoot: stale.root },
      { id: "mergeable", runLogPath: mergeable.logPath, repoRoot: mergeable.root },
    ];

    const first = await evaluateMergeQueue({ candidates });
    const second = await evaluateMergeQueue({ candidates: candidates.slice().reverse() });

    expect(first.candidates.map((candidate) => [candidate.id, candidate.status])).toEqual([
      ["mergeable", "mergeable"],
      ["stale", "stale_base"],
      ["failed", "failed_verification"],
    ]);
    expect(second.candidates.map((candidate) => candidate.id)).toEqual(first.candidates.map((candidate) => candidate.id));
    expect(first.candidates[0]?.command).toEqual(["git", "merge", "--ff-only", mergeable.workerCommit]);
    expect(first.candidates.flatMap((candidate) => candidate.command ?? []).join(" ")).not.toContain("push");
  });

  test("pushes a clean integrated branch explicitly", async () => {
    const { root, remote, head } = await makePushRepo();

    const result = await pushMerge({ repoRoot: root });

    expect(result.mayPush).toBe(true);
    expect(result.push?.exitCode).toBe(0);
    expect(await git(["rev-parse", "refs/heads/main"], remote)).toBe(head);
  });

  test("blocks push from dirty target repositories", async () => {
    const { root } = await makePushRepo();
    await writeFile(join(root, "dirty.txt"), "dirty\n", "utf8");

    const result = await pushMerge({ repoRoot: root });

    expect(result.mayPush).toBe(false);
    expect(result.push).toBeUndefined();
    expect(result.violations).toContain("target repo has uncommitted changes");
  });

  test("reports push command failures without marking the transition safe", async () => {
    const { root } = await makePushRepo();

    const result = await pushMerge({ repoRoot: root, remote: "missing" });

    expect(result.mayPush).toBe(false);
    expect(result.push?.exitCode).not.toBe(0);
    expect(result.violations).toContain(`push command failed (${result.push?.exitCode})`);
  });
});
