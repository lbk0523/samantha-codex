import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compactEntityId } from "./ids";

export type CeoTurnSource = "local" | "remote" | "system";
export type CeoTurnActor = "bk" | "samantha" | "operator" | "system";

export interface CeoTurnDetectedIntent {
  kind: string;
  summary?: string;
}

export interface CeoTurnResponseBoundary {
  kind: string;
  summary?: string;
  responseId?: string;
  respondedAt?: string;
}

export interface CeoTurnLinkedStateIds {
  requestIds?: string[];
  planIds?: string[];
  decisionIds?: string[];
  taskIds?: string[];
  actionIds?: string[];
  runIds?: string[];
  reportIds?: string[];
  proposalIds?: string[];
  memoryIds?: string[];
  governanceEventIds?: string[];
}

export interface CeoTurnRecord {
  schemaVersion: 1;
  id: string;
  source: CeoTurnSource;
  actor: CeoTurnActor;
  text: string;
  detectedIntent: CeoTurnDetectedIntent;
  responseBoundary: CeoTurnResponseBoundary;
  linkedStateIds: CeoTurnLinkedStateIds;
  createdAt: string;
  updatedAt: string;
  memoryCandidateRefs?: string[];
}

export interface CreateCeoTurnRecordInput {
  id?: string;
  source: CeoTurnSource;
  actor: CeoTurnActor;
  text: string;
  detectedIntent: CeoTurnDetectedIntent;
  responseBoundary: CeoTurnResponseBoundary;
  linkedStateIds?: CeoTurnLinkedStateIds;
  createdAt: string;
  updatedAt?: string;
  memoryCandidateRefs?: string[];
}

const sources = new Set<CeoTurnSource>(["local", "remote", "system"]);
const actors = new Set<CeoTurnActor>(["bk", "samantha", "operator", "system"]);
const linkedStateFields = [
  "requestIds",
  "planIds",
  "decisionIds",
  "taskIds",
  "actionIds",
  "runIds",
  "reportIds",
  "proposalIds",
  "memoryIds",
  "governanceEventIds",
] as const satisfies readonly (keyof CeoTurnLinkedStateIds)[];
const allowedTopLevelFields = new Set([
  "schemaVersion",
  "id",
  "source",
  "actor",
  "text",
  "detectedIntent",
  "responseBoundary",
  "linkedStateIds",
  "createdAt",
  "updatedAt",
  "memoryCandidateRefs",
]);
const allowedIntentFields = new Set(["kind", "summary"]);
const allowedBoundaryFields = new Set(["kind", "summary", "responseId", "respondedAt"]);

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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${label}.${field} is not allowed`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = oneLine(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requireText(value: unknown): string {
  if (typeof value !== "string") throw new Error("text must be a string");
  if (!oneLine(value)) throw new Error("text is required");
  return value;
}

function requireStableId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (id !== value) throw new Error(`${label} must be normalized`);
  if (/[\\/]/.test(id)) throw new Error(`${label} must be a stable id, not a path`);
  return id;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error(`${label} must be a valid date: ${timestamp}`);
  }
  return timestamp;
}

function requireSource(value: unknown): CeoTurnSource {
  if (sources.has(value as CeoTurnSource)) return value as CeoTurnSource;
  throw new Error(`source is invalid: ${describeUnknown(value)}`);
}

function requireActor(value: unknown): CeoTurnActor {
  if (actors.has(value as CeoTurnActor)) return value as CeoTurnActor;
  throw new Error(`actor is invalid: ${describeUnknown(value)}`);
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function normalizeDetectedIntent(value: unknown): CeoTurnDetectedIntent {
  const intent = requireRecord(value, "detectedIntent");
  rejectUnknownFields(intent, allowedIntentFields, "detectedIntent");
  return {
    kind: requireString(intent.kind, "detectedIntent.kind"),
    summary: optionalString(intent.summary, "detectedIntent.summary"),
  };
}

function normalizeResponseBoundary(value: unknown): CeoTurnResponseBoundary {
  const boundary = requireRecord(value, "responseBoundary");
  rejectUnknownFields(boundary, allowedBoundaryFields, "responseBoundary");
  return {
    kind: requireString(boundary.kind, "responseBoundary.kind"),
    summary: optionalString(boundary.summary, "responseBoundary.summary"),
    responseId: boundary.responseId === undefined ? undefined : requireStableId(boundary.responseId, "responseBoundary.responseId"),
    respondedAt: boundary.respondedAt === undefined ? undefined : requireTimestamp(boundary.respondedAt, "responseBoundary.respondedAt"),
  };
}

function normalizeIdList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);

  const ids: string[] = [];
  for (const item of value) {
    const id = requireStableId(item, label);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length ? ids : undefined;
}

function normalizeLinkedStateIds(value: unknown): CeoTurnLinkedStateIds {
  const linkedStateIds = requireRecord(value, "linkedStateIds");
  rejectUnknownFields(linkedStateIds, new Set<string>(linkedStateFields), "linkedStateIds");

  const normalized: CeoTurnLinkedStateIds = {};
  for (const field of linkedStateFields) {
    const ids = normalizeIdList(linkedStateIds[field], `linkedStateIds.${field}`);
    if (ids) normalized[field] = ids;
  }
  return normalized;
}

export function buildCeoTurnId(input: {
  createdAt: string;
  source: CeoTurnSource;
  actor: CeoTurnActor;
  text: string;
  disambiguator?: string | number;
}): string {
  return compactEntityId({
    prefix: "ceo-turn",
    createdAt: input.createdAt,
    label: input.actor,
    source: [
      input.createdAt,
      input.source,
      input.actor,
      input.text,
      input.disambiguator === undefined ? "" : String(input.disambiguator),
    ].join("|"),
  });
}

export function parseCeoTurnRecord(value: unknown): CeoTurnRecord {
  const record = requireRecord(value, "CEO turn");
  rejectUnknownFields(record, allowedTopLevelFields, "CEO turn");
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported CEO turn schemaVersion: ${describeUnknown(record.schemaVersion)}`);
  }

  return {
    schemaVersion: 1,
    id: requireStableId(record.id, "id"),
    source: requireSource(record.source),
    actor: requireActor(record.actor),
    text: requireText(record.text),
    detectedIntent: normalizeDetectedIntent(record.detectedIntent),
    responseBoundary: normalizeResponseBoundary(record.responseBoundary),
    linkedStateIds: normalizeLinkedStateIds(record.linkedStateIds),
    createdAt: requireTimestamp(record.createdAt, "createdAt"),
    updatedAt: requireTimestamp(record.updatedAt, "updatedAt"),
    memoryCandidateRefs: normalizeIdList(record.memoryCandidateRefs, "memoryCandidateRefs"),
  };
}

