import { afterEach, describe, expect, test } from "bun:test";
import { access, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  allocateWorktree,
  branchForTask,
  defaultWorktreesRoot,
  releaseWorktree,
  sanitizeTaskId,
  worktreePathForTask,
} from "../src/lib/worktree";
import { git } from "../src/lib/git";

let tmpRoots: string[] = [];

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-worktree-"));
  tmpRoots.push(root);
  await git(["init"], root);
  await git(["config", "user.email", "samantha@example.local"], root);
  await git(["config", "user.name", "Samantha Test"], root);
  await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: initial fixture"], root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("worktree allocation", () => {
  test("sanitizes task ids for branch and path names", () => {
    expect(sanitizeTaskId("Feature A / Step 1")).toBe("feature-a-step-1");
    expect(branchForTask("Feature A / Step 1")).toBe("samantha/feature-a-step-1");
  });

  test("defaults task worktrees outside the target repo", async () => {
    const repo = await makeRepo();

    expect(defaultWorktreesRoot(repo)).toContain(".samantha-worktrees");
    expect(worktreePathForTask(repo, "Task 1").startsWith(repo)).toBe(false);
  });

  test("allocates a task worktree and releases it", async () => {
    const repo = await makeRepo();

    const allocation = await allocateWorktree({
      repoRoot: repo,
      taskId: "Task 1",
      worktreesDir: "worktrees",
    });

    expect(allocation.branch).toBe("samantha/task-1");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], allocation.worktreePath)).toBe(
      "samantha/task-1",
    );

    await releaseWorktree({ repoRoot: repo, allocation });

    await expect(git(["rev-parse", "--verify", allocation.branch], repo)).rejects.toThrow();
  });

  test("links ignored node_modules into allocated worktrees", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, ".gitignore"), "/node_modules\n", "utf8");
    await mkdir(join(repo, "node_modules", "react"), { recursive: true });
    await writeFile(join(repo, "node_modules", "react", "package.json"), "{}\n", "utf8");
    await git(["add", ".gitignore"], repo);
    await git(["commit", "-m", "chore: ignore node modules"], repo);

    const allocation = await allocateWorktree({
      repoRoot: repo,
      taskId: "Task with deps",
      worktreesDir: "worktrees",
    });

    expect((await lstat(join(allocation.worktreePath, "node_modules"))).isSymbolicLink()).toBe(true);
    expect(await git(["status", "--porcelain=v1", "--untracked-files=all"], allocation.worktreePath)).toBe("");

    await releaseWorktree({ repoRoot: repo, allocation });
  });

  test("keeps node_modules clean when only directory ignore patterns are present", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(repo, "node_modules", "react"), { recursive: true });
    await writeFile(join(repo, "node_modules", "react", "package.json"), "{}\n", "utf8");
    await git(["add", ".gitignore"], repo);
    await git(["commit", "-m", "chore: ignore node modules directory"], repo);

    const allocation = await allocateWorktree({
      repoRoot: repo,
      taskId: "Task with directory ignored deps",
      worktreesDir: "worktrees",
    });

    const nodeModules = await lstat(join(allocation.worktreePath, "node_modules"));
    expect(nodeModules.isDirectory()).toBe(true);
    expect(nodeModules.isSymbolicLink()).toBe(false);
    await access(join(allocation.worktreePath, "node_modules", "react"));
    expect(await git(["status", "--porcelain=v1", "--untracked-files=all"], allocation.worktreePath)).toBe("");

    await releaseWorktree({ repoRoot: repo, allocation });
  });

  test("reuses an existing clean task worktree for the same base", async () => {
    const repo = await makeRepo();

    const first = await allocateWorktree({
      repoRoot: repo,
      taskId: "Task 1",
      worktreesDir: "worktrees",
    });
    const second = await allocateWorktree({
      repoRoot: repo,
      taskId: "Task 1",
      worktreesDir: "worktrees",
    });

    expect(second).toEqual(first);

    await releaseWorktree({ repoRoot: repo, allocation: first });
  });
});
