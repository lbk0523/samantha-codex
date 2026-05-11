import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildBackupManifest,
  validateHostMigration,
  validateRestore,
} from "../src/lib/backup-restore";
import { DEFAULT_SAFETY_POLICY } from "../src/lib/policy";
import {
  buildNotificationThrottleKey,
  classifyNotificationUrgency,
  notificationDigestWindow,
} from "../src/lib/ceo-report-store";
import type { CeoStatusSnapshot } from "../src/lib/ceo-status";
import {
  createBudgetPolicyRecord,
  createCostBudgetAuditRecord,
} from "../src/lib/cost-budget-audit";
import { createDecisionItem } from "../src/lib/decision-store";
import { createGovernanceEvent } from "../src/lib/governance-event-store";
import { collectOpsSnapshot } from "../src/lib/ops-diagnostics";
import { buildQueuePressureSnapshot, decideQueueAdmission } from "../src/lib/queue-pressure";
import {
  buildRoutineTriggerFingerprint,
  createRoutineTriggerObservation,
  createRoutineTriggerRecord,
  routineObservationToOrchestrationRequest,
} from "../src/lib/routine-trigger-store";

let tmpRoots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeHostOwnership(path: string, hostId: string, role: "active_automation_host" | "client_machine" = "active_automation_host"): Promise<void> {
  await writeJson(path, {
    schemaVersion: 1,
    role,
    hostId,
    updatedAt: "2026-05-10T03:00:00.000Z",
  });
}

function approvedBudgetPolicy() {
  const policy = createBudgetPolicyRecord({
    id: "budget-policy-phase-9-exit",
    createdAt: "2026-05-10T03:00:00.000Z",
    status: "active",
    scope: { type: "project", id: "samantha" },
    thresholds: { currency: "USD", deferAtAmount: 1, blockAtAmount: 2, unknownCost: "defer" },
    governance: {
      decisionId: "decision-budget-phase-9-exit",
      governanceEventId: "gov-budget-phase-9-exit",
      approvedBy: "bk",
      approvedAt: "2026-05-10T03:01:00.000Z",
      summary: "BK approved the Phase 9 deterministic budget drill policy.",
    },
  });
  const decision = {
    ...createDecisionItem({
      kind: "budget_change",
      title: "Approve Phase 9 budget drill",
      prompt: "Approve deterministic budget enforcement for the Phase 9 exit drill.",
      source: "system",
      subject: { type: "budget", id: policy.id },
      options: ["approve", "reject"],
      createdAt: "2026-05-10T03:00:30.000Z",
    }),
    id: "decision-budget-phase-9-exit",
    status: "resolved" as const,
    resolution: "approved" as const,
    resolvedBy: "bk" as const,
    resolvedAt: "2026-05-10T03:01:00.000Z",
    updatedAt: "2026-05-10T03:01:00.000Z",
  };
  const event = createGovernanceEvent({
    id: "gov-budget-phase-9-exit",
    timestamp: "2026-05-10T03:01:00.000Z",
    actor: "bk",
    source: { kind: "decision", id: decision.id },
    subject: { type: "budget", id: policy.id },
    kind: "transition_approved",
    riskClass: "high",
    summary: "Budget policy approved for deterministic enforcement.",
    related: { decisionIds: [decision.id] },
  });
  return { policy, decision, event };
}

