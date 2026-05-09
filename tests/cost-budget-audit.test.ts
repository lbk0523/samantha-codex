import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CostBudgetAuditStore,
  createCostBudgetAuditRecord,
  createRunCostBudgetObservation,
  summarizeCostBudgetAuditRecords,
  type CostBudgetAuditRecord,
} from "../src/lib/cost-budget-audit";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import type { RunSummary } from "../src/lib/ledger";
import { createRemoteDispatchAction } from "../src/lib/remote-action-store";

let tmpRoots: string[] = [];

async function makeStore(): Promise<{ path: string; store: CostBudgetAuditStore }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-budget-audit-"));
  tmpRoots.push(root);
  const path = join(root, "state", "budget-audit.jsonl");
  return { path, store: new CostBudgetAuditStore(path) };
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
});
