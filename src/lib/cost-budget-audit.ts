import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentProfile, TaskSpec } from "./contracts";
import { compactEntityId } from "./ids";
import type { RunSummary } from "./ledger";
import type { RemoteActionRecord } from "./remote-action-store";

export type CostBudgetSubjectType = "run" | "action" | "project" | "goal" | "command" | "model";
export type CostDataKind = "measured" | "estimated" | "unknown";

export interface CostBudgetSubject {
  type: CostBudgetSubjectType;
  id: string;
}

export interface CostBudgetCommandContext {
  executable: string;
  args: string[];
}

export interface CostBudgetContext {
  model?: string;
  command?: CostBudgetCommandContext;
  runId?: string;
  runLogPath?: string;
  projectId?: string;
  goalId?: string;
  planId?: string;
  actionId?: string;
  taskId?: string;
  agentId?: string;
  repoRoot?: string;
}

export interface MeasuredCostData {
  kind: "measured";
  amount: number;
  currency: string;
  source: string;
}

export interface EstimatedCostData {
  kind: "estimated";
  amount: number;
  currency: string;
  basis: string;
}

export interface UnknownCostData {
  kind: "unknown";
  reason: string;
}

export type CostBudgetData = MeasuredCostData | EstimatedCostData | UnknownCostData;

export interface CostBudgetAuditRecord {
  schemaVersion: 1;
  id: string;
  observedAt: string;
  actor: string;
  subject: CostBudgetSubject;
  cost: CostBudgetData;
  context?: CostBudgetContext;
  summary?: string;
}

export interface CreateCostBudgetAuditRecordInput {
  observedAt: string;
  actor: string;
  subject: CostBudgetSubject;
  cost?: CostBudgetData;
  context?: CostBudgetContext;
  summary?: string;
  id?: string;
  dedupeKey?: string;
}

export interface CostBudgetAuditFilter {
  subject?: CostBudgetSubject;
  costKind?: CostDataKind;
  model?: string;
  runId?: string;
  actionId?: string;
  projectId?: string;
  goalId?: string;
}

export interface CostBudgetTotal {
  currency: string;
  amount: number;
}

export interface CostBudgetAuditSummary {
  total: number;
  measured: number;
  estimated: number;
  unknown: number;
  measuredTotals: CostBudgetTotal[];
  estimatedTotals: CostBudgetTotal[];
  latest?: CostBudgetAuditRecord;
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

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireString(value, "observedAt");
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error(`observedAt must be a valid date: ${timestamp}`);
  }
  return timestamp;
}

function requireNonNegativeAmount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function parseSubjectType(value: unknown): CostBudgetSubjectType {
  if (
    value === "run" ||
    value === "action" ||
    value === "project" ||
    value === "goal" ||
    value === "command" ||
    value === "model"
  ) {
    return value;
  }
  throw new Error(`unknown cost budget subject type: ${describeUnknown(value)}`);
}

function parseCostKind(value: unknown): CostDataKind {
  if (value === "measured" || value === "estimated" || value === "unknown") return value;
  throw new Error(`unknown cost data kind: ${describeUnknown(value)}`);
}

function normalizeSubject(value: unknown): CostBudgetSubject {
  const subject = requireRecord(value, "subject");
  return {
    type: parseSubjectType(subject.type),
    id: requireString(subject.id, "subject.id"),
  };
}

function normalizeCommandContext(value: unknown): CostBudgetCommandContext | undefined {
  if (value === undefined) return undefined;
  const command = requireRecord(value, "context.command");
  const args = command.args;
  if (!Array.isArray(args)) throw new Error("context.command.args must be an array");
  return {
    executable: requireString(command.executable, "context.command.executable"),
    args: args.map((arg) => requireString(arg, "context.command.args")),
  };
}

function normalizeContext(value: unknown): CostBudgetContext | undefined {
  if (value === undefined) return undefined;
  const context = requireRecord(value, "context");
  const normalized: CostBudgetContext = {
    model: optionalString(context.model, "context.model"),
    command: normalizeCommandContext(context.command),
    runId: optionalString(context.runId, "context.runId"),
    runLogPath: optionalString(context.runLogPath, "context.runLogPath"),
    projectId: optionalString(context.projectId, "context.projectId"),
    goalId: optionalString(context.goalId, "context.goalId"),
    planId: optionalString(context.planId, "context.planId"),
    actionId: optionalString(context.actionId, "context.actionId"),
    taskId: optionalString(context.taskId, "context.taskId"),
    agentId: optionalString(context.agentId, "context.agentId"),
    repoRoot: optionalString(context.repoRoot, "context.repoRoot"),
  };
  return Object.values(normalized).some((item) => item !== undefined) ? normalized : undefined;
}