function snapshot(input: Partial<CeoStatusSnapshot> = {}): CeoStatusSnapshot {
  return {
    generatedAt: "2026-05-10T03:00:00.000Z",
    overall: "idle",
    completed: [],
    active: [],
    blocked: [],
    historicalFailures: [],
    needsDecision: [],
    risks: [],
    nextAction: {
      kind: "none",
      label: "No immediate action",
      reason: "Idle.",
    },
    ...input,
  };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("Phase 9 continuous operations exit drill", () => {
  test("exercises watchdog, pressure, routine, notification, budget, backup, restore, and migration gates without authority expansion", async () => {
    const opsRoot = await makeRoot("samantha-codex-phase9-ops-");
    const ops = await collectOpsSnapshot({
      envFilePath: join(opsRoot, ".env"),
      inboxDir: join(opsRoot, "inbox"),
      outboxDir: join(opsRoot, "outbox"),
      heartbeatPath: join(opsRoot, "state", "heartbeat.json"),
      lockPath: join(opsRoot, "state", "daemon.lock"),
      telegramOffsetPath: join(opsRoot, "state", "telegram-offset.json"),
      telegramRepliesPath: join(opsRoot, "state", "telegram-replies.json"),
      env: {},
      now: new Date("2026-05-10T03:00:00.000Z"),
    });
    const unsafePressure = buildQueuePressureSnapshot({ ops });
    const unsafeRoutineAdmission = decideQueueAdmission({
      pressure: unsafePressure,
      subjectKind: "routine_trigger",
    });

    expect(ops.issues).toContainEqual(expect.objectContaining({ severity: "unsafe_to_continue", area: "host" }));
    expect(unsafeRoutineAdmission).toMatchObject({ decision: "block", reason: "unsafe host state=1" });

    const trigger = createRoutineTriggerRecord({
      triggerId: "daily-samantha-review",
      sourceKind: "schedule",
      projectId: "samantha",
      enabled: true,
      riskClass: "medium",
      sourceEvidence: ["docs/DAEMON_OPERATIONS.md continuous operation gates"],
      fingerprintInputs: [
        { key: "cadence", value: "daily" },
        { key: "intent", value: "review-open-work" },
      ],
      activationDecisionId: "decision-routine-activation",
      createdAt: "2026-05-10T03:00:00.000Z",
    });
    expect(trigger.fingerprint).toBe(buildRoutineTriggerFingerprint({
      triggerId: "daily-samantha-review",
      sourceKind: "schedule",
      projectId: "samantha",
      fingerprintInputs: [
        { key: "intent", value: "review-open-work" },
        { key: "cadence", value: "daily" },
      ],
    }));
    const acceptedObservation = createRoutineTriggerObservation({
      trigger,
      observedAt: "2026-05-10T03:02:00.000Z",
      admission: {
        schemaVersion: 1,
        decidedAt: "2026-05-10T03:02:00.000Z",
        subjectKind: "routine_trigger",
        decision: "accept",
        pressureClass: "normal",
        reason: "Phase 9 routine intake drill accepted.",
      },
    });
    const request = routineObservationToOrchestrationRequest({
      trigger,
      observation: acceptedObservation,
      requestId: "request-phase-9-routine",
      requestText: "Review open Samantha work and propose one bounded next step.",
    });
    const duplicateObservation = createRoutineTriggerObservation({
      trigger,
      observedAt: "2026-05-10T03:03:00.000Z",
      activeWork: { requests: [request!] },
    });

    expect(request).toMatchObject({
      status: "pending_plan",
      routineFingerprint: trigger.fingerprint,
      admission: { decision: "accept" },
    });
    expect(duplicateObservation.status).toBe("coalesced");
    expect(routineObservationToOrchestrationRequest({
      trigger,
      observation: duplicateObservation,
      requestText: "Duplicate routine intake should not create live work.",
    })).toBeUndefined();

    const lowRisk = snapshot();
    const urgent = snapshot({
      overall: "needs_decision",
      needsDecision: [{
        kind: "decision",
        id: "decision-plan",
        title: "Approve current plan",
        status: "pending",
        reason: "BK approval required.",
      }],
      nextAction: { kind: "resolve_decision", label: "Resolve decision", reason: "BK approval required." },
    });
    expect(classifyNotificationUrgency(lowRisk)).toEqual({ urgency: "low_risk", bypassReasons: [] });
    expect(notificationDigestWindow({ generatedAt: "2026-05-10T03:30:00.000Z" })).toEqual({
      startedAt: "2026-05-10T00:00:00.000Z",
      endsAt: "2026-05-10T06:00:00.000Z",
    });
    expect(buildNotificationThrottleKey(lowRisk)).toBe(buildNotificationThrottleKey(snapshot()));
    expect(classifyNotificationUrgency(urgent).bypassReasons).toContain("pending BK decisions=1");

    const { policy, decision, event } = approvedBudgetPolicy();
    const ancestry = { mode: "assigned" as const, projectId: "samantha", goalId: "goal-budget", workItemId: "work-budget" };
    const budgetDeferred = buildQueuePressureSnapshot({
      decisions: [decision],
      governanceEvents: [event],
      budgetPolicies: [policy],
      budgetObservations: [
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-10T03:04:00.000Z",
          actor: "samantha",
          subject: { type: "run", id: "run-unknown-cost" },
          cost: { kind: "unknown", reason: "provider cost unavailable" },
          context: { projectId: "samantha" },
        }),
      ],
    }, { projectId: "samantha" });
    const budgetBlocked = buildQueuePressureSnapshot({
      decisions: [decision],
      governanceEvents: [event],
      budgetPolicies: [policy],
      budgetObservations: [
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-10T03:05:00.000Z",
          actor: "operator",
          subject: { type: "action", id: "action-over-budget" },
          cost: { kind: "estimated", amount: 2.5, currency: "USD", basis: "manual estimate" },
          context: { projectId: "samantha" },
        }),
      ],
    }, { projectId: "samantha" });

    expect(budgetDeferred.budget?.state).toBe("defer");
    expect(decideQueueAdmission({ pressure: budgetDeferred, subjectKind: "action" }).decision).toBe("defer");
    expect(budgetBlocked.budget?.state).toBe("block");
    expect(decideQueueAdmission({ pressure: budgetBlocked, subjectKind: "request" }).decision).toBe("block");

    const restoreRoot = await makeRoot("samantha-codex-phase9-restore-");
    await writeHostOwnership(join(restoreRoot, "state", "host-ownership.json"), "new-host");
    await writeJson(join(restoreRoot, "references", "project-profiles", "samantha.json"), {
      schemaVersion: 1,
      id: "samantha",
      repoRoot: "$HOME/projects/samantha-codex",
      keywords: ["samantha"],
      setupCommands: ["bun install"],
      verifyCommands: ["bun typecheck"],
      forbiddenChanges: ["state/**"],
    });
    const manifest = await buildBackupManifest({
      root: restoreRoot,
      generatedAt: "2026-05-10T03:06:00.000Z",
    });
    const manifestPath = join(restoreRoot, "backup-manifest.json");
    await writeJson(manifestPath, manifest);
    const restore = await validateRestore({
      root: restoreRoot,
      manifestPath,
      currentHostId: "new-host",
      checkedAt: "2026-05-10T03:07:00.000Z",
    });
    expect(restore.ok).toBe(true);
    expect(restore.authority).toEqual({
      dispatch: false,
      approve: false,
      merge: false,
      push: false,
      cleanup: false,
      recover: false,
      rewriteHistory: false,
    });

    const oldHost = join(restoreRoot, "old-host-ownership.json");
    const newHost = join(restoreRoot, "new-host-ownership.json");
    await writeHostOwnership(oldHost, "old-host");
    await writeHostOwnership(newHost, "new-host");
    expect((await validateHostMigration({
      oldHostOwnershipPath: oldHost,
      newHostOwnershipPath: newHost,
      targetHostId: "new-host",
      checkedAt: "2026-05-10T03:08:00.000Z",
    })).issues).toContainEqual(expect.objectContaining({ code: "active_active_host" }));
    await writeHostOwnership(oldHost, "old-host", "client_machine");
    expect((await validateHostMigration({
      oldHostOwnershipPath: oldHost,
      newHostOwnershipPath: newHost,
      targetHostId: "new-host",
      checkedAt: "2026-05-10T03:09:00.000Z",
    })).ok).toBe(true);

    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
  });
});
