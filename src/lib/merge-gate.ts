import { readFile } from "node:fs/promises";
import type { WorkerRunLog } from "./run-log";
import { git, gitHead, gitRaw } from "./git";

export interface MergeGateInput {
  runLogPath: string;
  repoRoot: string;
  targetBranch?: string;
}

export type MergeCandidateStatus =
  | "mergeable"
  | "already_merged"
  | "stale_base"
  | "failed_verification"
  | "dirty_target_repo"
  | "missing_commit"
  | "blocked";

export interface MergeGateResult {
  mayMerge: boolean;
  alreadyMerged: boolean;
  status: MergeCandidateStatus;
  targetBranch: string;
  commit: string;
  command?: string[];
  violations: string[];
}

export interface MergeCommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MergeVerifyResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MergeApplyResult {
  gate: MergeGateResult;
  status: MergeCandidateStatus;
  applied: boolean;
  verified: boolean;
  merge?: MergeCommandResult;
  verifyResults: MergeVerifyResult[];
  headBefore?: string;
  headAfter?: string;
  violations: string[];
}

export interface MergePushInput {
  repoRoot: string;
  remote?: string;
  branch?: string;
}

export interface MergePushResult {
  mayPush: boolean;
  remote: string;
  branch: string;
  command?: string[];
  push?: MergeCommandResult;
  violations: string[];
}

export interface MergeQueueCandidateInput extends MergeGateInput {
  id?: string;
}

export interface MergeQueueCandidateResult extends MergeGateResult {
  id: string;
  runId: string;
  taskId: string;
  finishedAt: string;
  runLogPath: string;
  repoRoot: string;
}

export interface MergeQueueResult {
  candidates: MergeQueueCandidateResult[];
}