function normalizeCost(value: unknown): CostBudgetData {
  if (value === undefined) {
    return {
      kind: "unknown",
      reason: "cost data was not provided",
    };
  }
  const cost = requireRecord(value, "cost");
  const kind = parseCostKind(cost.kind);
  if (kind === "unknown") {
    if (cost.amount !== undefined) throw new Error("unknown cost must not include amount");
    if (cost.currency !== undefined) throw new Error("unknown cost must not include currency");
    return {
      kind,
      reason: requireString(cost.reason, "cost.reason"),
    };
  }
  if (kind === "measured") {
    return {
      kind,
      amount: requireNonNegativeAmount(cost.amount, "cost.amount"),
      currency: requireString(cost.currency, "cost.currency").toUpperCase(),
      source: requireString(cost.source, "cost.source"),
    };
  }
  return {
    kind,
    amount: requireNonNegativeAmount(cost.amount, "cost.amount"),
    currency: requireString(cost.currency, "cost.currency").toUpperCase(),
    basis: requireString(cost.basis, "cost.basis"),
  };
}

function subjectKey(subject: CostBudgetSubject): string {
  return `${subject.type}:${subject.id}`;
}

function buildCostBudgetAuditId(input: Omit<CreateCostBudgetAuditRecordInput, "id">): string {
  const source = input.dedupeKey ?? [
    input.observedAt,
    input.actor,
    subjectKey(input.subject),
    JSON.stringify(input.cost ?? null),
    JSON.stringify(input.context ?? null),
    input.summary ?? "",
  ].join("|");

  return compactEntityId({
    prefix: "budget-audit",
    createdAt: input.observedAt,
    label: `${input.subject.type}-${input.subject.id}`,
    source,
  });
}

export function commandContextForBudgetAudit(
  command: string[] | undefined,
  options: { omitTrailingPrompt?: boolean } = {},
): CostBudgetCommandContext | undefined {
  if (!command?.length) return undefined;
  const executable = oneLine(command[0] ?? "");
  if (!executable) return undefined;
  const args = (options.omitTrailingPrompt ? command.slice(1, -1) : command.slice(1)).map(oneLine).filter(Boolean);
  return { executable, args };
}

export function createCostBudgetAuditRecord(input: CreateCostBudgetAuditRecordInput): CostBudgetAuditRecord {
  const observedAt = requireTimestamp(input.observedAt);
  const actor = requireString(input.actor, "actor");
  const subject = normalizeSubject(input.subject);
  const cost = normalizeCost(input.cost);
  const context = normalizeContext(input.context);
  const summary = optionalString(input.summary, "summary");
  const id = input.id ? requireString(input.id, "id") : buildCostBudgetAuditId({
    observedAt,
    actor,
    subject,
    cost,
    context,
    summary,
    dedupeKey: input.dedupeKey,
  });

  return {
    schemaVersion: 1,
    id,
    observedAt,
    actor,
    subject,
    cost,
    context,
    summary,
  };
}

export function createRunCostBudgetObservation(input: {
  observedAt: string;
  run: RunSummary;
  task?: TaskSpec;
  agent?: AgentProfile;
  action?: RemoteActionRecord;
  command?: string[];
  actor?: string;
  cost?: CostBudgetData;
  summary?: string;
}): CostBudgetAuditRecord {
  const action = input.action;
  const task = input.task;
  const agent = input.agent;
  return createCostBudgetAuditRecord({
    observedAt: input.observedAt,
    actor: input.actor ?? "samantha",
    subject: { type: "run", id: input.run.runId },
    cost: input.cost ?? {
      kind: "unknown",
      reason: "worker run did not report measured or estimated cost",
    },
    context: {
      model: agent?.model,
      command: commandContextForBudgetAudit(input.command, { omitTrailingPrompt: true }),
      runId: input.run.runId,
      runLogPath: input.run.logPath,
      projectId: task?.projectId,
      planId: action?.orchestratorPlanId,
      actionId: action?.id,
      taskId: input.run.taskId,
      agentId: agent?.id ?? input.run.agentId,
      repoRoot: input.run.repoRoot,
    },
    summary: input.summary ?? `Budget observation for run ${input.run.runId}.`,
  });
}

