import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOptionalWorkItemAncestry, type WorkItemAncestry } from "./ancestry";
import { compactEntityId } from "./ids";
import {
  DERIVED_VIEW_KINDS,
  SOURCE_OF_TRUTH_RECORD_KINDS,
  parseGovernanceEventKind,
  parseGovernanceRiskClass,
  parseGovernedSubjectType,
  type DerivedViewKind,
  type GovernanceEventKind,
  type GovernanceRiskClass,
  type GovernedSubjectType,
  type SourceOfTruthRecordKind,
} from "./governance-taxonomy";

export type GovernanceEventSourceKind = SourceOfTruthRecordKind | DerivedViewKind;

export interface GovernanceEventSource {
  kind: GovernanceEventSourceKind;
  id: string;
}

export interface GovernanceEventSubject {
  type: GovernedSubjectType;
  id: string;
}

export interface GovernanceRelatedRefs {
  decisionIds?: string[];
  actionIds?: string[];
  runIds?: string[];
}

export interface GovernanceEventRecord {
  schemaVersion: 1;
  id: string;
  ancestry?: WorkItemAncestry;
  timestamp: string;
  actor: string;
  source: GovernanceEventSource;
  subject: GovernanceEventSubject;
  kind: GovernanceEventKind;
  riskClass: GovernanceRiskClass;
  summary: string;
  related?: GovernanceRelatedRefs;
}

export interface CreateGovernanceEventInput {
  timestamp: string;
  ancestry?: WorkItemAncestry;
  actor: string;
  source: GovernanceEventSource;
  subject: GovernanceEventSubject;
  kind: GovernanceEventKind;
  riskClass: GovernanceRiskClass;
  summary: string;
  related?: GovernanceRelatedRefs;
  id?: string;
  dedupeKey?: string;
}

