import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskSpec } from "../src/lib/contracts";
import { createRemoteDispatchAction, RemoteActionStore, remoteActionCommand } from "../src/lib/remote-action-store";

let tmpRoots: string[] = [];

const task: TaskSpec = {
  id: "remote-action-task",
  title: "Remote action task",
  targetAgent: "codex-worker",
  targetFiles: ["src/index.ts"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun test"],
  instructions: "Fixture.",
  status: "pending",
};

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("RemoteActionStore", () => {
  test("creates pending dispatch actions with fixed execution flags", () => {
    const action = createRemoteDispatchAction({
      task,
      repoRoot: "/repo",
      createdAt: "2026-05-05T10:00:00.000Z",
      source: "remote",
      commandId: "remote-message-1",
    });

    expect(action).toMatchObject({
      id: "action-remote-message-1-remote-action-task-dispatch",
      kind: "dispatch_task",
      status: "pending",
      taskId: "remote-action-task",
      repoRoot: "/repo",
      allocate: true,
      execute: true,
      tmux: true,
    });
    expect(remoteActionCommand(action)).toBe(
      "bun run samantha tasks:dispatch remote-action-task --repo-root=/repo --allocate --execute --tmux",
    );
  });

  test("stores actions and only changes status/result during approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-actions-"));
    tmpRoots.push(root);
    const store = new RemoteActionStore(join(root, "remote-actions.jsonl"));
    const action = createRemoteDispatchAction({
      task,
      repoRoot: "/repo",
      createdAt: "2026-05-05T10:00:00.000Z",
      source: "remote",
      commandId: "remote-message-1",
    });

    await store.append(action);
    await expect(store.append(action)).rejects.toThrow("already exists");
    const approved = await store.markApproved(action.id, "2026-05-05T10:01:00.000Z");
    const running = await store.markRunning(action.id, "2026-05-05T10:01:30.000Z", {
      runId: "run-1",
      liveLogPath: "/runs/live/run-1.jsonl",
      tmuxSession: "samantha",
    });
    const completed = await store.markFinished(action.id, {
      status: "completed",
      completedAt: "2026-05-05T10:02:00.000Z",
      result: { runId: "run-1", pass: true, outcome: "pass" },
    });

    expect(approved).toMatchObject({ status: "approved", approvedAt: "2026-05-05T10:01:00.000Z" });
    expect(running).toMatchObject({ status: "running", startedAt: "2026-05-05T10:01:30.000Z" });
    expect(running.result).toMatchObject({
      runId: "run-1",
      liveLogPath: "/runs/live/run-1.jsonl",
      tmuxSession: "samantha",
    });
    expect(completed).toMatchObject({
      id: action.id,
      taskId: action.taskId,
      repoRoot: action.repoRoot,
      status: "completed",
      result: { runId: "run-1", pass: true, liveLogPath: "/runs/live/run-1.jsonl", tmuxSession: "samantha" },
    });
    await expect(store.markApproved(action.id, "2026-05-05T10:03:00.000Z")).rejects.toThrow(
      "remote action must be pending",
    );
  });
});
