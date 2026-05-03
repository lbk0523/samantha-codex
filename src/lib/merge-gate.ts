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

export async function applyMerge(input: MergeGateInput): Promise<MergeApplyResult> {
  const [gate, log] = await Promise.all([evaluateMergeGate(input), readWorkerRunLog(input.runLogPath)]);
  const violations = [...gate.violations];

  if (!gate.mayMerge || !gate.command) {
    return {
      gate,
      applied: false,
      verified: false,
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
