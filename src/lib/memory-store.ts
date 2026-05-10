import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOptionalWorkItemAncestry, type WorkItemAncestry } from "./ancestry";
import type { DecisionItem } from "./decision-store";
import {
  GovernanceEventStore,
  type GovernanceEventRecord,
  type GovernanceEventSource,
} from "./governance-event-store";
import { type GovernanceRiskClass } from "./governance-taxonomy";
import { compactEntityId } from "./ids";
import {
  parseDurableMemoryEntry,
  validateDurableMemoryEntry,
  type DurableMemoryEntry,
  type MemorySourceCitation,
} from "./memory-taxonomy";

export type MemoryWriteOperation = "create" | "update" | "supersede" | "archive" | "restore";
export type MemoryRecordStatus = "active" | "archived";
export type MemoryWriteActor =
  | "bk"
  | "deterministic_operator"
  | "llm"
  | "worker"
  | "remote_command"
  | "dashboard_view";
export type MemoryBehaviorImpact = "none" | "behavior_change";

export interface GovernedMemoryRecord extends DurableMemoryEntry {
  revisionId: string;
  status: MemoryRecordStatus;
  operation: MemoryWriteOperation;
  actor: "bk" | "deterministic_operator";
  createdAt: string;
  updatedAt: string;
  riskClass: GovernanceRiskClass;
  diffSummary: string;
  source: GovernanceEventSource;
  behaviorImpact: MemoryBehaviorImpact;
  approvalDecisionId?: string;
  supersedesMemoryId?: string;
  restoresRevisionId?: string;
  governanceEventIds: string[];
}

export interface MemoryWriteInput {
  operation: MemoryWriteOperation;
  entry: DurableMemoryEntry;
  actor: MemoryWriteActor;
  timestamp: string;
  diffSummary: string;
  source: GovernanceEventSource;
  behaviorImpact?: MemoryBehaviorImpact;
  approvalEvidence?: DecisionItem[];
  supersedesMemoryId?: string;
  restoresRevisionId?: string;
}

export interface MemoryRejectInput {
  entry: DurableMemoryEntry;
  actor: "bk" | "deterministic_operator";
  timestamp: string;
  diffSummary: string;
  source: GovernanceEventSource;
  reason: string;
}

export type MemoryWriteResult =
  | { status: "approved"; record: GovernedMemoryRecord; events: GovernanceEventRecord[] }
  | { status: "blocked"; violations: string[]; events: GovernanceEventRecord[] }
  | { status: "rejected"; events: GovernanceEventRecord[] };

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function timestampViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (Number.isNaN(new Date(normalized).getTime())) return [`${label} must be a valid date: ${normalized}`];
  return [];
}

function stableIdViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (normalized !== value) return [`${label} must be normalized`];
  if (/[\\/]/.test(normalized)) return [`${label} must be a stable id, not a path`];
  return [];
}

function requireDiffSummary(value: string): string[] {
  return oneLine(value) ? [] : ["memory write diffSummary is required"];
}

function isAllowedMemoryWriter(actor: MemoryWriteActor): actor is "bk" | "deterministic_operator" {
  return actor === "bk" || actor === "deterministic_operator";
}

function operationRiskClass(input: {
  operation: MemoryWriteOperation;
  entry: DurableMemoryEntry;
  behaviorImpact: MemoryBehaviorImpact;
}): GovernanceRiskClass {
  if (input.operation === "archive") return "medium";
  if (input.behaviorImpact === "behavior_change" || input.entry.kind === "sop_document") return "high";
  if (input.operation === "restore") return "high";
  if (input.operation === "supersede") return "medium";
  return "medium";
}

function writeStatus(operation: MemoryWriteOperation): MemoryRecordStatus {
  return operation === "archive" ? "archived" : "active";
}

function revisionId(input: {
  timestamp: string;
  operation: MemoryWriteOperation;
  memoryId: string;
  diffSummary: string;
}): string {
  return compactEntityId({
    prefix: "memory-revision",
    createdAt: input.timestamp,
    label: `${input.operation}-${input.memoryId}`,
    source: `${input.timestamp}|${input.operation}|${input.memoryId}|${input.diffSummary}`,
  });
}

function memorySubjectId(entry: DurableMemoryEntry): string {
  const violations = stableIdViolations(entry.id, "memory.id");
  return violations.length === 0 ? entry.id : "memory-write-blocked";
}

