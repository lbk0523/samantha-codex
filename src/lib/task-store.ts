import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskSpec, TaskStatus } from "./contracts";

async function writeTasks(path: string, tasks: TaskSpec[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const next = tasks.map((item) => JSON.stringify(item)).join("\n") + "\n";
  await writeFile(path, next, "utf8");
}

export class TaskStore {
  constructor(private readonly path: string) {}

  async list(): Promise<TaskSpec[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskSpec);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async find(id: string): Promise<TaskSpec | undefined> {
    return (await this.list()).find((task) => task.id === id);
  }

  async listActive(): Promise<TaskSpec[]> {
    return (await this.list()).filter((task) => task.status !== "archived");
  }

  async append(task: TaskSpec): Promise<void> {
    const tasks = await this.list();
    if (tasks.some((existing) => existing.id === task.id)) {
      throw new Error(`task already exists: ${task.id}`);
    }
    await writeTasks(this.path, [...tasks, task]);
  }

  async updateStatus(id: string, status: TaskStatus): Promise<TaskSpec> {
    const tasks = await this.list();
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new Error(`task not found: ${id}`);

    const updated = { ...tasks[index], status };
    const next = [...tasks];
    next[index] = updated;
    await writeTasks(this.path, next);
    return updated;
  }

  async archive(id: string, input: { archivedAt: string; reason: string }): Promise<TaskSpec> {
    const tasks = await this.list();
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new Error(`task not found: ${id}`);

    const updated = {
      ...tasks[index],
      status: "archived" as const,
      archivedAt: input.archivedAt,
      archiveReason: input.reason,
    };
    const next = [...tasks];
    next[index] = updated;
    await writeTasks(this.path, next);
    return updated;
  }
}
