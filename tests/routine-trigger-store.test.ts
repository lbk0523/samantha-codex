import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSpec } from "../src/lib/contracts";
import { createDecisionItem, type DecisionItem } from "../src/lib/decision-store";
import { createGovernanceEvent } from "../src/lib/governance-event-store";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import type { RemoteActionRecord } from "../src/lib/remote-action-store";
import {
  RoutineTriggerObservationStore,
  RoutineTriggerStore,
  buildRoutineTriggerFingerprint,
  createRoutineTriggerObservation,
  createRoutineTriggerRecord,
  findRoutineFingerprintMatches,
  routineObservationToOrchestrationRequest,
  routineActivationPolicy,
} from "../src/lib/routine-trigger-store";

let tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

function triggerFixture(input: Partial<Parameters<typeof createRoutineTriggerRecord>[0]> = {}) {
  return createRoutineTriggerRecord({
    triggerId: "daily-samantha-review",
    sourceKind: "schedule",
    projectId: "samantha",
    enabled: true,
    riskClass: "medium",
    sourceEvidence: ["docs/CONTINUOUS_24_7_OPERATIONS.md M5"],
    fingerprintInputs: [
      { key: "cadence", value: "daily" },
      { key: "intent", value: "review-open-work" },
    ],
    activationDecisionId: "decision-routine-activation",
    createdAt: "2026-05-10T01:00:00.000Z",
    ...input,
  });
}

