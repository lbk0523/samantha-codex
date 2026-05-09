import { readFile, realpath } from "node:fs/promises";
import type { WorktreeAllocation } from "./contracts";
import { git, gitHead, gitRaw, gitTopLevel } from "./git";
import type { WorkerRunLog } from "./run-log";

export interface WorktreeCleanupInput {
  runLogPath: string;
  repoRoot: string;
  targetBranch?: string;
  deleteBranch?: boolean;
}

export interface WorktreeCleanupCommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeCleanupResult {
  mayCleanup: boolean;
  cleaned: boolean;
  targetBranch: string;
  worktreePath: string;
  branch: string;
  commit: string;
  remove?: WorktreeCleanupCommandResult;
  deleteBranch?: WorktreeCleanupCommandResult;
  violations: string[];
}

async function readWorkerRunLog(path: string): Promise<WorkerRunLog> {
  return JSON.parse(await readFile(path, "utf8")) as WorkerRunLog;
}

async function runCommand(command: string[], cwd: string): Promise<WorktreeCleanupCommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { command, exitCode, stdout, stderr };
}

async function gitSucceeds(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function commitForLog(log: WorkerRunLog): string {
  return log.result.commit?.commitHash ?? log.result.evaluation?.harness?.commit ?? "";
}

function allocationForLog(log: WorkerRunLog): WorktreeAllocation | undefined {
  return log.result.preparation.allocation;
}

export async function cleanupCompletedWorktree(input: WorktreeCleanupInput): Promise<WorktreeCleanupResult> {
  const log = await readWorkerRunLog(input.runLogPath);
  const targetBranch = input.targetBranch ?? "main";
  const deleteBranch = input.deleteBranch ?? true;
  const allocation = allocationForLog(log);
  const commit = commitForLog(log);
  const repoRoot = await gitTopLevel(input.repoRoot);
  const canonicalRepoRoot = await canonicalPath(repoRoot);
  const canonicalAllocationWorktree = allocation ? await canonicalPath(allocation.worktreePath) : "";
  const violations: string[] = [];

  if (!allocation) {
    violations.push("run log has no allocated worktree");
  }
  if (!log.result.pass) {
    violations.push("run did not pass Samantha evaluation");
  }
  if (!commit) {
    violations.push("run did not report a commit");
  }
  if (allocation && (await canonicalPath(allocation.repoRoot)) !== canonicalRepoRoot) {
    violations.push("run log repoRoot does not match target repo");
  }
  if (allocation && canonicalAllocationWorktree === canonicalRepoRoot) {
    violations.push("refusing to remove the target repo main worktree");
  }

  const currentBranch = await git(["branch", "--show-current"], repoRoot);
  if (currentBranch !== targetBranch) {
    violations.push(`target repo is on ${currentBranch || "(detached)"}, expected ${targetBranch}`);
  }

  const repoStatus = await gitRaw(["status", "--porcelain"], repoRoot);
  if (repoStatus.trim().length > 0) {
    violations.push("target repo has uncommitted changes");
  }

  if (allocation && (await gitSucceeds(["rev-parse", "--show-toplevel"], allocation.worktreePath))) {
    const worktreeStatus = await gitRaw(["status", "--porcelain"], allocation.worktreePath);
    if (worktreeStatus.trim().length > 0) {
      violations.push("worker worktree has uncommitted changes");
    }
  } else if (allocation) {
    violations.push("allocated worktree path is missing or invalid");
  }

  if (commit) {
    if (!(await gitSucceeds(["cat-file", "-e", `${commit}^{commit}`], repoRoot))) {
      violations.push("reported commit does not exist in target repo");
    } else {
      const head = await gitHead(repoRoot);
      if (!(await gitSucceeds(["merge-base", "--is-ancestor", commit, head], repoRoot))) {
        violations.push("target repo HEAD does not contain the worker commit");
      }
    }
  }

  const worktreePath = allocation?.worktreePath ?? "";
  const branch = allocation?.branch ?? "";
  if (violations.length > 0 || !allocation) {
    return {
      mayCleanup: false,
      cleaned: false,
      targetBranch,
      worktreePath,
      branch,
      commit,
      violations,
    };
  }

  const remove = await runCommand(["git", "worktree", "remove", allocation.worktreePath], repoRoot);
  if (remove.exitCode !== 0) {
    return {
      mayCleanup: true,
      cleaned: false,
      targetBranch,
      worktreePath,
      branch,
      commit,
      remove,
      violations: [`worktree remove failed (${remove.exitCode})`],
    };
  }

  const branchDelete = deleteBranch
    ? await runCommand(["git", "branch", "-d", allocation.branch], repoRoot)
    : undefined;
  const branchDeleteFailed = branchDelete && branchDelete.exitCode !== 0;

  return {
    mayCleanup: true,
    cleaned: !branchDeleteFailed,
    targetBranch,
    worktreePath,
    branch,
    commit,
    remove,
    deleteBranch: branchDelete,
    violations: branchDeleteFailed ? [`branch delete failed (${branchDelete.exitCode})`] : [],
  };
}
