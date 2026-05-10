import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItemAncestry } from "../src/lib/ancestry";
import { createDecisionItem, type DecisionItem } from "../src/lib/decision-store";
import { GovernanceEventStore } from "../src/lib/governance-event-store";
import { GovernedMemoryStore, type GovernedMemoryRecord } from "../src/lib/memory-store";
import type { DurableMemoryEntry } from "../src/lib/memory-taxonomy";

let tmpRoots: string[] = [];

const ancestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "samantha",
  goalId: "goal-memory",
  workItemId: "work-item-m8",
};

async function makeStore(): Promise<{
  root: string;
  memoryPath: string;
  governancePath: string;
  store: GovernedMemoryStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-memory-store-"));
  tmpRoots.push(root);
  const memoryPath = join(root, "state", "memory.jsonl");
  const governancePath = join(root, "state", "governance-events.jsonl");
  return {
    root,
    memoryPath,
    governancePath,
    store: new GovernedMemoryStore(memoryPath, new GovernanceEventStore(governancePath)),
  };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

function memoryEntry(input: Partial<DurableMemoryEntry> = {}): DurableMemoryEntry {
  return {
    schemaVersion: 1,
    id: "memory-m8-context-rule",
    kind: "preference",
    claimKind: "operator_note",
    summary: "Keep memory writes deterministic and citation-backed.",
    ancestry,
    citations: [{ kind: "operator_report", id: "operator-report-m8", ancestry }],
    ...input,
  };
}

function approvalDecision(input: {
  memoryId: string;
  diffSummary: string;
  id?: string;
}): DecisionItem {
  return {
    ...createDecisionItem({
      kind: "memory_change",
      title: "Approve behavior-changing memory update",
      prompt: `Approve memory write. Diff: ${input.diffSummary}`,
      risk: "high",
      subject: { type: "memory", id: input.memoryId },
      createdAt: "2026-05-10T04:00:00.000Z",
    }),
    id: input.id ?? "decision-memory-change-approved",
    status: "resolved",
    updatedAt: "2026-05-10T04:01:00.000Z",
    resolvedAt: "2026-05-10T04:01:00.000Z",
    resolvedBy: "bk",
    resolution: "approved",
  };
}

async function governanceEvents(path: string): Promise<Array<{ kind: string; actor: string; summary: string; subject: { id: string }; related?: { decisionIds?: string[] } }>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("GovernedMemoryStore", () => {
  test("approves citation-backed memory writes with diff summary and append-only governance evidence", async () => {
    const { memoryPath, governancePath, store } = await makeStore();

    const result = await store.applyWrite({
      operation: "create",
      entry: memoryEntry(),
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:10:00.000Z",
      diffSummary: "Create source-backed preference memory.",
      source: { kind: "learning_candidate", id: "learning-candidate-m8" },
    });

    expect(result.status).toBe("approved");
    expect((result as { record: GovernedMemoryRecord }).record).toMatchObject({
      id: "memory-m8-context-rule",
      status: "active",
      operation: "create",
      actor: "deterministic_operator",
      riskClass: "medium",
      diffSummary: "Create source-backed preference memory.",
      citations: [{ kind: "operator_report", id: "operator-report-m8", ancestry }],
    });
    expect(await store.listActive()).toHaveLength(1);

    const rawMemory = await readFile(memoryPath, "utf8");
    expect(rawMemory.trim().split("\n")).toHaveLength(1);
    const events = await governanceEvents(governancePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "transition_approved",
      actor: "deterministic_operator",
      subject: { id: "memory-m8-context-rule" },
    });
    expect(events[0].summary).toContain("Create source-backed preference memory.");
  });

  test("blocks missing citations, missing diff summaries, and forbidden direct mutation actors", async () => {
    const { memoryPath, governancePath, store } = await makeStore();

    const noCitation = await store.applyWrite({
      operation: "create",
      entry: memoryEntry({ citations: [] }),
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:11:00.000Z",
      diffSummary: "Missing citation should block.",
      source: { kind: "learning_candidate", id: "learning-candidate-no-citation" },
    });
    const noDiff = await store.applyWrite({
      operation: "create",
      entry: memoryEntry({ id: "memory-no-diff" }),
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:12:00.000Z",
      diffSummary: "",
      source: { kind: "learning_candidate", id: "learning-candidate-no-diff" },
    });
    const llmWrite = await store.applyWrite({
      operation: "create",
      entry: memoryEntry({ id: "memory-llm-direct" }),
      actor: "llm",
      timestamp: "2026-05-10T04:13:00.000Z",
      diffSummary: "LLM attempts direct durable memory write.",
      source: { kind: "learning_candidate", id: "learning-candidate-llm" },
    });

    expect(noCitation.status).toBe("blocked");
    expect(noDiff.status).toBe("blocked");
    expect(llmWrite.status).toBe("blocked");
    expect((llmWrite as { violations: string[] }).violations).toContain(
      "llm cannot mutate durable memory; use a deterministic memory write gate",
    );
    await expect(readFile(memoryPath, "utf8")).rejects.toThrow("ENOENT");
    expect((await governanceEvents(governancePath)).map((event) => event.kind)).toEqual([
      "transition_blocked",
      "transition_blocked",
      "transition_blocked",
    ]);
  });

  test("requires explicit BK approval evidence for behavior-changing memory and SOP/skill writes", async () => {
    const { governancePath, store } = await makeStore();
    const diffSummary = "Change agent planning SOP preference.";
    const sop = memoryEntry({
      id: "memory-sop-planning",
      kind: "sop_document",
      summary: "Prefer behavior-changing SOP updates only after BK approval.",
    });

    const blocked = await store.applyWrite({
      operation: "create",
      entry: sop,
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:20:00.000Z",
      diffSummary,
      behaviorImpact: "behavior_change",
      source: { kind: "learning_candidate", id: "learning-candidate-sop" },
    });
    expect(blocked.status).toBe("blocked");
    expect((blocked as { violations: string[] }).violations).toContain(
      "behavior-changing memory and SOP/skill writes require an approved BK memory_change decision with the diff summary",
    );

    const approved = await store.applyWrite({
      operation: "create",
      entry: sop,
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:21:00.000Z",
      diffSummary,
      behaviorImpact: "behavior_change",
      source: { kind: "learning_candidate", id: "learning-candidate-sop" },
      approvalEvidence: [approvalDecision({ memoryId: sop.id, diffSummary })],
    });

    expect(approved.status).toBe("approved");
    expect((approved as { record: GovernedMemoryRecord }).record).toMatchObject({
      approvalDecisionId: "decision-memory-change-approved",
      behaviorImpact: "behavior_change",
      riskClass: "high",
      source: { kind: "decision", id: "decision-memory-change-approved" },
    });
    const events = await governanceEvents(governancePath);
    expect(events.at(-1)).toMatchObject({
      kind: "transition_approved",
      related: { decisionIds: ["decision-memory-change-approved"] },
    });

    const skill = memoryEntry({
      id: "memory-skill-review",
      kind: "skill_document",
      summary: "Skill documents remain methodology and require BK approval before activation.",
    });
    const blockedSkill = await store.applyWrite({
      operation: "create",
      entry: skill,
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:22:00.000Z",
      diffSummary: "Create skill methodology document.",
      source: { kind: "learning_candidate", id: "learning-candidate-skill" },
    });

    expect(blockedSkill.status).toBe("blocked");
    expect((blockedSkill as { violations: string[] }).violations).toContain(
      "behavior-changing memory and SOP/skill writes require an approved BK memory_change decision with the diff summary",
    );
  });

  test("supersedes, archives, and restores without erasing memory history", async () => {
    const { store, governancePath } = await makeStore();
    const oldEntry = memoryEntry({ id: "memory-old-risk", kind: "known_risk" });
    const createOld = await store.applyWrite({
      operation: "create",
      entry: oldEntry,
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:30:00.000Z",
      diffSummary: "Create original known risk memory.",
      source: { kind: "learning_candidate", id: "learning-candidate-risk-old" },
    });
    const newEntry = memoryEntry({
      id: "memory-new-risk",
      kind: "known_risk",
      summary: "Memory supersede operations must preserve the old record in history.",
    });
    await store.applyWrite({
      operation: "supersede",
      entry: newEntry,
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:31:00.000Z",
      diffSummary: "Replace broad known risk with narrower memory.",
      source: { kind: "learning_candidate", id: "learning-candidate-risk-new" },
      supersedesMemoryId: oldEntry.id,
    });

    expect((await store.listActive()).map((record) => record.id)).toEqual(["memory-new-risk"]);

    await store.applyWrite({
      operation: "archive",
      entry: newEntry,
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:32:00.000Z",
      diffSummary: "Archive superseding memory after review.",
      source: { kind: "operator_report", id: "operator-report-archive" },
    });
    expect(await store.listActive()).toEqual([]);

    await store.applyWrite({
      operation: "restore",
      entry: oldEntry,
      actor: "deterministic_operator",
      timestamp: "2026-05-10T04:33:00.000Z",
      diffSummary: "Restore original known risk memory.",
      source: { kind: "operator_report", id: "operator-report-restore" },
      restoresRevisionId: (createOld as { record: GovernedMemoryRecord }).record.revisionId,
    });

    expect((await store.list()).map((record) => record.operation)).toEqual([
      "create",
      "supersede",
      "archive",
      "restore",
    ]);
    expect((await store.listActive()).map((record) => record.id)).toEqual(["memory-old-risk"]);
    expect((await store.history("memory-old-risk")).map((record) => record.operation)).toEqual(["create", "supersede", "restore"]);
    expect((await governanceEvents(governancePath)).map((event) => event.kind)).toEqual([
      "transition_approved",
      "transition_approved",
      "transition_superseded",
      "transition_approved",
      "transition_approved",
      "transition_restored",
    ]);
  });

  test("records rejected memory changes without writing memory records", async () => {
    const { memoryPath, governancePath, store } = await makeStore();

    const result = await store.rejectWrite({
      entry: memoryEntry({ id: "memory-rejected" }),
      actor: "bk",
      timestamp: "2026-05-10T04:40:00.000Z",
      diffSummary: "Reject low-confidence preference.",
      reason: "Source evidence is too weak.",
      source: { kind: "learning_candidate", id: "learning-candidate-rejected" },
    });

    expect(result.status).toBe("rejected");
    await expect(readFile(memoryPath, "utf8")).rejects.toThrow("ENOENT");
    const events = await governanceEvents(governancePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "transition_rejected",
      actor: "bk",
      subject: { id: "memory-rejected" },
    });
    expect(events[0].summary).toContain("Source evidence is too weak.");
  });
});