describe("routine trigger contract", () => {
  test("creates deterministic intake-only routine records for schedule, webhook, and API sources", () => {
    const schedule = triggerFixture();
    const webhook = triggerFixture({
      triggerId: "github-review-webhook",
      sourceKind: "webhook",
      sourceEvidence: ["webhook:github.pull_request.review_requested"],
      fingerprintInputs: [
        { key: "event", value: "review_requested" },
        { key: "repo", value: "samantha-codex" },
      ],
    });
    const api = triggerFixture({
      triggerId: "manual-api-nudge",
      sourceKind: "api",
      sourceEvidence: ["api:v1/routine-triggers/manual-api-nudge"],
      fingerprintInputs: [{ key: "intent", value: "operator-nudge" }],
    });

    expect(schedule).toMatchObject({
      sourceKind: "schedule",
      enabled: true,
      authority: {
        dispatch: false,
        approve: false,
        merge: false,
        push: false,
        cleanup: false,
        recover: false,
        bypassProjectGates: false,
        expandConnectorAuthority: false,
        expandSecretAuthority: false,
      },
    });
    expect(webhook.fingerprint).toMatch(/^routine-fp-[0-9a-f]{16}$/);
    expect(api.projectId).toBe("samantha");
    expect(() => triggerFixture({ authority: { dispatch: true } })).toThrow(
      "routine triggers are intake records only: authority.dispatch must be false",
    );
    expect(() => triggerFixture({ enabled: true, activationDecisionId: undefined })).toThrow(
      "enabled routine trigger requires activationDecisionId",
    );
    expect(() => triggerFixture({ sourceEvidence: [] })).toThrow("sourceEvidence is required");
  });

  test("builds stable fingerprints from canonical inputs instead of input order", () => {
    const left = buildRoutineTriggerFingerprint({
      triggerId: "daily-samantha-review",
      sourceKind: "schedule",
      projectId: "samantha",
      fingerprintInputs: [
        { key: "intent", value: "review-open-work" },
        { key: "cadence", value: "daily" },
      ],
    });
    const right = triggerFixture().fingerprint;

    expect(left).toBe(right);
    expect(() =>
      triggerFixture({
        fingerprintInputs: [
          { key: "intent", value: "one" },
          { key: "intent", value: "two" },
        ],
      }),
    ).toThrow("duplicate fingerprint input key: intent");
  });

  test("coalesces duplicate fingerprints across active requests, plans, tasks, actions, and decisions", () => {
    const trigger = triggerFixture();
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: "request-active",
      source: "local",
      text: "Routine-created request.",
      status: "pending_plan",
      createdAt: "2026-05-10T01:01:00.000Z",
      routineTriggerId: trigger.triggerId,
      routineFingerprint: trigger.fingerprint,
    };
    const discardedRequest: OrchestrationRequestRecord = {
      ...request,
      id: "request-discarded",
      status: "discarded",
    };
    const plan: OrchestratorPlanRecord = {
      schemaVersion: 1,
      id: "plan-active",
      requestId: request.id,
      status: "questions",
      createdAt: "2026-05-10T01:02:00.000Z",
      routineTriggerId: trigger.triggerId,
      routineFingerprint: trigger.fingerprint,
    };
    const task: TaskSpec = {
      id: "task-active",
      title: "Routine active task",
      targetAgent: "codex-worker",
      targetFiles: ["src/lib/routine-trigger-store.ts"],
      forbiddenChanges: ["state/**"],
      verifyCommands: ["bun test tests/routine-trigger-store.test.ts"],
      instructions: "Fixture.",
      status: "pending",
      routineTriggerId: trigger.triggerId,
      routineFingerprint: trigger.fingerprint,
    };
    const completedTask: TaskSpec = { ...task, id: "task-completed", status: "completed" };
    const action: RemoteActionRecord = {
      schemaVersion: 1,
      id: "action-active",
      kind: "dispatch_task",
      status: "approved",
      createdAt: "2026-05-10T01:03:00.000Z",
      source: "local",
      taskId: task.id,
      taskTitle: task.title,
      targetAgent: task.targetAgent,
      repoRoot: ".",
      allocate: true,
      execute: true,
      tmux: true,
      routineTriggerId: trigger.triggerId,
      routineFingerprint: trigger.fingerprint,
    };
    const decision: DecisionItem = {
      ...createDecisionItem({
        title: "Routine question",
        prompt: "Resolve routine blocker.",
        source: "system",
        subject: { type: "routine", id: trigger.id },
        createdAt: "2026-05-10T01:04:00.000Z",
      }),
      routineTriggerId: trigger.triggerId,
      routineFingerprint: trigger.fingerprint,
    };

    const matches = findRoutineFingerprintMatches({
      fingerprint: trigger.fingerprint,
      requests: [request, discardedRequest],
      plans: [plan, { ...plan, id: "plan-canceled", status: "canceled" }],
      tasks: [task, completedTask],
      actions: [action, { ...action, id: "action-completed", status: "completed" }],
      decisions: [decision, { ...decision, id: "decision-resolved", status: "resolved" }],
    });
    const observation = createRoutineTriggerObservation({
      trigger,
      observedAt: "2026-05-10T01:05:00.000Z",
      activeWork: {
        requests: [request, discardedRequest],
        plans: [plan],
        tasks: [task, completedTask],
        actions: [action],
        decisions: [decision],
      },
    });

    expect(matches.map((match) => `${match.kind}:${match.id}`)).toEqual([
      "action:action-active",
      `decision:${decision.id}`,
      "plan:plan-active",
      "request:request-active",
      "task:task-active",
    ]);
    expect(observation.status).toBe("coalesced");
    expect(observation.coalescedWith?.map((match) => match.id)).toContain("request-active");
    expect("requestId" in observation).toBe(false);
    expect("actionId" in observation).toBe(false);
  });

  test("records disabled and stale routine observations without enqueueing work", () => {
    const disabled = createRoutineTriggerObservation({
      trigger: triggerFixture({ enabled: false }),
      observedAt: "2026-05-10T01:05:00.000Z",
    });
    const stale = createRoutineTriggerObservation({
      trigger: triggerFixture({ staleAfter: "2026-05-10T01:04:59.000Z" }),
      observedAt: "2026-05-10T01:05:00.000Z",
    });
    const current = createRoutineTriggerObservation({
      trigger: triggerFixture({ staleAfter: "2026-05-10T01:05:01.000Z" }),
      observedAt: "2026-05-10T01:05:00.000Z",
    });

    expect(disabled.status).toBe("ignored_disabled");
    expect(stale.status).toBe("ignored_stale");
    expect(current.status).toBe("recorded");
    expect(disabled.coalescedWith).toBeUndefined();
    expect(stale.coalescedWith).toBeUndefined();
  });

  test("converts accepted recorded observations into one project-scoped orchestration request only", () => {
    const trigger = triggerFixture();
    const accepted = createRoutineTriggerObservation({
      trigger,
      observedAt: "2026-05-10T01:05:00.000Z",
      admission: {
        schemaVersion: 1,
        decidedAt: "2026-05-10T01:05:00.000Z",
        subjectKind: "routine_trigger",
        decision: "accept",
        pressureClass: "normal",
        reason: "routine intake accepted",
      },
    });
    const request = routineObservationToOrchestrationRequest({
      trigger,
      observation: accepted,
      requestId: "request-routine-review",
      requestText: "Review open Samantha work and propose the next bounded plan.",
      source: "local",
    });
    const coalesced = createRoutineTriggerObservation({
      trigger,
      observedAt: "2026-05-10T01:06:00.000Z",
      activeWork: { requests: [request!] },
    });
    const deferred = createRoutineTriggerObservation({
      trigger,
      observedAt: "2026-05-10T01:07:00.000Z",
      admission: {
        schemaVersion: 1,
        decidedAt: "2026-05-10T01:07:00.000Z",
        subjectKind: "routine_trigger",
        decision: "ask_bk",
        pressureClass: "needs_bk",
        reason: "pending BK decision outranks routine intake",
      },
    });

    expect(request).toMatchObject({
      id: "request-routine-review",
      status: "pending_plan",
      routineTriggerId: trigger.triggerId,
      routineFingerprint: trigger.fingerprint,
      ancestry: {
        mode: "assigned",
        projectId: "samantha",
        goalId: "goal-samantha-operations",
        workItemId: "request-routine-review",
      },
      admission: { decision: "accept", subjectKind: "routine_trigger" },
    });
    expect(coalesced.status).toBe("coalesced");
    expect(routineObservationToOrchestrationRequest({
      trigger,
      observation: coalesced,
      requestText: "Duplicate routine work.",
    })).toBeUndefined();
    expect(routineObservationToOrchestrationRequest({
      trigger,
      observation: deferred,
      requestText: "Deferred routine work.",
    })).toBeUndefined();
  });

  test("persists routine triggers and observations as append-only intake records", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-routine-triggers-"));
    tmpRoots.push(root);
    const triggerPath = join(root, "routine-triggers.jsonl");
    const observationPath = join(root, "routine-trigger-observations.jsonl");
    const triggerStore = new RoutineTriggerStore(triggerPath);
    const observationStore = new RoutineTriggerObservationStore(observationPath);
    const trigger = triggerFixture();

    await triggerStore.append(trigger);
    await expect(triggerStore.append(trigger)).rejects.toThrow("routine trigger already exists");
    const observation = await observationStore.observe({
      trigger,
      observedAt: "2026-05-10T01:05:00.000Z",
    });

    expect(await triggerStore.list()).toEqual([trigger]);
    expect(await observationStore.list()).toEqual([observation]);
    expect((await readFile(observationPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("requires governed BK approval evidence before routine activation can proceed", () => {
    const trigger = triggerFixture();
    const pending = routineActivationPolicy({ routine: trigger });
    const approval = {
      ...createDecisionItem({
        kind: "routine_change",
        title: "Activate routine",
        prompt: "Approve this behavior-changing routine activation.",
        options: ["approve", "reject"],
        source: "system",
        subject: { type: "routine", id: trigger.id },
        createdAt: "2026-05-10T01:10:00.000Z",
      }),
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedAt: "2026-05-10T01:11:00.000Z",
      resolvedBy: "bk" as const,
    };
    const approved = routineActivationPolicy({ routine: trigger, approvalEvidence: [approval] });
    const event = createGovernanceEvent({
      timestamp: "2026-05-10T01:12:00.000Z",
      actor: "deterministic_operator",
      source: { kind: "routine_trigger", id: trigger.id },
      subject: { type: "routine", id: trigger.id },
      kind: "transition_requested",
      riskClass: "high",
      summary: "Routine activation requires governed BK approval before behavior changes.",
      related: { decisionIds: [approval.id] },
    });

    expect(pending.mayProceed).toBe(false);
    expect(pending.blockedReason).toContain("approved BK decision evidence is required for high routine.activate");
    expect(approved.mayProceed).toBe(true);
    expect(event.source).toEqual({ kind: "routine_trigger", id: trigger.id });
    expect(event.subject).toEqual({ type: "routine", id: trigger.id });
  });
});
