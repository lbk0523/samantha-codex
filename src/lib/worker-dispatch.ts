import type { AgentProfile, TaskSpec, WorktreeAllocation } from "./contracts";
import { prepareCodexDispatch, type PreparedCodexDispatch } from "./codex-dispatch";
import { gitHead } from "./git";
import { validateDispatch } from "./policy";
import { evaluateWorkerResult, type WorkerResultEvaluation } from "./worker-result";
import { allocateWorktree, worktreePathForTask } from "./worktree";

export interface PrepareWorkerDispatchInput {
  task: TaskSpec;
  agent: AgentProfile;
  repoRoot: string;
  allocate: boolean;
  worktreesDir?: string;
}

export interface WorkerDispatchPreparation {
  taskId: string;
  agentId: string;
  worktreePath: string;
  allocation?: WorktreeAllocation;
  codex: PreparedCodexDispatch;
}

export interface CommandRunResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorkerDispatchExecution {
  preparation: WorkerDispatchPreparation;
  setupResults: CommandRunResult[];
  command?: CommandRunResult;
  evaluation?: WorkerResultEvaluation;
  commit?: WorkerCommitResult;
  pass: boolean;
}

export interface WorkerCommitResult {
  subject: string;
  files: string[];
  add: CommandRunResult;
  commit: CommandRunResult;
  commitHash: string;
}

export async function prepareWorkerDispatch(
  input: PrepareWorkerDispatchInput,
): Promise<WorkerDispatchPreparation> {
  const plan = validateDispatch(input.task, input.agent);
  if (!plan.mayDispatch) {
    throw new Error(`dispatch blocked:\n${plan.violations.join("\n")}`);
  }

  const allocation = input.allocate
    ? await allocateWorktree({
        repoRoot: input.repoRoot,
        taskId: input.task.id,
        worktreesDir: input.worktreesDir,
      })
    : undefined;
  const worktreePath =
    allocation?.worktreePath ??
    worktreePathForTask(input.repoRoot, input.task.id, input.worktreesDir);

  return {
    taskId: input.task.id,
    agentId: input.agent.id,
    worktreePath,
    allocation,
    codex: prepareCodexDispatch(input.task, input.agent, worktreePath),
  };
}

export async function runCommand(
  command: string[],
  options: { cwd?: string } = {},
): Promise<CommandRunResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
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

export async function runSetupCommands(commands: string[], cwd: string): Promise<CommandRunResult[]> {
  const results: CommandRunResult[] = [];

  for (const command of commands) {
    const result = await runCommand(["bash", "-lc", command], { cwd });
    results.push(result);
    if (result.exitCode !== 0) break;
  }

  return results;
}

function commitSubjectForTask(task: TaskSpec): string {
  return task.expectedCommitSubject ?? `samantha: ${task.title}`;
}

export async function commitWorkerChanges(input: {
  task: TaskSpec;
  cwd: string;
  files: string[];
}): Promise<WorkerCommitResult> {
  const files = [...input.files].sort();
  const subject = commitSubjectForTask(input.task);
  const add = files.length > 0
    ? await runCommand(["git", "add", "--", ...files], { cwd: input.cwd })
    : {
        command: ["git", "add", "--"],
        exitCode: 1,
        stdout: "",
        stderr: "no changed files to commit",
      };
  const commit = add.exitCode === 0
    ? await runCommand(["git", "commit", "-m", subject], { cwd: input.cwd })
    : {
        command: ["git", "commit", "-m", subject],
        exitCode: 1,
        stdout: "",
        stderr: "skipped because git add failed",
      };
  const commitHash = commit.exitCode === 0 ? await gitHead(input.cwd) : "";

  return {
    subject,
    files,
    add,
    commit,
    commitHash,
  };
}

export async function executeWorkerDispatch(input: PrepareWorkerDispatchInput): Promise<WorkerDispatchExecution> {
  const preparation = await prepareWorkerDispatch(input);
  const baseCommit = preparation.allocation?.baseCommit ?? (await gitHead(preparation.worktreePath));
  const setupResults = await runSetupCommands(input.task.setupCommands ?? [], preparation.worktreePath);
  if (setupResults.some((result) => result.exitCode !== 0)) {
    return {
      preparation,
      setupResults,
      pass: false,
    };
  }

  const command = await runCommand(preparation.codex.command);
  const output = [command.stdout, command.stderr].filter(Boolean).join("\n");
  const evaluation = await evaluateWorkerResult({
    task: input.task,
    cwd: preparation.worktreePath,
    baseCommit,
    output,
  });
  const commit =
    evaluation.pass && preparation.allocation && input.agent.writerClass === "writer"
      ? await commitWorkerChanges({
          task: input.task,
          cwd: preparation.worktreePath,
          files: evaluation.changedFiles,
        })
      : undefined;
  const commitPassed = !commit || (commit.add.exitCode === 0 && commit.commit.exitCode === 0);

  return {
    preparation,
    setupResults,
    command,
    evaluation,
    commit,
    pass: command.exitCode === 0 && evaluation.pass && commitPassed,
  };
}
