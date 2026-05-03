import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateWorktree, branchForTask, releaseWorktree, sanitizeTaskId } from "../src/lib/worktree";
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

  test("allocates a task worktree and releases it", async () => {
    const repo = await makeRepo();

    const allocation = await allocateWorktree({
      repoRoot: repo,
      taskId: "Task 1",
    });

    expect(allocation.branch).toBe("samantha/task-1");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], allocation.worktreePath)).toBe(
      "samantha/task-1",
    );

    await releaseWorktree({ repoRoot: repo, allocation });

    await expect(git(["rev-parse", "--verify", allocation.branch], repo)).rejects.toThrow();
  });
});
