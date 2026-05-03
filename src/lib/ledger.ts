import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkerRunLogInput } from "./run-log";

export type RunOutcome =
  | "pass"
  | "setup_failed"
  | "worker_failed"
  | "missing_harness_result"
  | "scope_failed"
  | "verify_failed"
  | "rework"
  | "blocked"
  | "failed";

export interface RunSummary {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  taskTitle: string;
  agentId: string;
  repoRoot: string;
  worktreePath: string;
  logPath: string;
  startedAt: string;
  finishedAt: string;
  outcome: RunOutcome;
  pass: boolean;
  commit: string;
  failureReason?: string;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeJsonLines<T>(path: string, items: T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const raw = items.map((item) => JSON.stringify(item)).join("\n");
  await writeFile(path, raw.length > 0 ? `${raw}\n` : "", "utf8");
}

export class RunIndex {
  constructor(private readonly path: string) {}

  async list(): Promise<RunSummary[]> {
    return readJsonLines<RunSummary>(this.path);
  }

  async append(summary: RunSummary): Promise<void> {
    const runs = await this.list();
    if (runs.some((run) => run.runId === summary.runId)) {
      throw new Error(`run already exists: ${summary.runId}`);
    }
    await writeJsonLines(this.path, [...runs, summary]);
  }

  async find(runId: string): Promise<RunSummary | undefined> {
    return (await this.list()).find((run) => run.runId === runId);
  }
}

function firstFailedSetup(input: WorkerRunLogInput): string | undefined {
  const failed = input.execution.setupResults.find((result) => result.exitCode !== 0);
  if (!failed) return undefined;
  return `setup command failed (${failed.exitCode}): ${failed.command.join(" ")}`;
}

function firstFailedVerify(input: WorkerRunLogInput): string | undefined {
  const failed = input.execution.evaluation?.verifyResults.find((result) => result.exitCode !== 0);
  if (!failed) return undefined;
  return `verify command failed (${failed.exitCode}): ${failed.command}`;
}

export function summarizeWorkerRun(input: WorkerRunLogInput & { runId: string; logPath: string }): RunSummary {
  const execution = input.execution;
  const evaluation = execution.evaluation;
  let outcome: RunOutcome = "failed";
  let failureReason: string | undefined;

  if (execution.pass) {
    outcome = "pass";
  } else if ((failureReason = firstFailedSetup(input))) {
    outcome = "setup_failed";
  } else if (!execution.command) {
    outcome = "blocked";
    failureReason = "worker did not start";
  } else if (execution.command.exitCode !== 0) {
    outcome = "worker_failed";
    failureReason = `worker command failed (${execution.command.exitCode})`;
  } else if (evaluation?.parseError) {
    outcome = "missing_harness_result";
    failureReason = evaluation.parseError;
  } else if (evaluation && evaluation.scopeViolations.length > 0) {
    outcome = "scope_failed";
    failureReason = `${evaluation.scopeViolations.length} scope violation(s)`;
  } else if ((failureReason = firstFailedVerify(input))) {
    outcome = "verify_failed";
  } else if (evaluation?.harness?.status === "rework") {
    outcome = "rework";
    failureReason = evaluation.harness.note;
  } else if (evaluation?.harness?.status === "blocked") {
    outcome = "blocked";
    failureReason = evaluation.harness.note;
  }

  return {
    schemaVersion: 1,
    runId: input.runId,
    taskId: input.task.id,
    taskTitle: input.task.title,
    agentId: input.agent.id,
    repoRoot: input.repoRoot,
    worktreePath: execution.preparation.worktreePath,
    logPath: input.logPath,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome,
    pass: execution.pass,
    commit: evaluation?.harness?.commit ?? "",
    failureReason,
  };
}
