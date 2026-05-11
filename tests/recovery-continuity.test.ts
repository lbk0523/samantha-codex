import { describe, expect, test } from "bun:test";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import type { RemoteActionRecord } from "../src/lib/remote-action-store";
import { recoveryResolvedPlanIds } from "../src/lib/recovery-continuity";

const failedRequest: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-failed",
  source: "remote",
  text: "Original request",
  status: "planned",
  createdAt: "2026-05-07T10:00:00.000Z",
};

const recoveryRequest: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-recovery",
  source: "remote",
  text: "Recovery request",
  status: "planned",
  createdAt: "2026-05-07T10:20:00.000Z",
  recoveryOfPlanId: "plan-failed",
};

const failedPlan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-failed",
  requestId: failedRequest.id,
  status: "materialized",
  createdAt: "2026-05-07T10:01:00.000Z",
  resultReportedAt: "2026-05-07T10:10:00.000Z",
  actionIds: ["action-failed"],
  synthesis: {
    outcome: "failed",
    summary: "failed",
    nextActions: ["recover"],
    risks: [],
    userMessage: "failed",
  },
};

const recoveryPlan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-recovery",
  requestId: recoveryRequest.id,
  status: "materialized",
  createdAt: "2026-05-07T10:21:00.000Z",
  resultReportedAt: "2026-05-07T10:30:00.000Z",
  actionIds: ["action-recovery"],
  synthesis: {
    outcome: "pass",
    summary: "fixed",
    nextActions: [],
    risks: [],
    userMessage: "fixed",
  },
};

const passedRecoveryAction: RemoteActionRecord = {
  schemaVersion: 1,
  id: "action-recovery",
  kind: "dispatch_task",
  status: "completed",
  createdAt: "2026-05-07T10:22:00.000Z",
  completedAt: "2026-05-07T10:29:00.000Z",
  source: "remote",
  taskId: "task-recovery",
  taskTitle: "Recovery",
  targetAgent: "codex-worker",
  repoRoot: "/repo/samantha-codex",
  allocate: true,
  execute: true,
  liveLog: true,
  result: { pass: true, outcome: "pass" },
};

describe("recoveryResolvedPlanIds", () => {
  test("marks original failed plans resolved only after linked recovery passes", () => {
    expect(
      recoveryResolvedPlanIds({
        requests: [failedRequest, recoveryRequest],
        plans: [failedPlan, recoveryPlan],
        actions: [passedRecoveryAction],
      }),
    ).toEqual(new Set(["plan-failed"]));

    expect(
      recoveryResolvedPlanIds({
        requests: [failedRequest, recoveryRequest],
        plans: [{ ...failedPlan }, { ...recoveryPlan, synthesis: { ...recoveryPlan.synthesis!, outcome: "failed" } }],
        actions: [passedRecoveryAction],
      }),
    ).toEqual(new Set());
  });
});
