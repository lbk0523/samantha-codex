import { describe, expect, test } from "bun:test";
import { renderDashboard } from "../src/lib/dashboard";
import type { CeoStatusSnapshot } from "../src/lib/ceo-status";

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

    expect(html).toContain("CEO Status");
    expect(html).toContain("BK Decisions");
    expect(html).toContain("Review risky plan");
    expect(html).toContain("Active Work");
    expect(html).toContain("Implement dashboard review");
    expect(html).toContain("Blockers");
    expect(html).toContain("Verify dashboard");
    expect(html).toContain("Risks");
    expect(html).toContain("Dispatch behavior could change.");
    expect(html).toContain("Next Safe Action");
    expect(html).toContain("Resolve the pending BK decision");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});
