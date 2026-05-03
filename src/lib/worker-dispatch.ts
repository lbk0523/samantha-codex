import type { AgentProfile, TaskSpec, WorktreeAllocation } from "./contracts";
import { prepareCodexDispatch, type PreparedCodexDispatch } from "./codex-dispatch";
import { validateDispatch } from "./policy";
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
