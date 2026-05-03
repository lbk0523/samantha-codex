import { mkdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { WorktreeAllocation } from "./contracts";
import { git, gitHead, gitTopLevel } from "./git";

export interface AllocateWorktreeOptions {
  repoRoot: string;
  taskId: string;
  worktreesDir?: string;
  baseRef?: string;
}

export interface ReleaseWorktreeOptions {
  repoRoot: string;
  allocation: WorktreeAllocation;
  deleteBranch?: boolean;
}

export function sanitizeTaskId(taskId: string): string {
  const safe = taskId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) {
    throw new Error(`invalid task id: ${taskId}`);
  }
  return safe;
}

export function branchForTask(taskId: string): string {
  return `samantha/${sanitizeTaskId(taskId)}`;
}

export function defaultWorktreesRoot(repoRoot: string): string {
  return resolve(repoRoot, "..", ".samantha-worktrees", basename(repoRoot));
}

export function worktreesRoot(repoRoot: string, worktreesDir?: string): string {
  return worktreesDir ? resolve(repoRoot, worktreesDir) : defaultWorktreesRoot(repoRoot);
}

export function worktreePathForTask(repoRoot: string, taskId: string, worktreesDir?: string): string {
  return resolve(worktreesRoot(repoRoot, worktreesDir), sanitizeTaskId(taskId));
}

export async function allocateWorktree(options: AllocateWorktreeOptions): Promise<WorktreeAllocation> {
  const repoRoot = await gitTopLevel(options.repoRoot);
  const taskId = sanitizeTaskId(options.taskId);
  const branch = branchForTask(taskId);
  const worktreePath = worktreePathForTask(repoRoot, taskId, options.worktreesDir);
  const baseRef = options.baseRef ?? "HEAD";

  await mkdir(worktreesRoot(repoRoot, options.worktreesDir), { recursive: true });
  const baseCommit = await git(["rev-parse", baseRef], repoRoot);
  await git(["worktree", "add", "-b", branch, worktreePath, baseCommit], repoRoot);

  return {
    taskId,
    repoRoot,
    worktreePath,
    branch,
    baseCommit: await gitHead(worktreePath),
  };
}

export async function releaseWorktree(options: ReleaseWorktreeOptions): Promise<void> {
  await git(["worktree", "remove", "--force", options.allocation.worktreePath], options.repoRoot);
  if (options.deleteBranch ?? true) {
    await git(["branch", "-D", options.allocation.branch], options.repoRoot);
  }
  await rm(options.allocation.worktreePath, { recursive: true, force: true });
}
