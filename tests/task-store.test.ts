import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { TaskStore } from "../src/lib/task-store";
import type { TaskSpec } from "../src/lib/contracts";

const path = resolve(import.meta.dir, "../state/test-tasks.jsonl");

const task: TaskSpec = {
  id: "task-store-fixture",
  title: "persist one task",
  targetAgent: "codex-worker",
  targetFiles: ["src/lib/task-store.ts"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun test tests/task-store.test.ts"],
  instructions: "Persist one task in the file-backed store.",
  expectedCommitSubject: "test: update task store fixture",
  status: "pending",
};

afterEach(async () => {
  await rm(path, { force: true });
});

describe("TaskStore", () => {
  test("appends and lists tasks", async () => {
    const store = new TaskStore(path);

    await store.append(task);

    expect(await store.list()).toEqual([task]);
    expect(await store.find(task.id)).toEqual(task);
  });

  test("rejects duplicate task ids", async () => {
    const store = new TaskStore(path);

    await store.append(task);

    await expect(store.append(task)).rejects.toThrow("task already exists");
  });

  test("updates task status", async () => {
    const store = new TaskStore(path);

    await store.append(task);
    const updated = await store.updateStatus(task.id, "completed");

    expect(updated.status).toBe("completed");
    expect(await store.find(task.id)).toEqual(updated);
    await expect(store.updateStatus("missing-task", "failed")).rejects.toThrow("task not found");
  });

  test("archives tasks and excludes them from active lists", async () => {
    const store = new TaskStore(path);

    await store.append(task);
    const archived = await store.archive(task.id, {
      archivedAt: "2026-05-04T10:00:00.000Z",
      reason: "stale fixture",
    });

    expect(archived).toMatchObject({
      status: "archived",
      archivedAt: "2026-05-04T10:00:00.000Z",
      archiveReason: "stale fixture",
    });
    expect(await store.listActive()).toEqual([]);
    expect(await store.list()).toEqual([archived]);
  });
});
