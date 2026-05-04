import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskSpec } from "../src/lib/contracts";
import { git, gitHead } from "../src/lib/git";
import { evaluateWorkerResult } from "../src/lib/worker-result";

let tmpRoots: string[] = [];

async function makeRepo(): Promise<{ root: string; baseCommit: string }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-result-"));
  tmpRoots.push(root);
  await git(["init"], root);
  await git(["config", "user.email", "samantha@example.local"], root);
  await git(["config", "user.name", "Samantha Test"], root);
  await writeFile(join(root, "allowed.txt"), "base\n", "utf8");
  await git(["add", "allowed.txt"], root);
  await git(["commit", "-m", "chore: initial fixture"], root);
  return { root, baseCommit: await gitHead(root) };
}

const task: TaskSpec = {
  id: "worker-result-fixture",
  title: "Evaluate worker result",
  targetAgent: "codex-worker",
  targetFiles: ["allowed.txt"],
  forbiddenChanges: ["state/**", "worktrees/**"],
  verifyCommands: ["test -f allowed.txt"],
  instructions: "Only change allowed.txt.",
  status: "pending",
};

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("evaluateWorkerResult", () => {
  test("passes when structured result, scope, and verify commands pass", async () => {
    const { root, baseCommit } = await makeRepo();
    await writeFile(join(root, "allowed.txt"), "changed\n", "utf8");
    await git(["add", "allowed.txt"], root);
    await git(["commit", "-m", "feat: change allowed file"], root);

    const result = await evaluateWorkerResult({
      task,
      cwd: root,
      baseCommit,
      output: 'HARNESS_RESULT: {"status":"pass","note":"done","commit":"abc123"}',
    });

    expect(result.pass).toBe(true);
    expect(result.changedFiles).toEqual(["allowed.txt"]);
    expect(result.scopeViolations).toEqual([]);
    expect(result.verifyResults[0]?.exitCode).toBe(0);
  });

  test("blocks forbidden changed files", async () => {
    const { root, baseCommit } = await makeRepo();
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state/leak.json"), "{}", "utf8");
    await git(["add", "state/leak.json"], root);
    await git(["commit", "-m", "feat: leak state"], root);

    const result = await evaluateWorkerResult({
      task,
      cwd: root,
      baseCommit,
      output: 'HARNESS_RESULT: {"status":"pass","note":"done","commit":"abc123"}',
    });

    expect(result.pass).toBe(false);
    expect(result.scopeViolations).toContainEqual({
      file: "state/leak.json",
      reason: "forbidden",
      matchedPattern: "state/**",
    });
  });

  test("blocks changes outside target files", async () => {
    const { root, baseCommit } = await makeRepo();
    await writeFile(join(root, "other.txt"), "changed\n", "utf8");
    await git(["add", "other.txt"], root);
    await git(["commit", "-m", "feat: change other file"], root);

    const result = await evaluateWorkerResult({
      task,
      cwd: root,
      baseCommit,
      output: 'HARNESS_RESULT: {"status":"pass","note":"done","commit":"abc123"}',
    });

    expect(result.pass).toBe(false);
    expect(result.scopeViolations).toContainEqual({
      file: "other.txt",
      reason: "outside-target",
    });
  });

  test("keeps the first character for uncommitted modified files", async () => {
    const { root, baseCommit } = await makeRepo();
    await writeFile(join(root, "allowed.txt"), "changed but not committed\n", "utf8");

    const result = await evaluateWorkerResult({
      task,
      cwd: root,
      baseCommit,
      output: 'HARNESS_RESULT: {"status":"pass","note":"done","commit":""}',
    });

    expect(result.changedFiles).toEqual(["allowed.txt"]);
    expect(result.scopeViolations).toEqual([]);
  });

  test("fails when verify commands fail", async () => {
    const { root, baseCommit } = await makeRepo();
    await writeFile(join(root, "allowed.txt"), "changed\n", "utf8");
    await git(["add", "allowed.txt"], root);
    await git(["commit", "-m", "feat: change allowed file"], root);

    const result = await evaluateWorkerResult({
      task: { ...task, verifyCommands: ["test -f missing.txt"] },
      cwd: root,
      baseCommit,
      output: 'HARNESS_RESULT: {"status":"pass","note":"done","commit":"abc123"}',
    });

    expect(result.pass).toBe(false);
    expect(result.verifyResults[0]?.exitCode).not.toBe(0);
  });

  test("promotes sandbox port-bind blocked workers when Samantha verify passes", async () => {
    const { root, baseCommit } = await makeRepo();
    await writeFile(join(root, "allowed.txt"), "changed\n", "utf8");

    const result = await evaluateWorkerResult({
      task,
      cwd: root,
      baseCommit,
      output:
        'Error: listen EPERM: operation not permitted 0.0.0.0:3000\n' +
        'HARNESS_RESULT: {"status":"blocked","note":"e2e blocked by sandbox port bind EPERM before spec ran","commit":""}',
    });

    expect(result.pass).toBe(true);
    expect(result.harness?.status).toBe("blocked");
    expect(result.verifyOverrideReason).toContain("worker sandbox blocked");
    expect(result.verifyResults[0]?.exitCode).toBe(0);
  });

  test("does not promote ordinary blocked workers", async () => {
    const { root, baseCommit } = await makeRepo();
    await writeFile(join(root, "allowed.txt"), "changed\n", "utf8");

    const result = await evaluateWorkerResult({
      task,
      cwd: root,
      baseCommit,
      output: 'HARNESS_RESULT: {"status":"blocked","note":"needs product decision","commit":""}',
    });

    expect(result.pass).toBe(false);
    expect(result.verifyOverrideReason).toBeUndefined();
    expect(result.verifyResults).toEqual([]);
  });

  test("keeps sandbox port-bind blocked workers failed when Samantha verify fails", async () => {
    const { root, baseCommit } = await makeRepo();
    await writeFile(join(root, "allowed.txt"), "changed\n", "utf8");

    const result = await evaluateWorkerResult({
      task: { ...task, verifyCommands: ["test -f missing.txt"] },
      cwd: root,
      baseCommit,
      output:
        'Error: listen EPERM: operation not permitted 0.0.0.0:3000\n' +
        'HARNESS_RESULT: {"status":"blocked","note":"e2e blocked by sandbox port bind EPERM before spec ran","commit":""}',
    });

    expect(result.pass).toBe(false);
    expect(result.verifyOverrideReason).toBeUndefined();
    expect(result.verifyResults[0]?.exitCode).not.toBe(0);
  });

  test("fails on missing structured result", async () => {
    const { root, baseCommit } = await makeRepo();

    const result = await evaluateWorkerResult({
      task,
      cwd: root,
      baseCommit,
      output: "done",
    });

    expect(result.pass).toBe(false);
    expect(result.parseError).toContain("missing HARNESS_RESULT");
  });
});
