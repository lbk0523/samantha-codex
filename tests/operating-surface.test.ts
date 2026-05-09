import { describe, expect, test } from "bun:test";
import type { CeoStatusSnapshot } from "../src/lib/ceo-status";
import { buildOperatingSurfaceView } from "../src/lib/operating-surface";
import { ceoNotificationReport } from "../src/lib/operator-reports";

const decisionStatus: CeoStatusSnapshot = {
  generatedAt: "2026-05-08T09:00:00.000Z",
  overall: "needs_decision",
  completed: [],
  active: [
    {
      kind: "action",
      id: "action-20260508-dashboard-review-abc12345",
      title: "Refresh dashboard review",
      status: "running",
      detail: "task=task-20260508-dashboard-review-def67890",
    },
  ],
  blocked: [],
  historicalFailures: [],
  needsDecision: [
    {
      kind: "decision",
      id: "decision-20260508-plan-abc12345",
      title: "Review plan: Dashboard review consolidation",
      status: "pending",
      reason: "Approve before materialization.",
      options: ["approve", "revise", "cancel"],
      subject: "orchestrator_plan:plan-20260508-work-def67890",
    },
  ],
  risks: ["Plan must not expose action-20260508-dashboard-review-abc12345 in Telegram."],
  nextAction: {
    kind: "resolve_decision",
    label: "Resolve the latest pending BK decision",
    command: "bun run samantha decisions:approve-latest",
    targetId: "decision-20260508-plan-abc12345",
    reason: "Approve before materialization.",
  },
};

describe("operating surface view", () => {
  test("keeps routine display text separate from audit refs", () => {
    const view = buildOperatingSurfaceView(decisionStatus);

    expect(view.primaryAction.kind).toBe(decisionStatus.nextAction.kind);
    expect(view.primaryAction.telegramCommand).toBe("/approve");
    expect(view.primaryAction.localCommand).toBe("bun run samantha decisions:approve-latest");
    expect(view.primaryAction.auditRef).toBe("resolve_decision:decision-20260508-plan-abc12345");
    expect(view.sections.needsDecision[0]).toMatchObject({
      text: "Review plan: Dashboard review consolidation (pending) - Approve before materialization.",
      auditRef: "decision:decision-20260508-plan-abc12345",
    });
    expect(view.sections.needsDecision[0]?.text).not.toContain("decision-20260508");
    expect(view.sections.active[0]?.text).not.toContain("action-20260508");
    expect(view.summary).toBe("decisions=1 active=1 blocked=0 historical_failures=0 completed=0 risks=1");
  });

  test("compact CEO notifications use the shared primary Telegram command", () => {
    const view = buildOperatingSurfaceView(decisionStatus);
    const report = ceoNotificationReport(decisionStatus);

    expect(report).toContain(`텔레그램: \`${view.primaryAction.telegramCommand}\``);
    expect(report).toContain("핵심: BK decision is the current operating blocker.");
    expect(report).not.toContain("decision-20260508");
    expect(report).not.toContain("action-20260508");
    expect(report).not.toContain("bun run");
  });

  test("does not infer approval from a review-plan title alone", () => {
    const snapshot: CeoStatusSnapshot = {
      ...decisionStatus,
      needsDecision: [
        {
          ...decisionStatus.needsDecision[0],
          id: "decision-20260508-manual-abc12345",
          title: "Review plan: Manual risk exception",
          options: ["revise", "cancel"],
          subject: "manual:manual-risk",
        },
      ],
      nextAction: {
        ...decisionStatus.nextAction,
        command: "bun run samantha decisions:list --pending",
        targetId: "decision-20260508-manual-abc12345",
      },
    };

    const view = buildOperatingSurfaceView(snapshot);

    expect(view.primaryAction.telegramCommand).toBe("/now");
  });

  test("uses id-free Telegram guidance for blocker clarifications", () => {
    const snapshot: CeoStatusSnapshot = {
      ...decisionStatus,
      needsDecision: [
        {
          kind: "decision",
          id: "decision-20260508-blocker-abc12345",
          title: "Clarify run blocker",
          status: "pending",
          reason: "Should Samantha recover or wait?",
          decisionKind: "blocker_clarification",
          options: ["recover", "wait", "cancel"],
          subject: "run:run-20260508-failed-def67890",
        },
      ],
      nextAction: {
        kind: "resolve_decision",
        label: "Answer the latest blocker clarification",
        command: "bun run samantha decisions:resolve decision-20260508-blocker-abc12345 --resolution=answered --note=<answer>",
        targetId: "decision-20260508-blocker-abc12345",
        reason: "Should Samantha recover or wait?",
      },
    };

    const view = buildOperatingSurfaceView(snapshot);
    const report = ceoNotificationReport(snapshot);

    expect(view.primaryAction.telegramCommand).toBe("/answer <답변>");
    expect(view.primaryAction.localCommand).toContain("decisions:resolve decision-20260508-blocker-abc12345");
    expect(report).toContain("텔레그램: `/answer <답변>`");
    expect(report).toContain("계획 변경 필요 시: `/revise <피드백>`");
    expect(report).toContain("취소: `/cancel`");
    expect(report).not.toContain("decision-20260508");
    expect(report).not.toContain("bun run");
  });
});
