import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkerRunLog } from "./run-log";

export interface RunLifecycleRecord {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  repoRoot: string;
  runLogPath: string;
  commit: string;
  mergedAt?: string;
  pushedAt?: string;
  cleanedAt?: string;
  updatedAt: string;
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

export function lifecycleBaseFromRunLog(input: {
  log: WorkerRunLog;
  runLogPath: string;
  repoRoot: string;
  updatedAt: string;
}): RunLifecycleRecord {
  const commit = input.log.result.commit?.commitHash ?? input.log.result.evaluation?.harness?.commit ?? "";
  return {
    schemaVersion: 1,
    runId: input.log.runId,
    taskId: input.log.task.id,
    repoRoot: input.repoRoot,
    runLogPath: input.runLogPath,
    commit,
    updatedAt: input.updatedAt,
  };
}

export class RunLifecycleStore {
  constructor(private readonly path: string) {}

  async list(): Promise<RunLifecycleRecord[]> {
    return readJsonLines<RunLifecycleRecord>(this.path);
  }

  async find(runId: string): Promise<RunLifecycleRecord | undefined> {
    return (await this.list()).find((record) => record.runId === runId);
  }

  async mark(
    base: RunLifecycleRecord,
    event: "merged" | "pushed" | "cleaned",
    at: string,
  ): Promise<RunLifecycleRecord> {
    const records = await this.list();
    const index = records.findIndex((record) => record.runId === base.runId);
    const current = index === -1 ? base : { ...records[index], ...base };
    const updated: RunLifecycleRecord = {
      ...current,
      mergedAt: event === "merged" ? at : current.mergedAt,
      pushedAt: event === "pushed" ? at : current.pushedAt,
      cleanedAt: event === "cleaned" ? at : current.cleanedAt,
      updatedAt: at,
    };
    const next = [...records];
    if (index === -1) next.push(updated);
    else next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }
}
