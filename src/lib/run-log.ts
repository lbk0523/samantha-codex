import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile, TaskSpec } from "./contracts";
import type { WorkerDispatchExecution } from "./worker-dispatch";
import { sanitizeTaskId } from "./worktree";

export interface WorkerRunLogInput {
  task: TaskSpec;
  agent: AgentProfile;
  repoRoot: string;
  allocate: boolean;
  execute: boolean;
  worktreesDir?: string;
  startedAt: string;
  finishedAt: string;
  execution: WorkerDispatchExecution;
}

export interface WorkerRunLogWrite {
  path: string;
  runId: string;
}

function timestampForFile(value: string): string {
  return value.replace(/[:.]/g, "-");
}

export function buildWorkerRunLog(input: WorkerRunLogInput): Record<string, unknown> {
  const runId = `${timestampForFile(input.startedAt)}-${sanitizeTaskId(input.task.id)}`;

  return {
    schemaVersion: 1,
    runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    task: input.task,
    agent: input.agent,
    input: {
      repoRoot: input.repoRoot,
      allocate: input.allocate,
      execute: input.execute,
      worktreesDir: input.worktreesDir,
    },
    result: input.execution,
  };
}

export async function writeWorkerRunLog(
  logDir: string,
  input: WorkerRunLogInput,
): Promise<WorkerRunLogWrite> {
  const log = buildWorkerRunLog(input);
  const runId = String(log.runId);
  const path = join(logDir, `${runId}.json`);

  await mkdir(logDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(log, null, 2)}\n`, "utf8");

  return { path, runId };
}
