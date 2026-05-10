import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateGovernanceTransition } from "../src/lib/governance-taxonomy";
import {
  MEMORY_CLAIM_KINDS,
  MEMORY_ENTRY_KINDS,
  MEMORY_SOURCE_KINDS,
  parseDurableMemoryEntry,
  parseMemoryClaimKind,
  parseMemoryEntryKind,
  parseMemorySourceKind,
  validateDurableMemoryEntry,
  type DurableMemoryEntry,
  type MemoryEntryKind,
  type MemorySourceKind,
} from "../src/lib/memory-taxonomy";
import { DEFAULT_SAFETY_POLICY } from "../src/lib/policy";
import type { WorkItemAncestry } from "../src/lib/ancestry";

interface MemoryTaxonomyFixture {
  memoryEntryKinds: string[];
  memoryClaimKinds: string[];
  memorySourceKinds: string[];
}

const ancestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "samantha",
  goalId: "goal-context-memory",
  workItemId: "work-item-memory-m2",
};

function entryFixture(input: Partial<DurableMemoryEntry> = {}): DurableMemoryEntry {
  return {
    schemaVersion: 1,
    id: "memory-m2-context-rule",
    kind: "project_brief",
    claimKind: "observed_fact",
    summary: "Phase 8 memory records are context, not execution authority.",
    ancestry,
    citations: [
      {
        kind: "governance_event",
        id: "gov-event-phase-8-m2",
        ancestry,
      },
    ],
    ...input,
  };
}

async function readFixture(): Promise<MemoryTaxonomyFixture> {
  const path = join(import.meta.dir, "..", "references", "memory", "taxonomy.json");
  return JSON.parse(await readFile(path, "utf8")) as MemoryTaxonomyFixture;
}

describe("memory taxonomy and source model", () => {
  test("fixture covers every memory taxonomy value", async () => {
    const fixture = await readFixture();

    expect(fixture.memoryEntryKinds).toEqual([...MEMORY_ENTRY_KINDS]);
    expect(fixture.memoryClaimKinds).toEqual([...MEMORY_CLAIM_KINDS]);
    expect(fixture.memorySourceKinds).toEqual([...MEMORY_SOURCE_KINDS]);
  });

  test("defines the minimal durable memory entry kinds for Phase 8", () => {
    expect(MEMORY_ENTRY_KINDS).toEqual([
      "project_brief",
      "decision_summary",
      "preference",
      "strategy_context",
      "known_risk",
      "artifact_reference",
      "sop_document",
      "skill_document",
    ]);
  });

  test("distinguishes observed facts, BK decisions, LLM summaries, and operator notes", () => {
    expect(MEMORY_CLAIM_KINDS).toEqual([
      "observed_fact",
      "bk_decision",
      "llm_summary",
      "operator_note",
    ]);
  });

  test("validates every memory kind and every source kind with source citations", () => {
    for (const kind of MEMORY_ENTRY_KINDS) {
      expect(validateDurableMemoryEntry(entryFixture({ id: `memory-${kind}`, kind }))).toEqual([]);
    }
    for (const sourceKind of MEMORY_SOURCE_KINDS) {
      expect(validateDurableMemoryEntry(entryFixture({
        id: `memory-source-${sourceKind}`,
        citations: [{ kind: sourceKind, id: `${sourceKind}-1`, ancestry }],
      }))).toEqual([]);
    }
  });

  test("unknown memory kind, claim kind, source kind, and transition fail closed", () => {
    expect(() => parseMemoryEntryKind("daily_routine")).toThrow("unknown memory entry kind: daily_routine");
    expect(() => parseMemoryClaimKind("agent_belief")).toThrow("unknown memory claim kind: agent_belief");
    expect(() => parseMemorySourceKind("wiki_page")).toThrow("unknown memory source kind: wiki_page");

    expect(validateDurableMemoryEntry(entryFixture({
      kind: "daily_routine" as MemoryEntryKind,
      claimKind: "agent_belief" as DurableMemoryEntry["claimKind"],
      citations: [{ kind: "wiki_page" as MemorySourceKind, id: "wiki-1" }],
    }))).toContain("memory.kind is invalid: daily_routine");

    expect(validateGovernanceTransition({
      subjectType: "memory",
      transitionKind: "dispatch",
      riskClass: "high",
    })).toEqual({
      allowed: false,
      violations: ["transition dispatch is not allowed for governed subject memory"],
    });
  });

  test("durable memory entries must cite source evidence", () => {
    expect(validateDurableMemoryEntry(entryFixture({ citations: [] }))).toEqual([
      "memory.citations must include at least one source citation",
    ]);
  });

  test("stable ids reject local paths in memory and citation identity fields", () => {
    expect(validateDurableMemoryEntry(entryFixture({
      id: "/tmp/memory",
      citations: [{ kind: "decision", id: "state/decisions.jsonl" }],
    }))).toContain("memory.id must be a stable id, not a path");
    expect(validateDurableMemoryEntry(entryFixture({
      citations: [{ kind: "operator_report", id: "reports\\daily.md" }],
    }))).toContain("memory.citations[0].id must be a stable id, not a path");
  });

  test("source references preserve ancestry where available", () => {
    const parsed = parseDurableMemoryEntry(entryFixture());

    expect(parsed.ancestry).toEqual(ancestry);
    expect(parsed.citations[0]?.ancestry).toEqual(ancestry);
  });

  test("memory taxonomy does not expand writer authority", () => {
    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
  });
});
