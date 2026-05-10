import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitHead } from "../src/lib/git";
import { evaluateWriterConcurrencySafety, type WriterConcurrencyCandidate } from "../src/lib/parallelism-conflict-detector";
import { createParallelismEvidenceRecord, type ParallelismEvidenceRecord } from "../src/lib/parallelism-evidence-store";
import { DEFAULT_SAFETY_POLICY } from "../src/lib/policy";
import { safetyPolicyCapabilityId, validateSafetyPolicyGovernance } from "../src/lib/profile-governance";
import type { DecisionItem } from "../src/lib/decision-store";
import type { SafetyPolicy } from "../src/lib/contracts";

let tmpRoots: string[] = [];

async function makeRepo(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-writer-conflict-"));
  tmpRoots.push(root);
  await git(["init", "-b", "main"], root);
  await git(["config", "user.email", "samantha@example.local"], root);
  await git(["config", "user.name", "Samantha Test"], root);
  await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: initial"], root);
  return { root, head: await gitHead(root) };
}

function candidate(input: Partial<WriterConcurrencyCandidate> & Pick<WriterConcurrencyCandidate, "taskId" | "repoRoot" | "baseCommit">): WriterConcurrencyCandidate {
  return {
    targetFiles: ["src/a.ts"],
    forbiddenChanges: ["state/**"],
    dependencies: [],
    ...input,
  };
}

function passingEvidence(): ParallelismEvidenceRecord {
  return createParallelismEvidenceRecord({
    observedAt: "2026-05-10T00:00:00.000Z",
    planId: "plan-parallelism-evidence",
    batches: [["task-review", "task-write"]],
    refs: [
      {
        taskId: "task-review",
        actionId: "action-review",
        runId: "run-review",
        runLogPath: "/runs/run-review.json",
        agentId: "codex-reviewer",
        agentRole: "reviewer",
        resultMode: "report",
        outcome: "pass",
        changedFiles: [],
      },
      {
        taskId: "task-write",
        actionId: "action-write",
        runId: "run-write",
        runLogPath: "/runs/run-write.json",
        agentId: "codex-worker",
        agentRole: "writer",
        resultMode: "write",
        outcome: "pass",
        changedFiles: ["src/existing.ts"],
      },
    ],
    verification: { pass: true, summary: "single writer plus report-only evidence passed" },
    mergeStatus: "completed",
    cleanupStatus: "completed",
    outcome: "pass",
  });
}

