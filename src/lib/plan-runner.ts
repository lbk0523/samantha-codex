import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentProfile, TaskSpec } from "./contracts";
import { DecisionStore } from "./decision-store";
import { RunIndex, summarizeWorkerRun } from "./ledger";
import { writeWorkerRunLog } from "./run-log";
import { executeWorkerDispatch, prepareWorkerDispatch } from "./worker-dispatch";

export interface PlanTaskRef {
  id: string;
  task: string;
  agent: string;
  repoRoot: string;
  allocate?: boolean;
  execute?: boolean;
  worktreesDir?: string;
  dependsOn?: string[];
}

export interface PlanSpec {
  id: string;
  title: string;
  tasks: PlanTaskRef[];
}

export interface LoadedPlanTask {
  ref: PlanTaskRef;
  task: TaskSpec;
  agent: AgentProfile;
}

export interface PlanRunOptions {
  planPath: string;
  execute: boolean;
  logDir: string;
  stateDir: string;
}

export interface PlanRunResult {
  planId: string;
  batches: string[][];
  results: Array<{ id: string; result: unknown }>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadPlan(planPath: string): Promise<{ plan: PlanSpec; tasks: LoadedPlanTask[] }> {
  const plan = await readJson<PlanSpec>(planPath);
  const baseDir = dirname(planPath);
  const tasks = await Promise.all(
    plan.tasks.map(async (ref) => ({
      ref,
      task: await readJson<TaskSpec>(resolve(baseDir, ref.task)),
      agent: await readJson<AgentProfile>(resolve(baseDir, ref.agent)),
    })),
  );
  return { plan, tasks };
}

function isWriteProducingTask(task: LoadedPlanTask): boolean {
  return task.agent.writerClass === "writer" && task.task.resultMode !== "report";
}

function validatePlanTaskContracts(tasks: LoadedPlanTask[]): string[] {
  const violations: string[] = [];
  const taskById = new Map(tasks.map((task) => [task.ref.id, task]));
  const writeProducingTaskIds = new Set(
    tasks.filter((task) => isWriteProducingTask(task)).map((task) => task.ref.id),
  );

  for (const loaded of tasks) {
    const prefix = `plan task ${loaded.ref.id}`;

    if (loaded.agent.writerClass === "non-writer") {
      if (loaded.task.resultMode !== "report") {
        violations.push(`${prefix}: non-writer tasks must use report resultMode`);
      }
      if (loaded.task.targetFiles.length > 0) {
        violations.push(`${prefix}: non-writer report tasks must not declare targetFiles`);
      }
      if (loaded.agent.worktreePolicy !== "none") {
        violations.push(`${prefix}: non-writer agents must not allocate worktrees`);
      }
      if (loaded.ref.allocate === true) {
        violations.push(`${prefix}: non-writer plan refs must not request worktree allocation`);
      }
      if (loaded.agent.mergePolicy !== "none") {
        violations.push(`${prefix}: non-writer agents must not use merge policy`);
      }
    }

    if (loaded.task.resultMode === "report") {
      for (const dependency of loaded.ref.dependsOn ?? []) {
        if (!taskById.has(dependency)) continue;
        if (writeProducingTaskIds.has(dependency)) {
          violations.push(
            `${prefix}: report-only tasks must not depend on unmerged writer output from ${dependency}; put verification in the writer task's verifyCommands`,
          );
        }
      }
    }
  }

  return violations;
}

export function buildPlanBatches(tasks: LoadedPlanTask[]): string[][] {
  const contractViolations = validatePlanTaskContracts(tasks);
  if (contractViolations.length > 0) {
    throw new Error(`plan blocked:\n${contractViolations.join("\n")}`);
  }

  const remaining = new Map(tasks.map((task) => [task.ref.id, task]));
  const completed = new Set<string>();
  const batches: string[][] = [];

  while (remaining.size > 0) {
    const ready = Array.from(remaining.values()).filter((task) =>
      (task.ref.dependsOn ?? []).every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) {
      throw new Error("plan has unresolved or cyclic dependencies");
    }

    const nonWriters = ready.filter((task) => task.agent.writerClass !== "writer");
    const batch = nonWriters.length > 0 ? nonWriters : [ready.find((task) => task.agent.writerClass === "writer") ?? ready[0]];
    const ids = batch.map((task) => task.ref.id);
    batches.push(ids);
    for (const id of ids) {
      remaining.delete(id);
      completed.add(id);
    }
  }

  return batches;
}

export async function runPlan(options: PlanRunOptions): Promise<PlanRunResult> {
  const { plan, tasks } = await loadPlan(options.planPath);
  const governanceDecisions = await new DecisionStore(join(options.stateDir, "decisions.jsonl")).list();
  const batches = buildPlanBatches(tasks);
  const taskById = new Map(tasks.map((task) => [task.ref.id, task]));
  const results: Array<{ id: string; result: unknown }> = [];

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async (id) => {
        const loaded = taskById.get(id);
        if (!loaded) throw new Error(`unknown plan task: ${id}`);
        const input = {
          task: loaded.task,
          agent: loaded.agent,
          repoRoot: resolve(dirname(options.planPath), loaded.ref.repoRoot),
          allocate: loaded.ref.allocate ?? false,
          worktreesDir: loaded.ref.worktreesDir,
          governanceDecisions,
        };

        if (!options.execute && !loaded.ref.execute) {
          return { id, result: await prepareWorkerDispatch(input) };
        }

        const startedAt = new Date().toISOString();
        const execution = await executeWorkerDispatch(input);
        const finishedAt = new Date().toISOString();
        const logInput = {
          task: loaded.task,
          agent: loaded.agent,
          repoRoot: input.repoRoot,
          allocate: input.allocate,
          execute: true,
          worktreesDir: input.worktreesDir,
          startedAt,
          finishedAt,
          execution,
        };
        const runLog = await writeWorkerRunLog(options.logDir, logInput);
        const runSummary = summarizeWorkerRun({ ...logInput, runId: runLog.runId, logPath: runLog.path });
        await new RunIndex(join(options.stateDir, "runs.jsonl")).append(runSummary);
        return { id, result: { ...execution, runLog, runSummary } };
      }),
    );
    results.push(...batchResults);
  }

  return { planId: plan.id, batches, results };
}
