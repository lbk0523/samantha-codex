import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkItemAncestry } from "./ancestry";
import type { TaskSpec } from "./contracts";
import { compactEntityId } from "./ids";
import type { QueueAdmissionRecord } from "./queue-admission";

export type RemoteActionStatus = "pending" | "waiting" | "approved" | "running" | "completed" | "failed";
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
  ancestry?: WorkItemAncestry;
  routineTriggerId?: string;
  routineFingerprint?: string;
  kind: RemoteActionKind;
  status: RemoteActionStatus;
  createdAt: string;
  source: "remote" | "local";
  admission?: QueueAdmissionRecord;
  taskId: string;
  taskTitle: string;
  targetAgent: string;
  repoRoot: string;
  allocate: true;
  execute: true;
  liveLog: true;
  tmux?: true;
  orchestratorPlanId?: string;
  orchestratorTaskId?: string;
  dependsOnActionIds?: string[];
  approvedAt?: string;
  startedAt?: string;
  completedAt?: string;
  result?: RemoteActionResult;
}

async function writeActions(path: string, actions: RemoteActionRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const next = actions.map((item) => JSON.stringify(item)).join("\n") + "\n";
  await writeFile(path, next, "utf8");
}

export function buildRemoteDispatchActionId(input: { createdAt: string; taskId: string; commandId?: string }): string {
  return compactEntityId({
    prefix: "action",
    createdAt: input.createdAt,
    label: input.taskId.replace(/^task-/, ""),
    source: `${input.createdAt}-${input.commandId ?? ""}-${input.taskId}`,
  });
}

export function createRemoteDispatchAction(input: {
  task: TaskSpec;
  repoRoot: string;
  createdAt: string;
  source: "remote" | "local";
  commandId?: string;
  status?: "pending" | "waiting";
  orchestratorPlanId?: string;
  orchestratorTaskId?: string;
  dependsOnActionIds?: string[];
  ancestry?: WorkItemAncestry;
  admission?: QueueAdmissionRecord;
}): RemoteActionRecord {
  return {
    schemaVersion: 1,
    id: buildRemoteDispatchActionId({
      createdAt: input.createdAt,
      taskId: input.task.id,
      commandId: input.commandId,
    }),
    ancestry: input.ancestry ?? input.task.ancestry,
    routineTriggerId: input.task.routineTriggerId,
    routineFingerprint: input.task.routineFingerprint,
    kind: "dispatch_task",
    status: input.status ?? "pending",
    createdAt: input.createdAt,
    source: input.source,
    admission: input.admission,
    taskId: input.task.id,
    taskTitle: input.task.title,
    targetAgent: input.task.targetAgent,
    repoRoot: input.repoRoot,
    allocate: true,
    execute: true,
    liveLog: true,
    orchestratorPlanId: input.orchestratorPlanId,
    orchestratorTaskId: input.orchestratorTaskId,
    dependsOnActionIds: input.dependsOnActionIds,
  };
}

export function remoteActionCommand(action: RemoteActionRecord): string {
  if (action.kind !== "dispatch_task") return "";
  return `bun run samantha tasks:dispatch ${action.taskId} --repo-root=${action.repoRoot} --allocate --execute --live-log`;
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

  async markDependenciesSatisfied(id: string, approvedAt: string): Promise<RemoteActionRecord> {
    return this.update(id, (action) => {
      if (action.status !== "waiting") throw new Error(`remote action must be waiting: ${action.status}`);
      return { ...action, status: "approved", approvedAt };
    });
  }

  async markRunning(id: string, startedAt: string, result?: RemoteActionResult): Promise<RemoteActionRecord> {
    return this.update(id, (action) => {
      if (action.status !== "approved") throw new Error(`remote action must be approved: ${action.status}`);
      return { ...action, status: "running", startedAt, ...(result ? { result: { ...action.result, ...result } } : {}) };
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
        result: { ...action.result, ...input.result },
      };
    });
  }

  async markFailed(
    id: string,
    input: { completedAt: string; result: RemoteActionResult },
  ): Promise<RemoteActionRecord> {
    return this.update(id, (action) => {
      if (action.status === "completed" || action.status === "failed") {
        throw new Error(`remote action must not be final: ${action.status}`);
      }
      return {
        ...action,
        status: "failed",
        completedAt: input.completedAt,
        result: { ...action.result, ...input.result },
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