function approvedSafetyPolicyDecision(): DecisionItem {
  return {
    schemaVersion: 1,
    id: "decision-writer-cap",
    kind: "capability_change",
    title: "Approve writer cap change",
    prompt: "Approve safety policy writerCap change.",
    options: ["approve", "reject"],
    source: "local",
    status: "resolved",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:01:00.000Z",
    resolvedAt: "2026-05-10T00:01:00.000Z",
    resolvedBy: "bk",
    resolution: "approved",
    subject: { type: "policy", id: safetyPolicyCapabilityId() },
    risk: "high",
  };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("writer concurrency conflict detection", () => {
  test("marks overlapping writer target files unsafe", async () => {
    const { root, head } = await makeRepo();

    const result = await evaluateWriterConcurrencySafety({
      evaluatedAt: "2026-05-10T00:02:00.000Z",
      evidence: [passingEvidence()],
      candidates: [
        candidate({ taskId: "write-a", repoRoot: root, baseCommit: head, targetFiles: ["src/shared.ts"] }),
        candidate({ taskId: "write-b", repoRoot: root, baseCommit: head, targetFiles: ["src/shared.ts"] }),
      ],
    });

    expect(result.advisorySafe).toBe(false);
    expect(result.mayIncreaseWriterCap).toBe(false);
    expect(result.writerCap).toBe(1);
    expect(result.violations).toContain(
      `target repo ${root} has multiple writer candidates: write-a, write-b`,
    );
    expect(result.violations).toContain("writer candidates write-a and write-b overlap target files: src/shared.ts <-> src/shared.ts");
  });

  test("marks stale base commits and dirty target repos unsafe", async () => {
    const stale = await makeRepo();
    const dirty = await makeRepo();
    await writeFile(join(stale.root, "README.md"), "# changed\n", "utf8");
    await git(["add", "README.md"], stale.root);
    await git(["commit", "-m", "feat: move target head"], stale.root);
    await writeFile(join(dirty.root, "dirty.txt"), "dirty\n", "utf8");

    const result = await evaluateWriterConcurrencySafety({
      evaluatedAt: "2026-05-10T00:03:00.000Z",
      evidence: [passingEvidence()],
      candidates: [
        candidate({ taskId: "stale-write", repoRoot: stale.root, baseCommit: stale.head, targetFiles: ["src/stale.ts"] }),
        candidate({ taskId: "dirty-write", repoRoot: dirty.root, baseCommit: dirty.head, targetFiles: ["src/dirty.ts"] }),
      ],
    });

    expect(result.advisorySafe).toBe(false);
    expect(result.violations).toContain("task stale-write: target repo HEAD no longer matches candidate base commit");
    expect(result.violations).toContain("task dirty-write: target repo has uncommitted changes");
  });

  test("marks forbidden changes and unmerged writer dependencies unsafe", async () => {
    const { root, head } = await makeRepo();

    const result = await evaluateWriterConcurrencySafety({
      evaluatedAt: "2026-05-10T00:04:00.000Z",
      evidence: [passingEvidence()],
      candidates: [
        candidate({
          taskId: "write-config",
          repoRoot: root,
          baseCommit: head,
          targetFiles: ["state/secret.json"],
          forbiddenChanges: ["state/**"],
        }),
        candidate({
          taskId: "write-dependent",
          repoRoot: root,
          baseCommit: head,
          targetFiles: ["src/dependent.ts"],
          dependencies: ["write-config"],
        }),
      ],
    });

    expect(result.advisorySafe).toBe(false);
    expect(result.violations).toContain("task write-config: targetFiles entry is forbidden: state/secret.json matches state/**");
    expect(result.violations).toContain("task write-dependent: depends on unmerged writer output from write-config");
  });

  test("keeps disjoint writer candidates blocked when deterministic evidence is missing", async () => {
    const left = await makeRepo();
    const right = await makeRepo();

    const result = await evaluateWriterConcurrencySafety({
      evaluatedAt: "2026-05-10T00:05:00.000Z",
      candidates: [
        candidate({ taskId: "write-left", repoRoot: left.root, baseCommit: left.head, targetFiles: ["src/left.ts"] }),
        candidate({ taskId: "write-right", repoRoot: right.root, baseCommit: right.head, targetFiles: ["src/right.ts"] }),
      ],
    });

    expect(result.advisorySafe).toBe(false);
    expect(result.mayIncreaseWriterCap).toBe(false);
    expect(result.writerCap).toBe(DEFAULT_SAFETY_POLICY.writerCap);
    expect(result.violations).toEqual([
      "writer concurrency check is missing passing parallelism evidence; writerCap stays 1",
    ]);
  });

  test("stores conflict results as advisory evidence without approving writerCap expansion by itself", async () => {
    const left = await makeRepo();
    const right = await makeRepo();
    const conflictSafety = await evaluateWriterConcurrencySafety({
      evaluatedAt: "2026-05-10T00:06:00.000Z",
      evidence: [passingEvidence()],
      candidates: [
        candidate({ taskId: "write-left", repoRoot: left.root, baseCommit: left.head, targetFiles: ["src/left.ts"] }),
        candidate({ taskId: "write-right", repoRoot: right.root, baseCommit: right.head, targetFiles: ["src/right.ts"] }),
      ],
    });
    const record = createParallelismEvidenceRecord({
      observedAt: "2026-05-10T00:07:00.000Z",
      planId: "plan-conflict-detection",
      batches: [["task-review"]],
      refs: [
        {
          taskId: "task-review",
          actionId: "action-review",
          runId: "run-review",
          runLogPath: "/runs/run-review.json",
          agentId: "codex-reviewer",
          agentRole: "reviewer",
          resultMode: "report",
          outcome: "pass",
          changedFiles: [],
        },
      ],
      verification: { pass: true, summary: "conflict result recorded as advisory evidence" },
      mergeStatus: "not_applicable",
      cleanupStatus: "not_applicable",
      outcome: "pass",
      writerConflictSafety: conflictSafety,
    });
    const changedPolicy: SafetyPolicy = { ...DEFAULT_SAFETY_POLICY, writerCap: 2 };
    const governance = validateSafetyPolicyGovernance(changedPolicy, DEFAULT_SAFETY_POLICY, [
      approvedSafetyPolicyDecision(),
    ], { writerConflictSafety: conflictSafety });

    expect(conflictSafety.advisorySafe).toBe(true);
    expect(record.writerConflictSafety).toEqual(conflictSafety);
    expect(governance.ok).toBe(false);
    expect(governance.violations).toContain(
      "approved safety policy change is missing auditable diff: writerCap: 1 -> 2",
    );
    expect(governance.violations).toContain(
      "safety policy writerCap increase is missing complete dogfood evidence",
    );
    expect(governance.violations).toContain(
      "safety policy writerCap increase is missing merge and cleanup evidence",
    );
    expect(governance.violations).toContain(
      "safety policy writerCap increase is missing completed rollback drill evidence",
    );
    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
  });
});