export function createCeoTurnRecord(input: CreateCeoTurnRecordInput): CeoTurnRecord {
  const source = requireSource(input.source);
  const actor = requireActor(input.actor);
  const text = requireText(input.text);
  const createdAt = requireTimestamp(input.createdAt, "createdAt");
  const updatedAt = requireTimestamp(input.updatedAt ?? input.createdAt, "updatedAt");

  return parseCeoTurnRecord({
    schemaVersion: 1,
    id: input.id ?? buildCeoTurnId({ createdAt, source, actor, text }),
    source,
    actor,
    text,
    detectedIntent: input.detectedIntent,
    responseBoundary: input.responseBoundary,
    linkedStateIds: input.linkedStateIds ?? {},
    createdAt,
    updatedAt,
    memoryCandidateRefs: input.memoryCandidateRefs,
  });
}

async function loadCeoTurnRecords(path: string): Promise<CeoTurnRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: CeoTurnRecord[] = [];
  const seenIds = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`malformed CEO turn at line ${index + 1}: invalid JSON`);
    }

    let record: CeoTurnRecord;
    try {
      record = parseCeoTurnRecord(parsed);
    } catch (err) {
      throw new Error(`malformed CEO turn at line ${index + 1}: ${(err as Error).message}`);
    }

    if (seenIds.has(record.id)) {
      throw new Error(`malformed CEO turn at line ${index + 1}: duplicate CEO turn id: ${record.id}`);
    }
    seenIds.add(record.id);
    records.push(record);
  });
  return records;
}

export class CeoTurnStore {
  constructor(private readonly path: string) {}

  async list(): Promise<CeoTurnRecord[]> {
    return loadCeoTurnRecords(this.path);
  }

  async find(id: string): Promise<CeoTurnRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  async read(id: string): Promise<CeoTurnRecord> {
    const record = await this.find(id);
    if (!record) throw new Error(`CEO turn not found: ${id}`);
    return record;
  }

  async append(record: CeoTurnRecord): Promise<CeoTurnRecord> {
    const normalized = parseCeoTurnRecord(record);
    if ((await this.list()).some((existing) => existing.id === normalized.id)) {
      throw new Error(`CEO turn already exists: ${normalized.id}`);
    }

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }

  async create(input: CreateCeoTurnRecordInput): Promise<CeoTurnRecord> {
    return this.append(createCeoTurnRecord(input));
  }
}