export interface GovernanceEventFilter {
  subject?: GovernanceEventSubject;
  kind?: GovernanceEventKind;
  riskClass?: GovernanceRiskClass;
  source?: GovernanceEventSource;
  decisionId?: string;
  actionId?: string;
  runId?: string;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function describeUnknown(value: unknown): string {
  if (value === "") return "(empty)";
  if (typeof value === "string") return value;
  return String(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = oneLine(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireString(value, "timestamp");
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error(`timestamp must be a valid date: ${timestamp}`);
  }
  return timestamp;
}

function isGovernanceEventSourceKind(value: unknown): value is GovernanceEventSourceKind {
  return (
    typeof value === "string" &&
    ([...SOURCE_OF_TRUTH_RECORD_KINDS, ...DERIVED_VIEW_KINDS] as readonly string[]).includes(value)
  );
}

function parseGovernanceEventSourceKind(value: unknown): GovernanceEventSourceKind {
  if (!isGovernanceEventSourceKind(value)) {
    throw new Error(`unknown governance event source kind: ${describeUnknown(value)}`);
  }
  return value;
}

function normalizeSource(value: unknown): GovernanceEventSource {
  const source = requireRecord(value, "source");
  return {
    kind: parseGovernanceEventSourceKind(source.kind),
    id: requireString(source.id, "source.id"),
  };
}

function normalizeSubject(value: unknown): GovernanceEventSubject {
  const subject = requireRecord(value, "subject");
  return {
    type: parseGovernedSubjectType(subject.type),
    id: requireString(subject.id, "subject.id"),
  };
}

function normalizeIdList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const ids = [...new Set(value.map((item) => requireString(item, label)))];
  return ids.length ? ids : undefined;
}

function normalizeRelated(value: unknown): GovernanceRelatedRefs | undefined {
  if (value === undefined) return undefined;
  const related = requireRecord(value, "related");
  const normalized: GovernanceRelatedRefs = {
    decisionIds: normalizeIdList(related.decisionIds, "related.decisionIds"),
    actionIds: normalizeIdList(related.actionIds, "related.actionIds"),
    runIds: normalizeIdList(related.runIds, "related.runIds"),
  };
  return normalized.decisionIds || normalized.actionIds || normalized.runIds ? normalized : undefined;
}

function sourceKey(source: GovernanceEventSource): string {
  return `${source.kind}:${source.id}`;
}

function subjectKey(subject: GovernanceEventSubject): string {
  return `${subject.type}:${subject.id}`;
}

function stableRelatedKey(related: GovernanceRelatedRefs | undefined): string {
  if (!related) return "";
  return [
    related.decisionIds?.slice().sort().map((id) => `decision:${id}`).join(",") ?? "",
    related.actionIds?.slice().sort().map((id) => `action:${id}`).join(",") ?? "",
    related.runIds?.slice().sort().map((id) => `run:${id}`).join(",") ?? "",
  ].join("|");
}

export function buildGovernanceEventId(input: Omit<CreateGovernanceEventInput, "id">): string {
  const subject = subjectKey(input.subject);
  const source = input.dedupeKey ?? [
    input.timestamp,
    input.actor,
    sourceKey(input.source),
    subject,
    input.kind,
    input.riskClass,
    input.summary,
    stableRelatedKey(input.related),
  ].join("|");

  return compactEntityId({
    prefix: "gov-event",
    createdAt: input.timestamp,
    label: `${input.subject.type}-${input.kind}`,
    source,
  });
}

export function createGovernanceEvent(input: CreateGovernanceEventInput): GovernanceEventRecord {
  const timestamp = requireTimestamp(input.timestamp);
  const ancestry = parseOptionalWorkItemAncestry(input.ancestry);
  const actor = requireString(input.actor, "actor");
  const source = normalizeSource(input.source);
  const subject = normalizeSubject(input.subject);
  const kind = parseGovernanceEventKind(input.kind);
  const riskClass = parseGovernanceRiskClass(input.riskClass);
  const summary = requireString(input.summary, "summary");
  const related = normalizeRelated(input.related);
  const id = input.id ? requireString(input.id, "id") : buildGovernanceEventId({
    timestamp,
    actor,
    source,
    subject,
    kind,
    riskClass,
    summary,
    related,
    dedupeKey: input.dedupeKey,
  });

  return {
    schemaVersion: 1,
    id,
    ancestry,
    timestamp,
    actor,
    source,
    subject,
    kind,
    riskClass,
    summary,
    related,
  };
}

export function parseGovernanceEventRecord(value: unknown): GovernanceEventRecord {
  const record = requireRecord(value, "governance event");
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported governance event schemaVersion: ${describeUnknown(record.schemaVersion)}`);
  }
  return createGovernanceEvent({
    id: requireString(record.id, "id"),
    ancestry: parseOptionalWorkItemAncestry(record.ancestry),
    timestamp: requireTimestamp(record.timestamp),
    actor: requireString(record.actor, "actor"),
    source: normalizeSource(record.source),
    subject: normalizeSubject(record.subject),
    kind: parseGovernanceEventKind(record.kind),
    riskClass: parseGovernanceRiskClass(record.riskClass),
    summary: requireString(record.summary, "summary"),
    related: normalizeRelated(record.related),
  });
}

function matchesFilter(event: GovernanceEventRecord, filter: GovernanceEventFilter): boolean {
  if (filter.subject && subjectKey(event.subject) !== subjectKey(filter.subject)) return false;
  if (filter.kind && event.kind !== filter.kind) return false;
  if (filter.riskClass && event.riskClass !== filter.riskClass) return false;
  if (filter.source && sourceKey(event.source) !== sourceKey(filter.source)) return false;
  if (filter.decisionId && !event.related?.decisionIds?.includes(filter.decisionId)) return false;
  if (filter.actionId && !event.related?.actionIds?.includes(filter.actionId)) return false;
  if (filter.runId && !event.related?.runIds?.includes(filter.runId)) return false;
  return true;
}

export async function loadGovernanceEvents(path: string): Promise<GovernanceEventRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const events: GovernanceEventRecord[] = [];
  const seenIds = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`malformed governance event at line ${index + 1}: invalid JSON`);
    }

    let event: GovernanceEventRecord;
    try {
      event = parseGovernanceEventRecord(parsed);
    } catch (err) {
      throw new Error(`malformed governance event at line ${index + 1}: ${(err as Error).message}`);
    }

    if (seenIds.has(event.id)) {
      throw new Error(
        `malformed governance event at line ${index + 1}: duplicate governance event id: ${event.id}`,
      );
    }
    seenIds.add(event.id);
    events.push(event);
  });
  return events;
}

export class GovernanceEventStore {
  constructor(private readonly path: string) {}

  async list(filter: GovernanceEventFilter = {}): Promise<GovernanceEventRecord[]> {
    const events = await loadGovernanceEvents(this.path);
    return Object.keys(filter).length ? events.filter((event) => matchesFilter(event, filter)) : events;
  }

  async find(id: string): Promise<GovernanceEventRecord | undefined> {
    return (await this.list()).find((event) => event.id === id);
  }

  async load(id: string): Promise<GovernanceEventRecord> {
    const event = await this.find(id);
    if (!event) throw new Error(`governance event not found: ${id}`);
    return event;
  }

  async append(event: GovernanceEventRecord): Promise<GovernanceEventRecord> {
    const normalized = parseGovernanceEventRecord(event);
    const events = await this.list();
    const existing = events.find((item) => item.id === normalized.id);
    if (existing) return existing;

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }

  async create(input: CreateGovernanceEventInput): Promise<GovernanceEventRecord> {
    return this.append(createGovernanceEvent(input));
  }
}