function validApprovalDecision(input: {
  entry: DurableMemoryEntry;
  diffSummary: string;
  approvalEvidence: DecisionItem[] | undefined;
}): DecisionItem | undefined {
  return (input.approvalEvidence ?? []).find((decision) => {
    if (decision.kind !== "memory_change" && decision.kind !== "risk_acceptance") return false;
    if (decision.status !== "resolved") return false;
    if (decision.resolution !== "approved") return false;
    if (decision.resolvedBy !== "bk" || !decision.resolvedAt) return false;
    if (decision.subject?.type !== "memory" || decision.subject.id !== input.entry.id) return false;
    if (!oneLine(decision.prompt).includes(oneLine(input.diffSummary))) return false;
    return true;
  });
}

function requiresExplicitBkApproval(entry: DurableMemoryEntry, behaviorImpact: MemoryBehaviorImpact): boolean {
  return behaviorImpact === "behavior_change" || entry.kind === "sop_document";
}

function activeMemoryIds(records: GovernedMemoryRecord[]): Set<string> {
  const active = new Set<string>();
  for (const record of records) {
    if (record.operation === "supersede" && record.supersedesMemoryId) active.delete(record.supersedesMemoryId);
    if (record.status === "archived") active.delete(record.id);
    if (record.status === "active") active.add(record.id);
  }
  return active;
}

function latestRevision(records: GovernedMemoryRecord[], memoryId: string): GovernedMemoryRecord | undefined {
  return records.slice().reverse().find((record) => record.id === memoryId);
}

function operationViolations(input: {
  records: GovernedMemoryRecord[];
  operation: MemoryWriteOperation;
  entry: DurableMemoryEntry;
  supersedesMemoryId?: string;
  restoresRevisionId?: string;
}): string[] {
  const violations: string[] = [];
  const active = activeMemoryIds(input.records);
  const latest = latestRevision(input.records, input.entry.id);

  if (input.operation === "create" && active.has(input.entry.id)) {
    violations.push(`memory create requires an inactive memory id: ${input.entry.id}`);
  }
  if (input.operation === "update" && !active.has(input.entry.id)) {
    violations.push(`memory update requires an active memory record: ${input.entry.id}`);
  }
  if (input.operation === "archive" && !active.has(input.entry.id)) {
    violations.push(`memory archive requires an active memory record: ${input.entry.id}`);
  }
  if (input.operation === "supersede") {
    violations.push(...stableIdViolations(input.supersedesMemoryId, "memory.supersedesMemoryId"));
    if (input.supersedesMemoryId === input.entry.id) {
      violations.push("memory supersede requires a different replacement memory id");
    }
    if (typeof input.supersedesMemoryId === "string" && !active.has(input.supersedesMemoryId)) {
      violations.push(`memory supersede requires an active superseded memory record: ${input.supersedesMemoryId}`);
    }
  }
  if (input.operation === "restore") {
    if (!latest) violations.push(`memory restore requires existing history for memory record: ${input.entry.id}`);
    if (active.has(input.entry.id)) violations.push(`memory restore requires an inactive memory record: ${input.entry.id}`);
    violations.push(...stableIdViolations(input.restoresRevisionId, "memory.restoresRevisionId"));
    if (
      typeof input.restoresRevisionId === "string" &&
      !input.records.some((record) => record.revisionId === input.restoresRevisionId)
    ) {
      violations.push(`memory restore revision not found: ${input.restoresRevisionId}`);
    }
  }
  return violations;
}

