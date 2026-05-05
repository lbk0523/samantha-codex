import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskSpec } from "./contracts";
import { sanitizeTaskId } from "./worktree";

export type RemoteActionStatus = "pending" | "approved" | "running" | "completed" | "failed";
export type RemoteActionKind = "dispatch_task";

export interface RemoteActionResult {
  runId?: string;
  runLogPath?: string;
  liveLogPath?: string;
  tmuxSession?: string;
  pass?: boolean;
  outcome?: string;
  failure?: string;
}

export interface RemoteActionRecord {
  schemaVersion: 1;
  id: string;
  kind: RemoteActionKind;
  status: RemoteActionStatus;
  createdAt: string;
  source: "remote" | "local";
  taskId: string;
  taskTitle: string;
  targetAgent: string;
  repoRoot: string;
  allocate: true;
  execute: true;
  tmux: true;
  approvedAt?: string;
  startedAt?: string;
  completedAt?: string;
  result?: RemoteActionResult;
}

function timestampToken(value: string): string {
  return value.replace(/[:.]/g, "-").toLowerCase();
}

async function writeActions(path: string, actions: RemoteActionRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const next = actions.map((item) => JSON.stringify(item)).join("\n") + "\n";
  await writeFile(path, next, "utf8");
}

export function buildRemoteDispatchActionId(input: { createdAt: string; taskId: string; commandId?: string }): string {
  const token = input.commandId ? sanitizeTaskId(input.commandId) : timestampToken(input.createdAt);
  return `action-${token}-${sanitizeTaskId(input.taskId)}-dispatch`;
}

export function createRemoteDispatchAction(input: {
  task: TaskSpec;
  repoRoot: string;
  createdAt: string;
  source: "remote" | "local";
  commandId?: string;
}): RemoteActionRecord {
  return {
    schemaVersion: 1,
    id: buildRemoteDispatchActionId({
      createdAt: input.createdAt,
      taskId: input.task.id,
      commandId: input.commandId,
    }),
    kind: "dispatch_task",
    status: "pending",
    createdAt: input.createdAt,
    source: input.source,
    taskId: input.task.id,
    taskTitle: input.task.title,
    targetAgent: input.task.targetAgent,
    repoRoot: input.repoRoot,
    allocate: true,
    execute: true,
    tmux: true,
  };
}

export function remoteActionCommand(action: RemoteActionRecord): string {
  if (action.kind !== "dispatch_task") return "";
  return `bun run samantha tasks:dispatch ${action.taskId} --repo-root=${action.repoRoot} --allocate --execute --tmux`;
}

export class RemoteActionStore {
  constructor(private readonly path: string) {}

  async list(): Promise<RemoteActionRecord[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RemoteActionRecord);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async find(id: string): Promise<RemoteActionRecord | undefined> {
    return (await this.list()).find((action) => action.id === id);
  }

  async append(action: RemoteActionRecord): Promise<void> {
    const actions = await this.list();
    if (actions.some((existing) => existing.id === action.id)) {
      throw new Error(`remote action already exists: ${action.id}`);
    }
    await writeActions(this.path, [...actions, action]);
  }

  async markApproved(id: string, approvedAt: string): Promise<RemoteActionRecord> {
    return this.update(id, (action) => {
      if (action.status !== "pending") throw new Error(`remote action must be pending: ${action.status}`);
      return { ...action, status: "approved", approvedAt };
    });
  }

  async markRunning(id: string, startedAt: string): Promise<RemoteActionRecord> {
    return this.update(id, (action) => {
      if (action.status !== "approved") throw new Error(`remote action must be approved: ${action.status}`);
      return { ...action, status: "running", startedAt };
    });
  }

  async markFinished(
    id: string,
    input: { status: "completed" | "failed"; completedAt: string; result: RemoteActionResult },
  ): Promise<RemoteActionRecord> {
    return this.update(id, (action) => {
      if (action.status !== "running") throw new Error(`remote action must be running: ${action.status}`);
      return {
        ...action,
        status: input.status,
        completedAt: input.completedAt,
        result: input.result,
      };
    });
  }

  private async update(
    id: string,
    update: (action: RemoteActionRecord) => RemoteActionRecord,
  ): Promise<RemoteActionRecord> {
    const actions = await this.list();
    const index = actions.findIndex((action) => action.id === id);
    if (index === -1) throw new Error(`remote action not found: ${id}`);

    const updated = update(actions[index]);
    const next = [...actions];
    next[index] = updated;
    await writeActions(this.path, next);
    return updated;
  }
}
