import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDecisionItem,
  decisionAllowsOrchestratorMaterialization,
  decisionLifecycleStatus,
  decisionFromQuestionDraft,
  decisionFromOrchestratorPlan,
  DecisionStore,
  type DecisionItem,
} from "../src/lib/decision-store";
import type { OrchestratorPlanRecord } from "../src/lib/orchestrator-store";

let tmpRoots: string[] = [];

async function makeStore(): Promise<DecisionStore> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-decisions-"));
  tmpRoots.push(root);
  return new DecisionStore(join(root, "state", "decisions.jsonl"));
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

const decision: DecisionItem = createDecisionItem({
  title: "Review risky plan",
  prompt: "Approve the plan before materialization.",
  kind: "risk_acceptance",
  source: "system",
  subject: { type: "orchestrator_plan", id: "plan-1" },
  options: ["approve", "revise", "cancel"],
  risk: "Touches dispatch gates.",
  createdAt: "2026-05-07T10:00:00.000Z",
});

const plan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-1",
  requestId: "request-1",
  status: "planned",
  createdAt: "2026-05-07T09:00:00.000Z",
  completedAt: "2026-05-07T09:01:00.000Z",
  payload: {
    summary: "Risky dispatch plan",
    assumptions: [],
    questions: [],
    scope: ["dispatch gate"],
    nonScope: [],
    risks: ["Dispatch behavior could change."],
    tasks: [],
    batches: [],
    userMessage: "Plan ready.",
  },
};

describe("DecisionStore", () => {
  test("creates, lists, resolves, and archives decision items", async () => {
    const store = await makeStore();

    await store.append(decision);
    await expect(store.append(decision)).rejects.toThrow("decision already exists");
    expect(await store.list()).toEqual([decision]);
    expect(await store.listPending()).toEqual([decision]);
    expect(await store.latestForSubject({ type: "orchestrator_plan", id: "plan-1" })).toEqual(decision);

    const resolved = await store.resolve(decision.id, {
      resolvedAt: "2026-05-07T10:05:00.000Z",
      resolution: "approved",
      note: "Proceed.",
    });
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "approved",
      resolvedBy: "bk",
      resolutionNote: "Proceed.",
      updatedAt: "2026-05-07T10:05:00.000Z",
    });
    expect(await store.listPending()).toEqual([]);
    await expect(store.resolve(decision.id, {
      resolvedAt: "2026-05-07T10:06:00.000Z",
      resolution: "approved",
    })).rejects.toThrow("decision must be pending");
    expect(decisionLifecycleStatus(resolved)).toBe("approved");

    const archived = await store.archive(decision.id, {
      archivedAt: "2026-05-07T10:07:00.000Z",
      reason: "No longer active.",
    });
    expect(archived).toMatchObject({
      status: "archived",
      archiveReason: "No longer active.",
      updatedAt: "2026-05-07T10:07:00.000Z",
    });
    expect(await store.latestForSubject({ type: "orchestrator_plan", id: "plan-1" })).toBeUndefined();
    await expect(
      store.archive(decision.id, {
        archivedAt: "2026-05-07T10:08:00.000Z",
        reason: "Already archived.",
      }),
    ).rejects.toThrow("decision already archived");
  });

  test("approves and rejects the latest pending decision deterministically", async () => {
    const store = await makeStore();
    const older = createDecisionItem({
      ...decision,
      title: "Review older plan",
      subject: { type: "orchestrator_plan", id: "plan-older" },
      createdAt: "2026-05-07T10:01:00.000Z",
    });
    const newer = createDecisionItem({
      ...decision,
      title: "Review newer plan",
      subject: { type: "orchestrator_plan", id: "plan-newer" },
      createdAt: "2026-05-07T10:02:00.000Z",
    });

    await store.append(older);
    await store.append(newer);

    const approved = await store.resolveLatestPending({
      resolvedAt: "2026-05-07T10:03:00.000Z",
      resolution: "approved",
    });
    expect(approved).toMatchObject({ id: newer.id, status: "resolved", resolution: "approved" });
    expect((await store.listPending()).map((item) => item.id)).toEqual([older.id]);

    const rejected = await store.resolveLatestPending({
      resolvedAt: "2026-05-07T10:04:00.000Z",
      resolution: "rejected",
    });
    expect(rejected).toMatchObject({ id: older.id, status: "resolved", resolution: "rejected" });
    expect(await store.resolveLatestPending({ resolvedAt: "2026-05-07T10:05:00.000Z", resolution: "approved" })).toBeUndefined();
  });

  test("derives deterministic pending decisions from planned and question orchestrator plans", () => {
    const planned = decisionFromOrchestratorPlan({
      plan,
      createdAt: "2026-05-07T09:02:00.000Z",
    });
    const questions = decisionFromOrchestratorPlan({
      plan: {
        ...plan,
        id: "plan-questions",
        status: "questions",
        payload: {
          ...plan.payload!,
          questions: ["Which files are in scope?"],
        },
      },
      createdAt: "2026-05-07T09:03:00.000Z",
    });

    expect(planned).toMatchObject({
      kind: "orchestrator_plan_approval",
      status: "pending",
      subject: { type: "orchestrator_plan", id: "plan-1" },
      risk: "Dispatch behavior could change.",
    });
    expect(questions).toMatchObject({
      kind: "orchestrator_questions",
      prompt: "Which files are in scope?",
      options: ["answer", "revise", "cancel"],
    });
  });

  test("only resolved approved decisions allow orchestrator materialization", () => {
    expect(decisionAllowsOrchestratorMaterialization(undefined)).toBe(false);
    expect(decisionAllowsOrchestratorMaterialization(decision)).toBe(false);
    expect(decisionAllowsOrchestratorMaterialization({
      ...decision,
      status: "resolved",
      resolution: "needs_revision",
      resolvedAt: "2026-05-07T10:05:00.000Z",
      resolvedBy: "bk",
    })).toBe(false);
    expect(decisionAllowsOrchestratorMaterialization({
      ...decision,
      status: "resolved",
      resolution: "approved",
      resolvedAt: "2026-05-07T10:05:00.000Z",
      resolvedBy: "bk",
    })).toBe(true);
  });

  test("converts bounded question drafts into pending blocker decisions", () => {
    const created = decisionFromQuestionDraft({
      payload: {
        title: "Clarify blocker",
        prompt: "Should Samantha recover or wait?",
        options: ["recover", "wait"],
        risk: "Wrong recovery may waste a worker run.",
        userMessage: "BK decision required.",
      },
      subject: { type: "run", id: "run-1" },
      createdAt: "2026-05-07T10:08:00.000Z",
    });

    expect(created).toMatchObject({
      status: "pending",
      kind: "blocker_clarification",
      title: "Clarify blocker",
      prompt: "Should Samantha recover or wait?",
      options: ["recover", "wait"],
      subject: { type: "run", id: "run-1" },
      risk: "Wrong recovery may waste a worker run.",
    });
  });
});
