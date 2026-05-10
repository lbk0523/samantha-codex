import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CostBudgetAuditStore,
  BudgetPolicyStore,
  createCostBudgetAuditRecord,
  createBudgetPolicyRecord,
  createRunCostBudgetObservation,
  evaluateBudgetEnforcement,
  summarizeCostBudgetAuditRollups,
  summarizeCostBudgetAuditRecords,
  validateBudgetPolicyGovernance,
  type CostBudgetAuditRecord,
} from "../src/lib/cost-budget-audit";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { createDecisionItem } from "../src/lib/decision-store";
import { createGovernanceEvent } from "../src/lib/governance-event-store";
import type { RunSummary } from "../src/lib/ledger";
import { createRemoteDispatchAction } from "../src/lib/remote-action-store";

let tmpRoots: string[] = [];

async function makeStore(): Promise<{ path: string; store: CostBudgetAuditStore }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-budget-audit-"));
  tmpRoots.push(root);
  const path = join(root, "state", "budget-audit.jsonl");
  return { path, store: new CostBudgetAuditStore(path) };
}

async function makePolicyStore(): Promise<{ path: string; store: BudgetPolicyStore }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-budget-policy-"));
  tmpRoots.push(root);
  const path = join(root, "state", "budget-policies.jsonl");
  return { path, store: new BudgetPolicyStore(path) };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

const run: RunSummary = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "task-1",
  taskTitle: "Budget hook task",
  agentId: "codex-worker",
  repoRoot: "/repo",
  worktreePath: "/worktree",
  logPath: "/runs/run-1.json",
  startedAt: "2026-05-09T01:00:00.000Z",
  finishedAt: "2026-05-09T01:02:00.000Z",
  outcome: "pass",
  pass: true,
  commit: "abcdef1234567890",
};

const task: TaskSpec = {
  id: "task-1",
  title: "Budget hook task",
  targetAgent: "codex-worker",
  projectId: "samantha",
  targetFiles: ["src/lib/cost-budget-audit.ts"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun test"],
  instructions: "Fixture.",
  status: "pending",
};

const agent: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: { requiredBundles: [], blockedSkills: [] },
};

const ancestry = {
  mode: "assigned" as const,
  projectId: "samantha",
  goalId: "goal-budget",
  workItemId: "work-budget",
};

function measuredZero(): CostBudgetAuditRecord {
  return createCostBudgetAuditRecord({
    observedAt: "2026-05-09T01:03:00.000Z",
    actor: "operator",
    subject: { type: "action", id: "action-1" },
    cost: {
      kind: "measured",
      amount: 0,
      currency: "usd",
      source: "provider receipt",
    },
    context: {
      actionId: "action-1",
      runId: "run-1",
      projectId: "samantha",
      model: "gpt-5.5",
      command: { executable: "codex", args: ["exec", "--model", "gpt-5.5"] },
    },
  });
}

