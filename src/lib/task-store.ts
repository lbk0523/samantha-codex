import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskSpec } from "./contracts";

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

  async append(task: TaskSpec): Promise<void> {
    const tasks = await this.list();
    if (tasks.some((existing) => existing.id === task.id)) {
      throw new Error(`task already exists: ${task.id}`);
    }
    await mkdir(dirname(this.path), { recursive: true });
    const next = [...tasks, task].map((item) => JSON.stringify(item)).join("\n") + "\n";
    await writeFile(this.path, next, "utf8");
  }
}
