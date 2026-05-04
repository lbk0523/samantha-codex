import { describe, expect, test } from "bun:test";
import { buildWorkerLiveLogPath, formatWorkerLiveLogLine } from "../src/lib/live-log";

describe("worker live log", () => {
  test("builds live log paths under the run log directory", () => {
    expect(buildWorkerLiveLogPath("/repo/runs", "run-1")).toBe("/repo/runs/live/run-1.jsonl");
  });

  test("formats metadata events for tmux observers", () => {
    const formatted = formatWorkerLiveLogLine(
      JSON.stringify({
        schemaVersion: 1,
        type: "meta",
        at: "2026-05-04T12:00:00.000Z",
        runId: "run-1",
        taskId: "task-1",
        agentId: "codex-worker",
        repoRoot: "/repo",
        worktreePath: "/worktree",
      }),
    );

    expect(formatted).toContain("run run-1");
    expect(formatted).toContain("task: task-1");
    expect(formatted).toContain("worktree: /worktree");
  });

  test("formats nested Codex JSONL agent messages", () => {
    const formatted = formatWorkerLiveLogLine(
      JSON.stringify({
        schemaVersion: 1,
        type: "stdout",
        at: "2026-05-04T12:00:01.000Z",
        runId: "run-1",
        taskId: "task-1",
        phase: "worker",
        text: JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"ok\",\"commit\":\"\"}",
          },
        }),
      }),
    );

    expect(formatted).toContain("worker stdout");
    expect(formatted).toContain("[agent]");
    expect(formatted).toContain("HARNESS_RESULT");
  });
});
