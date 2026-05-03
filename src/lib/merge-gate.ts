import { readFile } from "node:fs/promises";
import type { WorkerRunLog } from "./run-log";
import { git, gitHead, gitRaw } from "./git";

export interface MergeGateInput {
  runLogPath: string;
  repoRoot: string;
  targetBranch?: string;
}

export interface MergeGateResult {
  mayMerge: boolean;
  targetBranch: string;
  commit: string;
  command?: string[];
  violations: string[];
}

async function gitSucceeds(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

export async function readWorkerRunLog(path: string): Promise<WorkerRunLog> {
  return JSON.parse(await readFile(path, "utf8")) as WorkerRunLog;
}

export async function evaluateMergeGate(input: MergeGateInput): Promise<MergeGateResult> {
  const log = await readWorkerRunLog(input.runLogPath);
  const targetBranch = input.targetBranch ?? "main";
  const execution = log.result;
  const commit = execution.commit?.commitHash ?? execution.evaluation?.harness?.commit ?? "";
  const violations: string[] = [];

  if (!execution.pass) {
    violations.push("run did not pass Samantha evaluation");
  }
  if (!commit) {
    violations.push("run did not report a commit");
  }

  const branch = await git(["branch", "--show-current"], input.repoRoot);
  if (branch !== targetBranch) {
    violations.push(`target repo is on ${branch || "(detached)"}, expected ${targetBranch}`);
  }

  const status = await gitRaw(["status", "--porcelain"], input.repoRoot);
  if (status.trim().length > 0) {
    violations.push("target repo has uncommitted changes");
  }

  const baseCommit = execution.preparation.allocation?.baseCommit;
  if (!baseCommit) {
    violations.push("run log has no allocated worktree base commit");
  } else {
    const head = await gitHead(input.repoRoot);
    if (head !== baseCommit) {
      violations.push("target repo HEAD no longer matches the worker base commit");
    }
  }

  if (commit) {
    if (!(await gitSucceeds(["cat-file", "-e", `${commit}^{commit}`], input.repoRoot))) {
      violations.push("reported commit does not exist in target repo");
    } else if (baseCommit && !(await gitSucceeds(["merge-base", "--is-ancestor", baseCommit, commit], input.repoRoot))) {
      violations.push("reported commit is not descended from the worker base commit");
    }
  }

  return {
    mayMerge: violations.length === 0,
    targetBranch,
    commit,
    command: violations.length === 0 ? ["git", "merge", "--ff-only", commit] : undefined,
    violations,
  };
}