function parseMemoryRecord(value: unknown): GovernedMemoryRecord {
  const record = value as Partial<GovernedMemoryRecord>;
  const entry = parseDurableMemoryEntry(value);
  const revisionIdValue = record.revisionId;
  const status = record.status;
  const operation = record.operation;
  const actor = record.actor;
  const riskClass = record.riskClass;
  const behaviorImpact = record.behaviorImpact;
  const source = record.source;
  const governanceEventIds = record.governanceEventIds;
  const violations = [
    ...stableIdViolations(revisionIdValue, "memory.revisionId"),
    ...(status === "active" || status === "archived" ? [] : [`memory.status is invalid: ${String(status)}`]),
    ...(
      operation === "create" ||
      operation === "update" ||
      operation === "supersede" ||
      operation === "archive" ||
      operation === "restore"
        ? []
        : [`memory.operation is invalid: ${String(operation)}`]
    ),
    ...(actor === "bk" || actor === "deterministic_operator" ? [] : [`memory.actor is invalid: ${String(actor)}`]),
    ...timestampViolations(record.createdAt, "memory.createdAt"),
    ...timestampViolations(record.updatedAt, "memory.updatedAt"),
    ...(riskClass === "informational" || riskClass === "low" || riskClass === "medium" || riskClass === "high" || riskClass === "irreversible"
      ? []
      : [`memory.riskClass is invalid: ${String(riskClass)}`]),
    ...requireDiffSummary(record.diffSummary ?? ""),
    ...(behaviorImpact === "none" || behaviorImpact === "behavior_change"
      ? []
      : [`memory.behaviorImpact is invalid: ${String(behaviorImpact)}`]),
    ...(!source || typeof source !== "object" ? ["memory.source is required"] : []),
    ...(!Array.isArray(governanceEventIds) || governanceEventIds.length === 0
      ? ["memory.governanceEventIds must include at least one governance event id"]
      : governanceEventIds.flatMap((id, index) => stableIdViolations(id, `memory.governanceEventIds[${index}]`))),
  ];
  if (violations.length > 0) throw new Error(violations[0]);

  return {
    ...entry,
    revisionId: revisionIdValue as string,
    status: status as MemoryRecordStatus,
    operation: operation as MemoryWriteOperation,
    actor: actor as "bk" | "deterministic_operator",
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
    riskClass: riskClass as GovernanceRiskClass,
    diffSummary: oneLine(record.diffSummary as string),
    source: source as GovernanceEventSource,
    behaviorImpact: behaviorImpact as MemoryBehaviorImpact,
    approvalDecisionId: record.approvalDecisionId,
    supersedesMemoryId: record.supersedesMemoryId,
    restoresRevisionId: record.restoresRevisionId,
    governanceEventIds: governanceEventIds as string[],
  };
}