describe("CostBudgetAuditStore", () => {
  test("records, retrieves, and filters run/action cost observations", async () => {
    const { path, store } = await makeStore();
    const action = createRemoteDispatchAction({
      task,
      repoRoot: "/repo",
      createdAt: "2026-05-09T01:00:00.000Z",
      source: "remote",
      commandId: "remote-1",
      orchestratorPlanId: "plan-1",
    });
    const unknown = createRunCostBudgetObservation({
      observedAt: "2026-05-09T01:02:00.000Z",
      run,
      task,
      agent,
      action,
      command: ["codex", "exec", "--model", "gpt-5.5", "long worker prompt"],
    });
    const zero = measuredZero();

    await store.append(unknown);
    const firstLine = (await readFile(path, "utf8")).trimEnd();
    await store.append(zero);

    const rawLines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(rawLines[0]).toBe(firstLine);
    expect(await store.load(unknown.id)).toEqual(unknown);
    expect(await store.list({ runId: "run-1" })).toEqual([unknown, zero]);
    expect(await store.list({ actionId: action.id })).toEqual([unknown]);
    expect(await store.list({ projectId: "samantha" })).toEqual([unknown, zero]);
    expect(await store.list({ model: "gpt-5.5" })).toEqual([unknown, zero]);
    expect(await store.list({ costKind: "unknown" })).toEqual([unknown]);
    expect(await store.list({ costKind: "measured" })).toEqual([zero]);
    expect(unknown.context?.command?.args).toEqual(["exec", "--model", "gpt-5.5"]);
  });

  test("keeps unknown cost distinct from measured zero", async () => {
    const unknown = createRunCostBudgetObservation({
      observedAt: "2026-05-09T01:02:00.000Z",
      run,
      task,
      agent,
    });
    const zero = measuredZero();
    const summary = summarizeCostBudgetAuditRecords([unknown, zero]);

    expect(unknown.cost.kind).toBe("unknown");
    expect("amount" in unknown.cost).toBe(false);
    expect(zero.cost).toMatchObject({ kind: "measured", amount: 0, currency: "USD" });
    expect(summary.unknown).toBe(1);
    expect(summary.measured).toBe(1);
    expect(summary.measuredTotals).toEqual([{ currency: "USD", amount: 0 }]);
  });

  test("filters budget observations by project and goal from ancestry, context, and subject", async () => {
    const { store } = await makeStore();
    const inherited = createRunCostBudgetObservation({
      observedAt: "2026-05-09T01:02:00.000Z",
      run: { ...run, ancestry },
      task: { ...task, ancestry },
      agent,
    });
    const contextOnly = createCostBudgetAuditRecord({
      observedAt: "2026-05-09T01:03:00.000Z",
      actor: "operator",
      subject: { type: "action", id: "action-context" },
      cost: { kind: "estimated", amount: 0.25, currency: "usd", basis: "manual estimate" },
      context: { projectId: "samantha", goalId: "goal-budget", workItemId: "work-budget", actionId: "action-context" },
    });
    const subjectOnly = createCostBudgetAuditRecord({
      observedAt: "2026-05-09T01:04:00.000Z",
      actor: "operator",
      subject: { type: "goal", id: "goal-budget" },
      cost: { kind: "measured", amount: 1.5, currency: "usd", source: "manual receipt" },
      context: { projectId: "samantha" },
    });
    const other = createCostBudgetAuditRecord({
      observedAt: "2026-05-09T01:05:00.000Z",
      actor: "operator",
      subject: { type: "project", id: "omht" },
      cost: { kind: "estimated", amount: 2, currency: "usd", basis: "manual estimate" },
      context: { goalId: "goal-omht" },
    });

    await store.append(inherited);
    await store.append(contextOnly);
    await store.append(subjectOnly);
    await store.append(other);

    expect(inherited.context).toMatchObject({
      projectId: "samantha",
      goalId: "goal-budget",
      workItemId: "work-budget",
    });
    expect(inherited.ancestry).toEqual(ancestry);
    expect(await store.list({ projectId: "samantha" })).toEqual([inherited, contextOnly, subjectOnly]);
    expect(await store.list({ goalId: "goal-budget" })).toEqual([inherited, contextOnly, subjectOnly]);
    expect(await store.list({ workItemId: "work-budget" })).toEqual([inherited, contextOnly]);
  });

  test("rolls up cost observations without treating unknown or missing data as zero", () => {
    const zero = createCostBudgetAuditRecord({
      ancestry,
      observedAt: "2026-05-09T01:03:00.000Z",
      actor: "operator",
      subject: { type: "run", id: "run-zero" },
      cost: { kind: "measured", amount: 0, currency: "USD", source: "provider receipt" },
      context: {
        projectId: "samantha",
        goalId: "goal-budget",
        workItemId: "work-budget",
        runId: "run-zero",
        actionId: "action-zero",
        model: "gpt-5.5",
        command: { executable: "codex", args: ["exec", "--model", "gpt-5.5"] },
      },
    });
    const estimated = createCostBudgetAuditRecord({
      ancestry,
      observedAt: "2026-05-09T01:04:00.000Z",
      actor: "operator",
      subject: { type: "action", id: "action-zero" },
      cost: { kind: "estimated", amount: 0.125, currency: "USD", basis: "manual token estimate" },
      context: {
        projectId: "samantha",
        goalId: "goal-budget",
        workItemId: "work-budget",
        actionId: "action-zero",
        model: "gpt-5.5",
        command: { executable: "codex", args: ["exec", "--model", "gpt-5.5"] },
      },
    });
    const unknownMissingAncestry = createCostBudgetAuditRecord({
      observedAt: "2026-05-09T01:05:00.000Z",
      actor: "samantha",
      subject: { type: "run", id: "run-unknown" },
      cost: { kind: "unknown", reason: "worker run did not report measured or estimated cost" },
      context: { runId: "run-unknown", model: "gpt-5.5" },
    });

    const rollups = summarizeCostBudgetAuditRollups([zero, estimated, unknownMissingAncestry]);

    expect(rollups.summary).toMatchObject({ total: 3, measured: 1, estimated: 1, unknown: 1 });
    expect(rollups.summary.measuredTotals).toEqual([{ currency: "USD", amount: 0 }]);
    expect(rollups.summary.estimatedTotals).toEqual([{ currency: "USD", amount: 0.125 }]);
    expect(rollups.gaps).toEqual([
      {
        recordId: unknownMissingAncestry.id,
        reasons: ["unknown_cost", "missing_ancestry", "missing_project", "missing_goal"],
      },
    ]);
    expect(rollups.rollups.project).toMatchObject([
      { key: "samantha", total: 2, measured: 1, estimated: 1, unknown: 0, auditGaps: 0 },
    ]);
    expect(rollups.rollups.goal).toMatchObject([
      { key: "goal-budget", total: 2, measured: 1, estimated: 1, unknown: 0, auditGaps: 0 },
    ]);
    expect(rollups.rollups.action).toMatchObject([
      { key: "action-zero", total: 2, measured: 1, estimated: 1, unknown: 0, auditGaps: 0 },
    ]);
    expect(rollups.rollups.run).toMatchObject([
      { key: "run-unknown", total: 1, measured: 0, estimated: 0, unknown: 1, auditGaps: 1 },
      { key: "run-zero", total: 1, measured: 1, estimated: 0, unknown: 0, auditGaps: 0 },
    ]);
    expect(rollups.rollups.model).toMatchObject([
      { key: "gpt-5.5", total: 3, measured: 1, estimated: 1, unknown: 1, auditGaps: 1 },
    ]);
    expect(rollups.rollups.command).toMatchObject([
      { key: "codex exec --model gpt-5.5", total: 2, measured: 1, estimated: 1, unknown: 0, auditGaps: 0 },
    ]);
  });

  test("rejects malformed unknown cost amounts instead of treating them as zero", async () => {
    const { path, store } = await makeStore();
    const malformed = createRunCostBudgetObservation({
      observedAt: "2026-05-09T01:02:00.000Z",
      run,
      task,
      agent,
    }) as unknown as Record<string, unknown>;
    malformed.cost = { kind: "unknown", amount: 0, reason: "missing provider data" };

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(malformed)}\n`, "utf8");

    await expect(store.list()).rejects.toThrow(
      "malformed cost budget audit record at line 1: unknown cost must not include amount",
    );
  });

  test("stores budget policy records for deterministic enforcement scopes", async () => {
    const { store } = await makePolicyStore();
    const policy = createBudgetPolicyRecord({
      id: "budget-policy-samantha",
      createdAt: "2026-05-10T01:00:00.000Z",
      status: "proposed",
      scope: { type: "project", id: "samantha" },
      thresholds: { currency: "usd", watchAtAmount: 1, deferAtAmount: 2, blockAtAmount: 3 },
      summary: "Project policy proposal.",
    });

    await store.append(policy);

    expect(await store.load(policy.id)).toEqual(policy);
    expect(policy.thresholds.currency).toBe("USD");
    await expect(store.load("budget-policy-missing")).rejects.toThrow("budget policy not found: budget-policy-missing");
  });

  test("requires explicit governance evidence before budget policy activation can enforce", () => {
    const policy = createBudgetPolicyRecord({
      id: "budget-policy-active",
      createdAt: "2026-05-10T01:00:00.000Z",
      status: "active",
      scope: { type: "project", id: "samantha" },
      thresholds: { currency: "USD", blockAtAmount: 1 },
      governance: {
        decisionId: "decision-budget-policy-active",
        governanceEventId: "gov-event-budget-policy-active",
        approvedBy: "bk",
        approvedAt: "2026-05-10T01:02:00.000Z",
        summary: "BK approved project budget policy activation.",
      },
    });
    const approved = {
      ...createDecisionItem({
        kind: "budget_change",
        title: "Activate Samantha budget policy",
        prompt: "Approve deterministic budget enforcement.",
        source: "system",
        subject: { type: "budget", id: policy.id },
        options: ["approve", "reject"],
        createdAt: "2026-05-10T01:01:00.000Z",
      }),
      id: "decision-budget-policy-active",
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedBy: "bk" as const,
      resolvedAt: "2026-05-10T01:02:00.000Z",
      updatedAt: "2026-05-10T01:02:00.000Z",
    };
    const event = createGovernanceEvent({
      id: "gov-event-budget-policy-active",
      timestamp: "2026-05-10T01:02:00.000Z",
      actor: "bk",
      source: { kind: "decision", id: approved.id },
      subject: { type: "budget", id: policy.id },
      kind: "transition_approved",
      riskClass: "high",
      summary: "Budget policy activation approved by BK.",
      related: { decisionIds: [approved.id] },
    });

    expect(validateBudgetPolicyGovernance({ policy })).toEqual([
      `budget policy ${policy.id} is missing approved BK budget_change decision evidence`,
      `budget policy ${policy.id} is missing transition_approved governance event evidence`,
    ]);
    expect(validateBudgetPolicyGovernance({ policy, decisions: [approved], governanceEvents: [event] })).toEqual([]);
    expect(evaluateBudgetEnforcement({
      policies: [policy],
      observations: [],
      context: { projectId: "samantha" },
    })).toMatchObject({ state: "needs_bk" });
  });

  test("enforces known and unknown project budget observations without treating unknown as zero", () => {
    const governance = {
      decisionId: "decision-budget-enforce",
      governanceEventId: "gov-event-budget-enforce",
      approvedBy: "bk" as const,
      approvedAt: "2026-05-10T01:02:00.000Z",
      summary: "BK approved deterministic project budget enforcement.",
    };
    const policy = createBudgetPolicyRecord({
      id: "budget-policy-enforce",
      createdAt: "2026-05-10T01:00:00.000Z",
      status: "active",
      scope: { type: "project", id: "samantha" },
      thresholds: { currency: "USD", watchAtAmount: 1, deferAtAmount: 2, blockAtAmount: 3, unknownCost: "defer" },
      governance,
    });
    const approved = {
      ...createDecisionItem({
        kind: "budget_change",
        title: "Activate budget policy",
        prompt: "Approve deterministic budget enforcement.",
        source: "system",
        subject: { type: "budget", id: policy.id },
        options: ["approve", "reject"],
        createdAt: "2026-05-10T01:01:00.000Z",
      }),
      id: governance.decisionId,
      status: "resolved" as const,
      resolution: "approved" as const,
      resolvedBy: "bk" as const,
      resolvedAt: governance.approvedAt,
      updatedAt: governance.approvedAt,
    };
    const event = createGovernanceEvent({
      id: governance.governanceEventId,
      timestamp: governance.approvedAt,
      actor: "bk",
      source: { kind: "decision", id: approved.id },
      subject: { type: "budget", id: policy.id },
      kind: "transition_approved",
      riskClass: "high",
      summary: "Budget policy activation approved by BK.",
      related: { decisionIds: [approved.id] },
    });
    const zero = createCostBudgetAuditRecord({
      ancestry,
      observedAt: "2026-05-10T01:03:00.000Z",
      actor: "operator",
      subject: { type: "run", id: "run-zero" },
      cost: { kind: "measured", amount: 0, currency: "USD", source: "receipt" },
      context: { projectId: "samantha", runId: "run-zero" },
    });
    const unknown = createCostBudgetAuditRecord({
      ancestry,
      observedAt: "2026-05-10T01:04:00.000Z",
      actor: "samantha",
      subject: { type: "run", id: "run-unknown" },
      cost: { kind: "unknown", reason: "provider cost missing" },
      context: { projectId: "samantha", runId: "run-unknown" },
    });
    const overLimit = createCostBudgetAuditRecord({
      ancestry,
      observedAt: "2026-05-10T01:05:00.000Z",
      actor: "operator",
      subject: { type: "action", id: "action-over" },
      cost: { kind: "estimated", amount: 3.5, currency: "USD", basis: "token estimate" },
      context: { projectId: "samantha", actionId: "action-over" },
    });

    const unknownDecision = evaluateBudgetEnforcement({
      policies: [policy],
      observations: [zero, unknown],
      context: { projectId: "samantha" },
      decisions: [approved],
      governanceEvents: [event],
    });
    const blockedDecision = evaluateBudgetEnforcement({
      policies: [policy],
      observations: [zero, overLimit],
      context: { projectId: "samantha" },
      decisions: [approved],
      governanceEvents: [event],
    });

    expect(unknownDecision.state).toBe("defer");
    expect(unknownDecision.reasons.join(" ")).toContain("unknown cost observations=1");
    expect(blockedDecision.state).toBe("block");
    expect(blockedDecision.reasons.join(" ")).toContain("reached block limit 3");
  });
});
