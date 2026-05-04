import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunLifecycleStore, type RunLifecycleRecord } from "../src/lib/run-lifecycle-store";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-run-lifecycle-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

const base: RunLifecycleRecord = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "task-1",
  repoRoot: "/repo",
  runLogPath: "/runs/run-1.json",
  commit: "abc123",
  updatedAt: "2026-05-04T10:00:00.000Z",
};

describe("RunLifecycleStore", () => {
  test("marks merge, push, and cleanup lifecycle events", async () => {
    const root = await makeRoot();
    const store = new RunLifecycleStore(join(root, "state", "run-lifecycle.jsonl"));

    await store.mark(base, "merged", "2026-05-04T10:01:00.000Z");
    await store.mark(base, "pushed", "2026-05-04T10:02:00.000Z");
    const cleaned = await store.mark(base, "cleaned", "2026-05-04T10:03:00.000Z");

    expect(cleaned).toMatchObject({
      runId: "run-1",
      mergedAt: "2026-05-04T10:01:00.000Z",
      pushedAt: "2026-05-04T10:02:00.000Z",
      cleanedAt: "2026-05-04T10:03:00.000Z",
    });
    expect(await store.find("run-1")).toEqual(cleaned);
    expect(await store.list()).toEqual([cleaned]);
  });
});