export function parseCostBudgetAuditRecord(value: unknown): CostBudgetAuditRecord {
  const record = requireRecord(value, "cost budget audit record");
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported cost budget audit schemaVersion: ${describeUnknown(record.schemaVersion)}`);
  }
  return createCostBudgetAuditRecord({
    id: requireString(record.id, "id"),
    observedAt: requireTimestamp(record.observedAt),
    actor: requireString(record.actor, "actor"),
    subject: normalizeSubject(record.subject),
    cost: normalizeCost(record.cost),
    context: normalizeContext(record.context),
    summary: optionalString(record.summary, "summary"),
  });
}

function matchesFilter(record: CostBudgetAuditRecord, filter: CostBudgetAuditFilter): boolean {
  if (filter.subject && subjectKey(record.subject) !== subjectKey(filter.subject)) return false;
  if (filter.costKind && record.cost.kind !== filter.costKind) return false;
  if (filter.model && record.context?.model !== filter.model) return false;
  if (filter.runId && record.context?.runId !== filter.runId) return false;
  if (filter.actionId && record.context?.actionId !== filter.actionId) return false;
  if (filter.projectId && record.context?.projectId !== filter.projectId) return false;
  if (filter.goalId && record.context?.goalId !== filter.goalId) return false;
  return true;
}

export async function loadCostBudgetAuditRecords(path: string): Promise<CostBudgetAuditRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: CostBudgetAuditRecord[] = [];
  const seenIds = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`malformed cost budget audit record at line ${index + 1}: invalid JSON`);
    }

    let record: CostBudgetAuditRecord;
    try {
      record = parseCostBudgetAuditRecord(parsed);
    } catch (err) {
      throw new Error(`malformed cost budget audit record at line ${index + 1}: ${(err as Error).message}`);
    }

    if (seenIds.has(record.id)) {
      throw new Error(`malformed cost budget audit record at line ${index + 1}: duplicate cost budget audit id: ${record.id}`);
    }
    seenIds.add(record.id);
    records.push(record);
  });
  return records;
}

function totalsByCurrency(records: CostBudgetAuditRecord[], kind: "measured" | "estimated"): CostBudgetTotal[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    if (record.cost.kind !== kind) continue;
    totals.set(record.cost.currency, (totals.get(record.cost.currency) ?? 0) + record.cost.amount);
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

export function summarizeCostBudgetAuditRecords(records: CostBudgetAuditRecord[]): CostBudgetAuditSummary {
  const latest = records.reduce<CostBudgetAuditRecord | undefined>((current, record) => {
    if (!current) return record;
    return Date.parse(record.observedAt) >= Date.parse(current.observedAt) ? record : current;
  }, undefined);
  return {
    total: records.length,
    measured: records.filter((record) => record.cost.kind === "measured").length,
    estimated: records.filter((record) => record.cost.kind === "estimated").length,
    unknown: records.filter((record) => record.cost.kind === "unknown").length,
    measuredTotals: totalsByCurrency(records, "measured"),
    estimatedTotals: totalsByCurrency(records, "estimated"),
    latest,
  };
}

export class CostBudgetAuditStore {
  constructor(private readonly path: string) {}

  async list(filter: CostBudgetAuditFilter = {}): Promise<CostBudgetAuditRecord[]> {
    const records = await loadCostBudgetAuditRecords(this.path);
    return Object.keys(filter).length ? records.filter((record) => matchesFilter(record, filter)) : records;
  }

  async find(id: string): Promise<CostBudgetAuditRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  async load(id: string): Promise<CostBudgetAuditRecord> {
    const record = await this.find(id);
    if (!record) throw new Error(`cost budget audit record not found: ${id}`);
    return record;
  }

  async append(record: CostBudgetAuditRecord): Promise<CostBudgetAuditRecord> {
    const normalized = parseCostBudgetAuditRecord(record);
    const records = await this.list();
    const existing = records.find((item) => item.id === normalized.id);
    if (existing) return existing;

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }

  async create(input: CreateCostBudgetAuditRecordInput): Promise<CostBudgetAuditRecord> {
    return this.append(createCostBudgetAuditRecord(input));
  }
}
