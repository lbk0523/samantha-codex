import { parseOptionalWorkItemAncestry, validateWorkItemAncestry, type WorkItemAncestry } from "./ancestry";

export const MEMORY_ENTRY_KINDS = [
  "project_brief",
  "decision_summary",
  "preference",
  "strategy_context",
  "known_risk",
  "artifact_reference",
  "sop_document",
  "skill_document",
] as const;

export type MemoryEntryKind = (typeof MEMORY_ENTRY_KINDS)[number];

export const MEMORY_CLAIM_KINDS = [
  "observed_fact",
  "bk_decision",
  "llm_summary",
  "operator_note",
] as const;

export type MemoryClaimKind = (typeof MEMORY_CLAIM_KINDS)[number];

export const MEMORY_SOURCE_KINDS = [
  "decision",
  "governance_event",
  "orchestrator_plan",
  "task",
  "remote_action",
  "run_lifecycle",
  "run_log",
  "recovery_context",
  "project_profile",
  "agent_profile",
  "safety_policy",
  "budget_observation",
  "ceo_status",
  "operator_report",
  "dashboard_view",
  "telegram_summary",
] as const;

export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export interface MemorySourceCitation {
  kind: MemorySourceKind;
  id: string;
  ancestry?: WorkItemAncestry;
}

export interface DurableMemoryEntry {
  schemaVersion: 1;
  id: string;
  kind: MemoryEntryKind;
  claimKind: MemoryClaimKind;
  summary: string;
  ancestry?: WorkItemAncestry;
  citations: MemorySourceCitation[];
}

function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function describeUnknown(value: unknown): string {
  if (value === "") return "(empty)";
  if (typeof value === "string") return value;
  return String(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableIdViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (normalized !== value) return [`${label} must be normalized`];
  if (/[\\/]/.test(normalized)) return [`${label} must be a stable id, not a path`];
  return [];
}

function summaryViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  if (!oneLine(value)) return [`${label} is required`];
  return [];
}

export function isMemoryEntryKind(value: unknown): value is MemoryEntryKind {
  return hasValue(MEMORY_ENTRY_KINDS, value);
}

export function parseMemoryEntryKind(value: unknown): MemoryEntryKind {
  if (!isMemoryEntryKind(value)) {
    throw new Error(`unknown memory entry kind: ${describeUnknown(value)}`);
  }
  return value;
}

export function isMemoryClaimKind(value: unknown): value is MemoryClaimKind {
  return hasValue(MEMORY_CLAIM_KINDS, value);
}

export function parseMemoryClaimKind(value: unknown): MemoryClaimKind {
  if (!isMemoryClaimKind(value)) {
    throw new Error(`unknown memory claim kind: ${describeUnknown(value)}`);
  }
  return value;
}

export function isMemorySourceKind(value: unknown): value is MemorySourceKind {
  return hasValue(MEMORY_SOURCE_KINDS, value);
}

export function parseMemorySourceKind(value: unknown): MemorySourceKind {
  if (!isMemorySourceKind(value)) {
    throw new Error(`unknown memory source kind: ${describeUnknown(value)}`);
  }
  return value;
}

export function validateMemorySourceCitation(citation: MemorySourceCitation, label = "citation"): string[] {
  const violations: string[] = [];
  if (!isObject(citation)) return [`${label} must be an object`];
  if (!isMemorySourceKind(citation.kind)) violations.push(`${label}.kind is invalid: ${describeUnknown(citation.kind)}`);
  violations.push(...stableIdViolations(citation.id, `${label}.id`));
  if (citation.ancestry !== undefined) {
    violations.push(...validateWorkItemAncestry(citation.ancestry, { label: `${label}.ancestry` }));
  }
  return violations;
}

export function validateDurableMemoryEntry(value: unknown): string[] {
  const violations: string[] = [];
  if (!isObject(value)) return ["memory entry must be an object"];
  const entry = value as Partial<DurableMemoryEntry>;
  if (entry.schemaVersion !== 1) violations.push("memory entry schemaVersion must be 1");
  violations.push(...stableIdViolations(entry.id, "memory.id"));
  if (!isMemoryEntryKind(entry.kind)) violations.push(`memory.kind is invalid: ${describeUnknown(entry.kind)}`);
  if (!isMemoryClaimKind(entry.claimKind)) {
    violations.push(`memory.claimKind is invalid: ${describeUnknown(entry.claimKind)}`);
  }
  violations.push(...summaryViolations(entry.summary, "memory.summary"));
  if (entry.ancestry !== undefined) {
    violations.push(...validateWorkItemAncestry(entry.ancestry, { label: "memory.ancestry" }));
  }
  if (!Array.isArray(entry.citations) || entry.citations.length === 0) {
    violations.push("memory.citations must include at least one source citation");
  } else {
    entry.citations.forEach((citation, index) => {
      violations.push(...validateMemorySourceCitation(citation, `memory.citations[${index}]`));
    });
  }
  return violations;
}

export function parseDurableMemoryEntry(value: unknown): DurableMemoryEntry {
  if (!isObject(value)) throw new Error("memory entry must be an object");
  const entry = value as Record<string, unknown>;
  const violations = validateDurableMemoryEntry(entry);
  if (violations.length > 0) throw new Error(violations[0]);
  return {
    schemaVersion: 1,
    id: entry.id as string,
    kind: parseMemoryEntryKind(entry.kind),
    claimKind: parseMemoryClaimKind(entry.claimKind),
    summary: oneLine(entry.summary as string),
    ancestry: parseOptionalWorkItemAncestry(entry.ancestry),
    citations: (entry.citations as MemorySourceCitation[]).map((citation) => ({
      kind: parseMemorySourceKind(citation.kind),
      id: citation.id,
      ancestry: parseOptionalWorkItemAncestry(citation.ancestry),
    })),
  };
}