async function readJsonLines(path: string): Promise<unknown[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export class GovernedMemoryStore {
  constructor(
    private readonly path: string,
    private readonly governanceEvents: GovernanceEventStore,
  ) {}

  async list(): Promise<GovernedMemoryRecord[]> {
    const records = (await readJsonLines(this.path)).map(parseMemoryRecord);
    return records.sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.revisionId.localeCompare(right.revisionId),
    );
  }

  async listActive(): Promise<GovernedMemoryRecord[]> {
    const records = await this.list();
    const activeIds = activeMemoryIds(records);
    const latest = new Map<string, GovernedMemoryRecord>();
    for (const record of records) {
      if (activeIds.has(record.id) && record.status === "active") latest.set(record.id, record);
    }
    return [...latest.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async history(memoryId: string): Promise<GovernedMemoryRecord[]> {
    return (await this.list()).filter((record) => record.id === memoryId || record.supersedesMemoryId === memoryId);
  }

  async applyWrite(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const behaviorImpact = input.behaviorImpact ?? "none";
    const entryViolations = validateDurableMemoryEntry(input.entry);
    const records = await this.list();
    const riskClass = operationRiskClass({ operation: input.operation, entry: input.entry, behaviorImpact });
    const approval = validApprovalDecision({
      entry: input.entry,
      diffSummary: input.diffSummary,
      approvalEvidence: input.approvalEvidence,
    });
    const violations = [
      ...timestampViolations(input.timestamp, "memory write timestamp"),
      ...requireDiffSummary(input.diffSummary),
      ...entryViolations,
      ...(isAllowedMemoryWriter(input.actor)
        ? []
        : [`${input.actor} cannot mutate durable memory; use a deterministic memory write gate`]),
      ...operationViolations({
        records,
        operation: input.operation,
        entry: input.entry,
        supersedesMemoryId: input.supersedesMemoryId,
        restoresRevisionId: input.restoresRevisionId,
      }),
    ];

    if (requiresExplicitBkApproval(input.entry, behaviorImpact) && !approval) {
      violations.push("behavior-changing memory and SOP writes require an approved BK memory_change decision with the diff summary");
    }

    if (violations.length > 0) {
      const event = await this.governanceEvents.create({
        timestamp: input.timestamp,
        actor: isAllowedMemoryWriter(input.actor) ? input.actor : "deterministic_operator",
        source: input.source,
        subject: { type: "memory", id: memorySubjectId(input.entry) },
        kind: "transition_blocked",
        riskClass: "low",
        summary: `Memory ${input.operation} blocked: ${violations.join("; ")}`,
        related: approval ? { decisionIds: [approval.id] } : undefined,
      });
      return { status: "blocked", violations, events: [event] };
    }

    const normalized = parseDurableMemoryEntry(input.entry);
    const writerActor = input.actor as "bk" | "deterministic_operator";
    const approvedEvent = await this.governanceEvents.create({
      timestamp: input.timestamp,
      actor: writerActor,
      source: approval ? { kind: "decision", id: approval.id } : input.source,
      subject: { type: "memory", id: normalized.id },
      kind: "transition_approved",
      riskClass,
      summary: `Memory ${input.operation} approved: ${oneLine(input.diffSummary)}`,
      related: approval ? { decisionIds: [approval.id] } : undefined,
      dedupeKey: `memory-write-approved:${input.operation}:${normalized.id}:${input.timestamp}:${oneLine(input.diffSummary)}`,
    });
    const lifecycleEvents = [approvedEvent];

    if (input.operation === "supersede" && input.supersedesMemoryId) {
      lifecycleEvents.push(await this.governanceEvents.create({
        timestamp: input.timestamp,
        actor: writerActor,
        source: approval ? { kind: "decision", id: approval.id } : input.source,
        subject: { type: "memory", id: input.supersedesMemoryId },
        kind: "transition_superseded",
        riskClass,
        summary: `Memory superseded by ${normalized.id}: ${oneLine(input.diffSummary)}`,
        related: approval ? { decisionIds: [approval.id] } : undefined,
        dedupeKey: `memory-write-superseded:${input.supersedesMemoryId}:${normalized.id}:${input.timestamp}`,
      }));
    }
    if (input.operation === "restore") {
      lifecycleEvents.push(await this.governanceEvents.create({
        timestamp: input.timestamp,
        actor: writerActor,
        source: approval ? { kind: "decision", id: approval.id } : input.source,
        subject: { type: "memory", id: normalized.id },
        kind: "transition_restored",
        riskClass,
        summary: `Memory restored from ${input.restoresRevisionId}: ${oneLine(input.diffSummary)}`,
        related: approval ? { decisionIds: [approval.id] } : undefined,
        dedupeKey: `memory-write-restored:${normalized.id}:${input.restoresRevisionId}:${input.timestamp}`,
      }));
    }

    const record: GovernedMemoryRecord = {
      ...normalized,
      revisionId: revisionId({
        timestamp: input.timestamp,
        operation: input.operation,
        memoryId: normalized.id,
        diffSummary: input.diffSummary,
      }),
      status: writeStatus(input.operation),
      operation: input.operation,
      actor: writerActor,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      riskClass,
      diffSummary: oneLine(input.diffSummary),
      source: approval ? { kind: "decision", id: approval.id } : input.source,
      behaviorImpact,
      approvalDecisionId: approval?.id,
      supersedesMemoryId: input.supersedesMemoryId,
      restoresRevisionId: input.restoresRevisionId,
      governanceEventIds: lifecycleEvents.map((event) => event.id),
    };

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    return { status: "approved", record, events: lifecycleEvents };
  }

  async rejectWrite(input: MemoryRejectInput): Promise<MemoryWriteResult> {
    const violations = [
      ...timestampViolations(input.timestamp, "memory reject timestamp"),
      ...requireDiffSummary(input.diffSummary),
      ...validateDurableMemoryEntry(input.entry),
      ...(oneLine(input.reason) ? [] : ["memory reject reason is required"]),
    ];
    if (violations.length > 0) {
      const event = await this.governanceEvents.create({
        timestamp: input.timestamp,
        actor: input.actor,
        source: input.source,
        subject: { type: "memory", id: memorySubjectId(input.entry) },
        kind: "transition_blocked",
        riskClass: "low",
        summary: `Memory rejection blocked: ${violations.join("; ")}`,
      });
      return { status: "blocked", violations, events: [event] };
    }

    const event = await this.governanceEvents.create({
      timestamp: input.timestamp,
      actor: input.actor,
      source: input.source,
      subject: { type: "memory", id: input.entry.id },
      kind: "transition_rejected",
      riskClass: "low",
      summary: `Memory write rejected: ${oneLine(input.reason)} Diff: ${oneLine(input.diffSummary)}`,
      dedupeKey: `memory-write-rejected:${input.entry.id}:${input.timestamp}:${oneLine(input.diffSummary)}`,
    });
    return { status: "rejected", events: [event] };
  }
}

export function memoryRecordCitations(record: GovernedMemoryRecord): MemorySourceCitation[] {
  return record.citations.map((citation) => ({
    kind: citation.kind,
    id: citation.id,
    ancestry: parseOptionalWorkItemAncestry(citation.ancestry),
  }));
}
