import { access, lstat, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { WorktreeAllocation } from "./contracts";
import { git, gitHead, gitRaw, gitTopLevel } from "./git";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function gitCheckIgnore(path: string, cwd: string): Promise<boolean> {
  const child = Bun.spawn(["git", "check-ignore", "-q", path], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await child.exited) === 0;
}

async function gitPathIsClean(path: string, cwd: string): Promise<boolean> {
  const status = await gitRaw(["status", "--porcelain=v1", "--untracked-files=all", "--", path], cwd);
  return status.trim().length === 0;
}

async function linkNodeModulesEntries(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source)) {
    const from = resolve(source, entry);
    const to = resolve(target, entry);
    const stat = await lstat(from);
    await symlink(from, to, stat.isDirectory() ? "dir" : "file");
  }
}

export async function ensureWorktreeNodeModulesLink(input: {
  repoRoot: string;
  worktreePath: string;
}): Promise<boolean> {
  const repoRoot = await gitTopLevel(input.repoRoot);
  const worktreePath = resolve(input.worktreePath);
  if (repoRoot === worktreePath) return false;

  const source = resolve(repoRoot, "node_modules");
  const target = resolve(worktreePath, "node_modules");
  if (await pathExists(target)) return false;

  try {
    const sourceStat = await lstat(source);
    if (!sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  const ignored = (await gitCheckIgnore("node_modules", worktreePath)) || (await gitCheckIgnore("node_modules/", worktreePath));
  if (!ignored) return false;
  await symlink(source, target, "dir");
  if (await gitPathIsClean("node_modules", worktreePath)) return true;

  await rm(target, { force: true });
  await linkNodeModulesEntries(source, target);
  if (!(await gitPathIsClean("node_modules", worktreePath))) {
    await rm(target, { recursive: true, force: true });
    return false;
  }

  return true;
}

export async function allocateWorktree(options: AllocateWorktreeOptions): Promise<WorktreeAllocation> {
  const repoRoot = await gitTopLevel(options.repoRoot);
  const taskId = sanitizeTaskId(options.taskId);
  const branch = branchForTask(taskId);
  const worktreePath = worktreePathForTask(repoRoot, taskId, options.worktreesDir);
  const baseRef = options.baseRef ?? "HEAD";

  await mkdir(worktreesRoot(repoRoot, options.worktreesDir), { recursive: true });
  const baseCommit = await git(["rev-parse", baseRef], repoRoot);
  if (await pathExists(worktreePath)) {
    const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
    if (currentBranch !== branch) {
      throw new Error(`existing worktree has unexpected branch: ${currentBranch}`);
    }
    const dirty = await gitRaw(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath);
    if (dirty.trim()) {
      throw new Error(`existing worktree is not clean: ${worktreePath}`);
    }
    const currentHead = await gitHead(worktreePath);
    if (currentHead !== baseCommit) {
      throw new Error(`existing worktree HEAD does not match base ref: ${worktreePath}`);
    }

    await ensureWorktreeNodeModulesLink({ repoRoot, worktreePath });

    return {
      taskId,
      repoRoot,
      worktreePath,
      branch,
      baseCommit,
    };
  }

  await git(["worktree", "add", "-b", branch, worktreePath, baseCommit], repoRoot);
  await ensureWorktreeNodeModulesLink({ repoRoot, worktreePath });

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
