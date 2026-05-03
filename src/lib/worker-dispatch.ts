import type { AgentProfile, TaskSpec, WorktreeAllocation } from "./contracts";
import { join } from "node:path";
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
  command: CommandRunResult;
  evaluation: WorkerResultEvaluation;
  pass: boolean;
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
    codex: prepareCodexDispatch(input.task, input.agent, worktreePath, {
      gitMetadataDir: allocation ? join(input.repoRoot, ".git") : undefined,
    }),
  };
}

export async function runCommand(command: string[]): Promise<CommandRunResult> {
  const child = Bun.spawn(command, {
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

export async function executeWorkerDispatch(input: PrepareWorkerDispatchInput): Promise<WorkerDispatchExecution> {
  const preparation = await prepareWorkerDispatch(input);
  const baseCommit = preparation.allocation?.baseCommit ?? (await gitHead(preparation.worktreePath));
  const command = await runCommand(preparation.codex.command);
  const output = [command.stdout, command.stderr].filter(Boolean).join("\n");
  const evaluation = await evaluateWorkerResult({
    task: input.task,
    cwd: preparation.worktreePath,
    baseCommit,
    output,
  });

  return {
    preparation,
    command,
    evaluation,
    pass: command.exitCode === 0 && evaluation.pass,
  };
}