async function gitSucceeds(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command: string[], cwd: string): Promise<MergeCommandResult> {
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

async function runVerifyCommand(command: string, cwd: string): Promise<MergeVerifyResult> {
  const result = await runCommand(["bash", "-lc", command], cwd);
  return {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function readWorkerRunLog(path: string): Promise<WorkerRunLog> {
  return JSON.parse(await readFile(path, "utf8")) as WorkerRunLog;
}

function classifyMergeCandidate(input: {
  alreadyMerged: boolean;
  failedVerification: boolean;
  missingCommit: boolean;
  dirtyTargetRepo: boolean;
  staleBase: boolean;
  violations: string[];
}): MergeCandidateStatus {
  if (input.failedVerification) return "failed_verification";
  if (input.missingCommit) return "missing_commit";
  if (input.dirtyTargetRepo) return "dirty_target_repo";
  if (input.alreadyMerged && input.violations.length === 0) return "already_merged";
  if (input.staleBase) return "stale_base";
  if (input.violations.length === 0) return "mergeable";
  return "blocked";
}

async function evaluateMergeGateForLog(input: MergeGateInput, log: WorkerRunLog): Promise<MergeGateResult> {
  const targetBranch = input.targetBranch ?? "main";
  const execution = log.result;
  const commit = execution.commit?.commitHash ?? execution.evaluation?.harness?.commit ?? "";
  const violations: string[] = [];
  let failedVerification = false;
  let missingCommit = false;
  let dirtyTargetRepo = false;
  let staleBase = false;

  if (!execution.pass) {
    failedVerification = true;
    violations.push("run did not pass Samantha evaluation");
  }
  if (!commit) {
    missingCommit = true;
    violations.push("run did not report a commit");
  }

  const branch = await git(["branch", "--show-current"], input.repoRoot);
  if (branch !== targetBranch) {
    violations.push(`target repo is on ${branch || "(detached)"}, expected ${targetBranch}`);
  }

  const status = await gitRaw(["status", "--porcelain"], input.repoRoot);
  if (status.trim().length > 0) {
    dirtyTargetRepo = true;
    violations.push("target repo has uncommitted changes");
  }

  const baseCommit = execution.preparation.allocation?.baseCommit;
  if (!baseCommit) {
    staleBase = true;
    violations.push("run log has no allocated worktree base commit");
  } else {
    const head = await gitHead(input.repoRoot);
    if (head !== baseCommit) {
      staleBase = true;
      violations.push("target repo HEAD no longer matches the worker base commit");
    }
  }

  if (commit) {
    if (!(await gitSucceeds(["cat-file", "-e", `${commit}^{commit}`], input.repoRoot))) {
      missingCommit = true;
      violations.push("reported commit does not exist in target repo");
    } else if (baseCommit && !(await gitSucceeds(["merge-base", "--is-ancestor", baseCommit, commit], input.repoRoot))) {
      staleBase = true;
      violations.push("reported commit is not descended from the worker base commit");
    }
  }
  const head = await gitHead(input.repoRoot);
  const alreadyMerged = commit ? await gitSucceeds(["merge-base", "--is-ancestor", commit, head], input.repoRoot) : false;
  if (alreadyMerged) {
    const baseMismatchIndex = violations.indexOf("target repo HEAD no longer matches the worker base commit");
    if (baseMismatchIndex !== -1) {
      violations.splice(baseMismatchIndex, 1);
      staleBase = false;
    }
  }
  const candidateStatus = classifyMergeCandidate({
    alreadyMerged,
    failedVerification,
    missingCommit,
    dirtyTargetRepo,
    staleBase,
    violations,
  });

  return {
    mayMerge: violations.length === 0 && !alreadyMerged,
    alreadyMerged,
    status: candidateStatus,
    targetBranch,
    commit,
    command: violations.length === 0 && !alreadyMerged ? ["git", "merge", "--ff-only", commit] : undefined,
    violations,
  };
}

export async function evaluateMergeGate(input: MergeGateInput): Promise<MergeGateResult> {
  const log = await readWorkerRunLog(input.runLogPath);
  return evaluateMergeGateForLog(input, log);
}

const mergeQueueStatusOrder: Record<MergeCandidateStatus, number> = {
  mergeable: 0,
  already_merged: 1,
  stale_base: 2,
  failed_verification: 3,
  dirty_target_repo: 4,
  missing_commit: 5,
  blocked: 6,
};

function compareMergeQueueCandidates(left: MergeQueueCandidateResult, right: MergeQueueCandidateResult): number {
  return (
    mergeQueueStatusOrder[left.status] - mergeQueueStatusOrder[right.status] ||
    left.targetBranch.localeCompare(right.targetBranch) ||
    left.repoRoot.localeCompare(right.repoRoot) ||
    left.finishedAt.localeCompare(right.finishedAt) ||
    left.runId.localeCompare(right.runId) ||
    left.runLogPath.localeCompare(right.runLogPath)
  );
}

export async function evaluateMergeQueue(input: { candidates: MergeQueueCandidateInput[] }): Promise<MergeQueueResult> {
  const candidates = await Promise.all(
    input.candidates.map(async (candidate) => {
      const log = await readWorkerRunLog(candidate.runLogPath);
      const gate = await evaluateMergeGateForLog(candidate, log);
      return {
        ...gate,
        id: candidate.id ?? log.runId,
        runId: log.runId,
        taskId: log.task.id,
        finishedAt: log.finishedAt,
        runLogPath: candidate.runLogPath,
        repoRoot: candidate.repoRoot,
      };
    }),
  );

  return { candidates: candidates.sort(compareMergeQueueCandidates) };
}

export async function applyMerge(input: MergeGateInput): Promise<MergeApplyResult> {
  const [gate, log] = await Promise.all([evaluateMergeGate(input), readWorkerRunLog(input.runLogPath)]);
  const violations = [...gate.violations];

  if (!gate.mayMerge || !gate.command) {
    return {
      gate,
      status: gate.status,
      applied: false,
      verified: gate.alreadyMerged && violations.length === 0,
      verifyResults: [],
      violations,
    };
  }

  const headBefore = await gitHead(input.repoRoot);
  const merge = await runCommand(gate.command, input.repoRoot);
  const headAfter = await gitHead(input.repoRoot);
  if (merge.exitCode !== 0) {
    return {
      gate,
      status: "blocked",
      applied: false,
      verified: false,
      merge,
      verifyResults: [],
      headBefore,
      headAfter,
      violations: [...violations, `merge command failed (${merge.exitCode})`],
    };
  }

  const verifyResults = await Promise.all(log.task.verifyCommands.map((command) => runVerifyCommand(command, input.repoRoot)));
  const failedVerify = verifyResults.find((result) => result.exitCode !== 0);
  if (failedVerify) {
    violations.push(`post-merge verify command failed (${failedVerify.exitCode}): ${failedVerify.command}`);
  }

  return {
    gate,
    status: failedVerify ? "failed_verification" : gate.status,
    applied: true,
    verified: !failedVerify,
    merge,
    verifyResults,
    headBefore,
    headAfter,
    violations,
  };
}

export async function pushMerge(input: MergePushInput): Promise<MergePushResult> {
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? "main";
  const violations: string[] = [];

  const currentBranch = await git(["branch", "--show-current"], input.repoRoot);
  if (currentBranch !== branch) {
    violations.push(`target repo is on ${currentBranch || "(detached)"}, expected ${branch}`);
  }

  const status = await gitRaw(["status", "--porcelain"], input.repoRoot);
  if (status.trim().length > 0) {
    violations.push("target repo has uncommitted changes");
  }

  const command = ["git", "push", remote, branch];
  if (violations.length > 0) {
    return {
      mayPush: false,
      remote,
      branch,
      violations,
    };
  }

  const push = await runCommand(command, input.repoRoot);
  if (push.exitCode !== 0) {
    violations.push(`push command failed (${push.exitCode})`);
  }

  return {
    mayPush: violations.length === 0,
    remote,
    branch,
    command,
    push,
    violations,
  };
}
