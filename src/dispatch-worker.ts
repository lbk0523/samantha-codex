import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentProfile, TaskSpec } from "./lib/contracts";
import { writeWorkerRunLog } from "./lib/run-log";
import { executeWorkerDispatch, prepareWorkerDispatch } from "./lib/worker-dispatch";

interface Args {
  task: string;
  agent: string;
  repoRoot: string;
  allocate: boolean;
  execute: boolean;
  log: boolean;
  logDir?: string;
  worktreesDir?: string;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string | true>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      values.set(arg.slice(2), true);
    } else {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }

  const task = values.get("task");
  const agent = values.get("agent");
  const repoRoot = values.get("repo-root");
  if (typeof task !== "string" || typeof agent !== "string" || typeof repoRoot !== "string") {
    throw new Error(
      "usage: bun run src/dispatch-worker.ts --task=<task.json> --agent=<profile.json> --repo-root=<repo> [--allocate] [--execute] [--log-dir=runs] [--no-log] [--worktrees-dir=worktrees]",
    );
  }

  const logDir = values.get("log-dir");
  const worktreesDir = values.get("worktrees-dir");
  return {
    task,
    agent,
    repoRoot,
    allocate: values.get("allocate") === true,
    execute: values.get("execute") === true,
    log: values.get("no-log") !== true,
    logDir: typeof logDir === "string" ? logDir : undefined,
    worktreesDir: typeof worktreesDir === "string" ? worktreesDir : undefined,
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

const args = parseArgs(process.argv.slice(2));
const [task, agent] = await Promise.all([
  readJson<TaskSpec>(resolve(args.task)),
  readJson<AgentProfile>(resolve(args.agent)),
]);

const input = {
  task,
  agent,
  repoRoot: resolve(args.repoRoot),
  allocate: args.allocate,
  worktreesDir: args.worktreesDir,
};

if (args.execute) {
  const startedAt = new Date().toISOString();
  const execution = await executeWorkerDispatch(input);
  const finishedAt = new Date().toISOString();
  let output: unknown = execution;

  if (args.log) {
    const logDir = resolve(args.logDir ?? resolve(import.meta.dir, "..", "runs"));
    const runLog = await writeWorkerRunLog(logDir, {
      task,
      agent,
      repoRoot: input.repoRoot,
      allocate: input.allocate,
      execute: args.execute,
      worktreesDir: input.worktreesDir,
      startedAt,
      finishedAt,
      execution,
    });
    output = { ...execution, runLog };
  }

  console.log(JSON.stringify(output, null, 2));
} else {
  const prepared = await prepareWorkerDispatch(input);
  console.log(JSON.stringify(prepared, null, 2));
}
