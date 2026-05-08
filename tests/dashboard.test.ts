import { describe, expect, test } from "bun:test";
import { renderDashboard } from "../src/lib/dashboard";
import type { CeoStatusSnapshot } from "../src/lib/ceo-status";
import type { RunSummary } from "../src/lib/ledger";

const ceoStatus: CeoStatusSnapshot = {
  generatedAt: "2026-05-07T12:00:00.000Z",
  overall: "needs_decision",
  needsDecision: [
    {
      kind: "decision",
      id: "decision-1",
      title: "Review risky plan",
      status: "pending",
      reason: "Approve before materialization.",
      updatedAt: "2026-05-07T12:00:00.000Z",
      subject: "orchestrator_plan:plan-1",
      options: ["approve", "revise", "cancel"],
    },
  ],
  active: [
    {
      kind: "action",
      id: "action-1",
      title: "Implement dashboard review",
      status: "running",
      updatedAt: "2026-05-07T12:01:00.000Z",
      detail: "task=task-1",
    },
  ],
  blocked: [
    {
      kind: "run",
      id: "run-1",
      title: "Verify dashboard",
      status: "verify_failed",
      updatedAt: "2026-05-07T12:02:00.000Z",
      detail: "test failed",
    },
  ],
  historicalFailures: [
    {
      kind: "run",
      id: "run-old",
      title: "Old failed verification",
      status: "verify_failed",
      updatedAt: "2026-05-06T12:02:00.000Z",
      detail: "historical test failed",
    },
  ],
  completed: [],
  risks: ["Dispatch behavior could change."],
  nextAction: {
    kind: "resolve_decision",
    label: "Resolve the pending BK decision",
    command: "bun run samantha decisions:resolve decision-1 --resolution=approved --note=<note>",
    targetId: "decision-1",
    reason: "Approve before materialization.",
  },
};

describe("dashboard", () => {
  test("renders read-only CEO review details from the deterministic snapshot", () => {
    const html = renderDashboard([], { ceoStatus });

    expect(html).toContain("Daily Review");
    expect(html).toContain("BK decision is the current operating blocker.");
    expect(html).toContain("BK Decisions");
    expect(html).toContain("Review risky plan");
    expect(html).toContain("Active Work");
    expect(html).toContain("Implement dashboard review");
    expect(html).toContain("Blockers");
    expect(html).toContain("Verify dashboard");
    expect(html).toContain("Historical Failures");
    expect(html).toContain("Old failed verification");
    expect(html).toContain("Risks");
    expect(html).toContain("Dispatch behavior could change.");
    expect(html).toContain("Next Safe Action");
    expect(html).toContain("Resolve the pending BK decision");
    expect(html).toContain("Telegram: /approve");
    expect(html).toContain('<div class="fact"><span>BK decisions</span><span><code>1</code></span></div>');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });

  test("separates current problem counts from historical run failures", () => {
    const failedRun: RunSummary = {
      schemaVersion: 1,
      runId: "run-failed",
      taskId: "old-failed-task",
      taskTitle: "Old failed task",
      agentId: "codex-worker",
      repoRoot: "/repo",
      worktreePath: "/repo/worktrees/old-failed-task",
      logPath: "/logs/run-failed.json",
      startedAt: "2026-05-07T10:00:00.000Z",
      finishedAt: "2026-05-07T10:01:00.000Z",
      outcome: "verify_failed",
      pass: false,
      commit: "",
      failureReason: "verify command failed",
    };

    const html = renderDashboard([failedRun]);

    expect(html).toContain('<div class="label">Current Problems</div>\n    <div class="value">0</div>');
    expect(html).toContain('<div class="label">Recent Run Failures</div>\n    <div class="value">1</div>');
    expect(html).toContain("Review latest historical run failure: run-failed");
    expect(html).toContain("run failed: old-failed-task - verify command failed");
  });

  test("escapes CEO status content before rendering dashboard HTML", () => {
    const html = renderDashboard([], {
      ceoStatus: {
        generatedAt: "2026-05-07T12:00:00.000Z",
        overall: "needs_decision",
        needsDecision: [
          {
            kind: "decision",
            id: "decision-unsafe",
            title: "Review <unsafe-decision>",
            status: "pending",
            reason: "Reason with <unsafe-reason> & quotes",
            updatedAt: "2026-05-07T12:00:00.000Z",
            subject: "orchestrator_plan:<unsafe-subject>",
            options: ["approve", "revise", "cancel"],
          },
        ],
        active: [
          {
            kind: "task",
            id: "task-unsafe",
            title: "Active <unsafe-active>",
            status: "running",
            updatedAt: "2026-05-07T12:01:00.000Z",
            detail: "detail <unsafe-detail>",
          },
        ],
        blocked: [],
        historicalFailures: [
          {
            kind: "run",
            id: "run-unsafe",
            title: "History <unsafe-history>",
            status: "verify_failed",
            updatedAt: "2026-05-07T12:02:00.000Z",
            detail: "old <unsafe-failure>",
          },
        ],
        completed: [],
        risks: ["Risk <unsafe-risk> & follow up"],
        nextAction: {
          kind: "resolve_decision",
          label: "Resolve <unsafe-next>",
          command: "bun run samantha decisions:resolve <unsafe-command>",
          targetId: "decision-unsafe",
          reason: "Because <unsafe-next-reason>",
        },
      },
    });

    expect(html).toContain("Review &lt;unsafe-decision&gt;");
    expect(html).toContain("Reason with &lt;unsafe-reason&gt; &amp; quotes");
    expect(html).toContain("Active &lt;unsafe-active&gt;");
    expect(html).toContain("detail &lt;unsafe-detail&gt;");
    expect(html).toContain("History &lt;unsafe-history&gt;");
    expect(html).toContain("Risk &lt;unsafe-risk&gt; &amp; follow up");
    expect(html).toContain("Resolve &lt;unsafe-next&gt;");
    expect(html).toContain("Local fallback: bun run samantha decisions:resolve &lt;unsafe-command&gt;");
    expect(html).not.toContain("<unsafe-decision>");
    expect(html).not.toContain("<unsafe-risk>");
    expect(html).not.toContain("<unsafe-command>");
  });

  test("renders an idle dashboard without active work or write controls", () => {
    const html = renderDashboard([], {
      liveRuns: [],
      ceoStatus: {
        generatedAt: "2026-05-07T12:00:00.000Z",
        overall: "idle",
        needsDecision: [],
        active: [],
        blocked: [],
        historicalFailures: [],
        completed: [],
        risks: [],
        nextAction: {
          kind: "none",
          label: "No safe action required",
          reason: "No active work, blockers, decisions, risks, or integration gates.",
        },
      },
    });

    expect(html).toContain('<span class="badge success">idle</span>');
    expect(html).toContain("No active work needs BK right now.");
    expect(html).toContain("BK Decisions");
    expect(html).toContain("Active Work");
    expect(html).toContain("Blockers");
    expect(html).toContain("Historical Failures");
    expect(html).toContain("Risks");
    expect(html).toContain("No safe action required");
    expect(html).toContain("No live worker logs found.");
    expect(html).toContain("No run summaries found.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});
