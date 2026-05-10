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

export type WorktreeCleanupClassification =
  | "completed"
  | "dirty"
  | "missing"
  | "abandoned"
  | "already_cleaned"
  | "blocked";

export interface WorktreeCleanupResult {
  mayCleanup: boolean;
  cleaned: boolean;
  classification: WorktreeCleanupClassification;
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

function classifyCleanupCandidate(input: {
  blocking: boolean;
  dirty: boolean;
  missing: boolean;
  abandoned: boolean;
  alreadyCleaned: boolean;
}): WorktreeCleanupClassification {
  if (input.blocking) return "blocked";
  if (input.dirty) return "dirty";
  if (input.alreadyCleaned) return "already_cleaned";
  if (input.missing) return "missing";
  if (input.abandoned) return "abandoned";
  return "completed";
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
  let blocking = false;
  let dirty = false;
  let missing = false;
  let abandoned = false;
  let commitIntegrated = false;
  let worktreeValid = false;
  let branchExists = false;

  if (!allocation) {
    violations.push("run log has no allocated worktree");
    abandoned = true;
  }
  if (!log.result.pass) {
    violations.push("run did not pass Samantha evaluation");
    abandoned = true;
  }
  if (!commit) {
    violations.push("run did not report a commit");
    abandoned = true;
  }
  if (allocation && (await canonicalPath(allocation.repoRoot)) !== canonicalRepoRoot) {
    violations.push("run log repoRoot does not match target repo");
    blocking = true;
  }
  if (allocation && canonicalAllocationWorktree === canonicalRepoRoot) {
    violations.push("refusing to remove the target repo main worktree");
    blocking = true;
  }

  const currentBranch = await git(["branch", "--show-current"], repoRoot);
  if (currentBranch !== targetBranch) {
    violations.push(`target repo is on ${currentBranch || "(detached)"}, expected ${targetBranch}`);
    blocking = true;
  }

  const repoStatus = await gitRaw(["status", "--porcelain"], repoRoot);
  if (repoStatus.trim().length > 0) {
    violations.push("target repo has uncommitted changes");
    dirty = true;
  }

  if (allocation) {
    branchExists = await gitSucceeds(["rev-parse", "--verify", allocation.branch], repoRoot);
  }

  if (allocation && (await gitSucceeds(["rev-parse", "--show-toplevel"], allocation.worktreePath))) {
    worktreeValid = true;
    const worktreeStatus = await gitRaw(["status", "--porcelain"], allocation.worktreePath);
    if (worktreeStatus.trim().length > 0) {
      violations.push("worker worktree has uncommitted changes");
      dirty = true;
    }
  } else if (allocation) {
    violations.push("allocated worktree path is missing or invalid");
    missing = true;
  }

  if (commit) {
    if (!(await gitSucceeds(["cat-file", "-e", `${commit}^{commit}`], repoRoot))) {
      violations.push("reported commit does not exist in target repo");
      abandoned = true;
    } else {
      const head = await gitHead(repoRoot);
      if (!(await gitSucceeds(["merge-base", "--is-ancestor", commit, head], repoRoot))) {
        violations.push("target repo HEAD does not contain the worker commit");
        abandoned = true;
      } else {
        commitIntegrated = true;
      }
    }
  }

  const worktreePath = allocation?.worktreePath ?? "";
  const branch = allocation?.branch ?? "";
  const alreadyCleaned = Boolean(
    allocation &&
    commitIntegrated &&
    !worktreeValid &&
    !branchExists &&
    !dirty &&
    !blocking &&
    !abandoned,
  );
  const classification = classifyCleanupCandidate({
    blocking,
    dirty,
    missing: missing && !alreadyCleaned,
    abandoned,
    alreadyCleaned,
  });

  if (alreadyCleaned) {
    return {
      mayCleanup: false,
      cleaned: true,
      classification,
      targetBranch,
      worktreePath,
      branch,
      commit,
      violations: [],
    };
  }

  if (violations.length > 0 || !allocation || classification !== "completed") {
    return {
      mayCleanup: false,
      cleaned: false,
      classification,
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
      classification,
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
    classification,
    targetBranch,
    worktreePath,
    branch,
    commit,
    remove,
    deleteBranch: branchDelete,
    violations: branchDeleteFailed ? [`branch delete failed (${branchDelete.exitCode})`] : [],
  };
}
