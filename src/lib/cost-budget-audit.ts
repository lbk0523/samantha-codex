import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOptionalWorkItemAncestry, type AssignedWorkItemAncestry, type WorkItemAncestry } from "./ancestry";
import type { AgentProfile, TaskSpec } from "./contracts";
import type { DecisionItem } from "./decision-store";
import type { GovernanceEventRecord } from "./governance-event-store";
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
  workItemId?: string;
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
  ancestry?: WorkItemAncestry;
  observedAt: string;
  actor: string;
  subject: CostBudgetSubject;
  cost: CostBudgetData;
  context?: CostBudgetContext;
  summary?: string;
}

export interface CreateCostBudgetAuditRecordInput {
  observedAt: string;
  ancestry?: WorkItemAncestry;
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
  workItemId?: string;
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

export type CostBudgetRollupDimension = "project" | "goal" | "action" | "run" | "model" | "command";

export interface CostBudgetAuditGap {
  recordId: string;
  reasons: string[];
}

export interface CostBudgetAuditRollup {
  dimension: CostBudgetRollupDimension;
  key: string;
  total: number;
  measured: number;
  estimated: number;
  unknown: number;
  measuredTotals: CostBudgetTotal[];
  estimatedTotals: CostBudgetTotal[];
  auditGaps: number;
}

export interface CostBudgetAuditRollupSummary {
  summary: CostBudgetAuditSummary;
  gaps: CostBudgetAuditGap[];
  rollups: Record<CostBudgetRollupDimension, CostBudgetAuditRollup[]>;
}

export type BudgetPolicyScopeType = "project" | "goal" | "work_item" | "run" | "action" | "model" | "provider";
export type BudgetPolicyStatus = "proposed" | "active" | "disabled";
export type BudgetEnforcementState = "ok" | "watch" | "defer" | "block" | "needs_bk";

export interface BudgetPolicyScope {
  type: BudgetPolicyScopeType;
  id: string;
}

export interface BudgetPolicyThresholds {
  currency: string;
  watchAtAmount?: number;
  deferAtAmount?: number;
  blockAtAmount?: number;
  unknownCost?: Exclude<BudgetEnforcementState, "ok">;
}

export interface BudgetPolicyGovernanceEvidence {
  decisionId: string;
  governanceEventId: string;
  approvedBy: "bk";
  approvedAt: string;
  summary: string;
}

export interface BudgetPolicyRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: BudgetPolicyStatus;
  scope: BudgetPolicyScope;
  thresholds: BudgetPolicyThresholds;
  includesEstimated: boolean;
  supersedesPolicyId?: string;
  governance?: BudgetPolicyGovernanceEvidence;
  summary?: string;
}

export interface CreateBudgetPolicyRecordInput {
  id?: string;
  createdAt: string;
  updatedAt?: string;
  status?: BudgetPolicyStatus;
  scope: BudgetPolicyScope;
  thresholds: BudgetPolicyThresholds;
  includesEstimated?: boolean;
  supersedesPolicyId?: string;
  governance?: BudgetPolicyGovernanceEvidence;
  summary?: string;
}

export interface BudgetEvaluationContext {
  projectId?: string;
  goalId?: string;
  workItemId?: string;
  runId?: string;
  actionId?: string;
  model?: string;
  provider?: string;
}

export interface BudgetPolicyEvaluation {
  policy: BudgetPolicyRecord;
  state: BudgetEnforcementState;
  reasons: string[];
  knownTotals: CostBudgetTotal[];
  unknownObservations: number;
  matchedObservations: number;
}

export interface BudgetEnforcementDecision {
  state: BudgetEnforcementState;
  reasons: string[];
  policyEvaluations: BudgetPolicyEvaluation[];
  governanceViolations: string[];
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
    workItemId: optionalString(context.workItemId, "context.workItemId"),
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

function parseBudgetPolicyScopeType(value: unknown): BudgetPolicyScopeType {
  if (
    value === "project" ||
    value === "goal" ||
    value === "work_item" ||
    value === "run" ||
    value === "action" ||
    value === "model" ||
    value === "provider"
  ) {
    return value;
  }
  throw new Error(`unknown budget policy scope type: ${describeUnknown(value)}`);
}

function parseBudgetPolicyStatus(value: unknown): BudgetPolicyStatus {
  if (value === "proposed" || value === "active" || value === "disabled") return value;
  throw new Error(`unknown budget policy status: ${describeUnknown(value)}`);
}

function parseBudgetEnforcementState(value: unknown): Exclude<BudgetEnforcementState, "ok"> {
  if (value === "watch" || value === "defer" || value === "block" || value === "needs_bk") return value;
  throw new Error(`unknown unknown-cost budget state: ${describeUnknown(value)}`);
}

function normalizeBudgetScope(value: unknown): BudgetPolicyScope {
  const scope = requireRecord(value, "scope");
  return {
    type: parseBudgetPolicyScopeType(scope.type),
    id: requireString(scope.id, "scope.id"),
  };
}

function optionalNonNegativeAmount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requireNonNegativeAmount(value, label);
}

function normalizeBudgetThresholds(value: unknown): BudgetPolicyThresholds {
  const thresholds = requireRecord(value, "thresholds");
  const normalized: BudgetPolicyThresholds = {
    currency: requireString(thresholds.currency, "thresholds.currency").toUpperCase(),
    watchAtAmount: optionalNonNegativeAmount(thresholds.watchAtAmount, "thresholds.watchAtAmount"),
    deferAtAmount: optionalNonNegativeAmount(thresholds.deferAtAmount, "thresholds.deferAtAmount"),
    blockAtAmount: optionalNonNegativeAmount(thresholds.blockAtAmount, "thresholds.blockAtAmount"),
    unknownCost:
      thresholds.unknownCost === undefined ? "defer" : parseBudgetEnforcementState(thresholds.unknownCost),
  };
  if (
    normalized.watchAtAmount === undefined &&
    normalized.deferAtAmount === undefined &&
    normalized.blockAtAmount === undefined &&
    normalized.unknownCost === undefined
  ) {
    throw new Error("budget policy thresholds require at least one limit");
  }
  if (
    normalized.watchAtAmount !== undefined &&
    normalized.deferAtAmount !== undefined &&
    normalized.watchAtAmount > normalized.deferAtAmount
  ) {
    throw new Error("thresholds.watchAtAmount must be less than or equal to thresholds.deferAtAmount");
  }
  if (
    normalized.deferAtAmount !== undefined &&
    normalized.blockAtAmount !== undefined &&
    normalized.deferAtAmount > normalized.blockAtAmount
  ) {
    throw new Error("thresholds.deferAtAmount must be less than or equal to thresholds.blockAtAmount");
  }
  if (
    normalized.watchAtAmount !== undefined &&
    normalized.blockAtAmount !== undefined &&
    normalized.watchAtAmount > normalized.blockAtAmount
  ) {
    throw new Error("thresholds.watchAtAmount must be less than or equal to thresholds.blockAtAmount");
  }
  return normalized;
}

function normalizeBudgetGovernance(value: unknown): BudgetPolicyGovernanceEvidence | undefined {
  if (value === undefined) return undefined;
  const governance = requireRecord(value, "governance");
  if (governance.approvedBy !== "bk") throw new Error("governance.approvedBy must be bk");
  return {
    decisionId: requireString(governance.decisionId, "governance.decisionId"),
    governanceEventId: requireString(governance.governanceEventId, "governance.governanceEventId"),
    approvedBy: "bk",
    approvedAt: requireTimestamp(governance.approvedAt),
    summary: requireString(governance.summary, "governance.summary"),
  };
}

function normalizeOptionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function buildBudgetPolicyId(input: Omit<CreateBudgetPolicyRecordInput, "id">): string {
  return compactEntityId({
    prefix: "budget-policy",
    createdAt: input.createdAt,
    label: `${input.scope.type}-${input.scope.id}`,
    source: [
      input.status ?? "proposed",
      `${input.scope.type}:${input.scope.id}`,
      JSON.stringify(input.thresholds),
      input.includesEstimated ?? true,
      input.supersedesPolicyId ?? "",
    ].join("|"),
  });
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
  const ancestry = parseOptionalWorkItemAncestry(input.ancestry);
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
    ancestry,
    observedAt,
    actor,
    subject,
    cost,
    context,
    summary,
  };
}

export function createBudgetPolicyRecord(input: CreateBudgetPolicyRecordInput): BudgetPolicyRecord {
  const createdAt = requireTimestamp(input.createdAt);
  const updatedAt = input.updatedAt ? requireTimestamp(input.updatedAt) : createdAt;
  const scope = normalizeBudgetScope(input.scope);
  const thresholds = normalizeBudgetThresholds(input.thresholds);
  const status = parseBudgetPolicyStatus(input.status ?? "proposed");
  const supersedesPolicyId = optionalString(input.supersedesPolicyId, "supersedesPolicyId");
  const governance = normalizeBudgetGovernance(input.governance);
  const summary = optionalString(input.summary, "summary");
  const id = input.id ? requireString(input.id, "id") : buildBudgetPolicyId({
    createdAt,
    updatedAt,
    status,
    scope,
    thresholds,
    includesEstimated: input.includesEstimated,
    supersedesPolicyId,
    governance,
    summary,
  });

  return {
    schemaVersion: 1,
    id,
    createdAt,
    updatedAt,
    status,
    scope,
    thresholds,
    includesEstimated: input.includesEstimated ?? true,
    supersedesPolicyId,
    governance,
    summary,
  };
}

export function parseBudgetPolicyRecord(value: unknown): BudgetPolicyRecord {
  const record = requireRecord(value, "budget policy record");
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported budget policy schemaVersion: ${describeUnknown(record.schemaVersion)}`);
  }
  return createBudgetPolicyRecord({
    id: requireString(record.id, "id"),
    createdAt: requireTimestamp(record.createdAt),
    updatedAt: requireTimestamp(record.updatedAt),
    status: parseBudgetPolicyStatus(record.status),
    scope: normalizeBudgetScope(record.scope),
    thresholds: normalizeBudgetThresholds(record.thresholds),
    includesEstimated: normalizeOptionalBoolean(record.includesEstimated, "includesEstimated", true),
    supersedesPolicyId: optionalString(record.supersedesPolicyId, "supersedesPolicyId"),
    governance: normalizeBudgetGovernance(record.governance),
    summary: optionalString(record.summary, "summary"),
  });
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
  const ancestry = task?.ancestry ?? action?.ancestry ?? input.run.ancestry;
  const assignedAncestry = ancestry?.mode === "assigned" ? ancestry : undefined;
  return createCostBudgetAuditRecord({
    observedAt: input.observedAt,
    ancestry,
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
      projectId: assignedAncestry?.projectId ?? task?.projectId,
      goalId: assignedAncestry?.goalId,
      workItemId: assignedAncestry?.workItemId,
      planId: action?.orchestratorPlanId,
      actionId: action?.id,
      taskId: input.run.taskId,
      agentId: agent?.id ?? input.run.agentId,
      repoRoot: input.run.repoRoot,
    },
    summary: input.summary ?? `Budget observation for run ${input.run.runId}.`,
  });
}

function assignedAncestry(record: CostBudgetAuditRecord): AssignedWorkItemAncestry | undefined {
  return record.ancestry?.mode === "assigned" ? record.ancestry : undefined;
}

export function projectIdForCostBudgetRecord(record: CostBudgetAuditRecord): string | undefined {
  return assignedAncestry(record)?.projectId ?? record.context?.projectId ?? (record.subject.type === "project" ? record.subject.id : undefined);
}

export function goalIdForCostBudgetRecord(record: CostBudgetAuditRecord): string | undefined {
  return assignedAncestry(record)?.goalId ?? record.context?.goalId ?? (record.subject.type === "goal" ? record.subject.id : undefined);
}

export function workItemIdForCostBudgetRecord(record: CostBudgetAuditRecord): string | undefined {
  return assignedAncestry(record)?.workItemId ?? record.context?.workItemId;
}

function actionIdForCostBudgetRecord(record: CostBudgetAuditRecord): string | undefined {
  return record.context?.actionId ?? (record.subject.type === "action" ? record.subject.id : undefined);
}

function runIdForCostBudgetRecord(record: CostBudgetAuditRecord): string | undefined {
  return record.context?.runId ?? (record.subject.type === "run" ? record.subject.id : undefined);
}

function commandKey(command: CostBudgetCommandContext | undefined): string | undefined {
  if (!command) return undefined;
  return [command.executable, ...command.args].join(" ");
}

function gapReasonsForCostBudgetRecord(record: CostBudgetAuditRecord): string[] {
  const reasons: string[] = [];
  if (record.cost.kind === "unknown") reasons.push("unknown_cost");
  if (!record.ancestry) reasons.push("missing_ancestry");
  else if (record.ancestry.mode === "legacy") reasons.push("legacy_ancestry");
  else if (record.ancestry.mode === "unassigned") reasons.push("unassigned_ancestry");
  if (!projectIdForCostBudgetRecord(record)) reasons.push("missing_project");
  if (!goalIdForCostBudgetRecord(record)) reasons.push("missing_goal");
  return reasons;
}

export function parseCostBudgetAuditRecord(value: unknown): CostBudgetAuditRecord {
  const record = requireRecord(value, "cost budget audit record");
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported cost budget audit schemaVersion: ${describeUnknown(record.schemaVersion)}`);
  }
  return createCostBudgetAuditRecord({
    id: requireString(record.id, "id"),
    ancestry: parseOptionalWorkItemAncestry(record.ancestry),
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
  if (filter.runId && runIdForCostBudgetRecord(record) !== filter.runId) return false;
  if (filter.actionId && actionIdForCostBudgetRecord(record) !== filter.actionId) return false;
  if (filter.projectId && projectIdForCostBudgetRecord(record) !== filter.projectId) return false;
  if (filter.goalId && goalIdForCostBudgetRecord(record) !== filter.goalId) return false;
  if (filter.workItemId && workItemIdForCostBudgetRecord(record) !== filter.workItemId) return false;
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

function rollupKey(record: CostBudgetAuditRecord, dimension: CostBudgetRollupDimension): string | undefined {
  if (dimension === "project") return projectIdForCostBudgetRecord(record);
  if (dimension === "goal") return goalIdForCostBudgetRecord(record);
  if (dimension === "action") return actionIdForCostBudgetRecord(record);
  if (dimension === "run") return runIdForCostBudgetRecord(record);
  if (dimension === "model") return record.context?.model;
  return commandKey(record.context?.command);
}

function rollupRecords(records: CostBudgetAuditRecord[], dimension: CostBudgetRollupDimension, gaps: Map<string, CostBudgetAuditGap>): CostBudgetAuditRollup[] {
  const grouped = new Map<string, CostBudgetAuditRecord[]>();
  for (const record of records) {
    const key = rollupKey(record, dimension);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return [...grouped.entries()]
    .map(([key, group]) => {
      const summary = summarizeCostBudgetAuditRecords(group);
      return {
        dimension,
        key,
        total: summary.total,
        measured: summary.measured,
        estimated: summary.estimated,
        unknown: summary.unknown,
        measuredTotals: summary.measuredTotals,
        estimatedTotals: summary.estimatedTotals,
        auditGaps: group.filter((record) => gaps.has(record.id)).length,
      };
    })
    .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
}

export function summarizeCostBudgetAuditRollups(records: CostBudgetAuditRecord[]): CostBudgetAuditRollupSummary {
  const gapEntries = records
    .map((record) => ({ recordId: record.id, reasons: gapReasonsForCostBudgetRecord(record) }))
    .filter((gap) => gap.reasons.length > 0);
  const gaps = new Map(gapEntries.map((gap) => [gap.recordId, gap]));
  return {
    summary: summarizeCostBudgetAuditRecords(records),
    gaps: gapEntries,
    rollups: {
      project: rollupRecords(records, "project", gaps),
      goal: rollupRecords(records, "goal", gaps),
      action: rollupRecords(records, "action", gaps),
      run: rollupRecords(records, "run", gaps),
      model: rollupRecords(records, "model", gaps),
      command: rollupRecords(records, "command", gaps),
    },
  };
}

function budgetScopeValueForContext(context: BudgetEvaluationContext, scope: BudgetPolicyScope): string | undefined {
  if (scope.type === "project") return context.projectId;
  if (scope.type === "goal") return context.goalId;
  if (scope.type === "work_item") return context.workItemId;
  if (scope.type === "run") return context.runId;
  if (scope.type === "action") return context.actionId;
  if (scope.type === "model") return context.model;
  return context.provider;
}

function budgetScopeValueForRecord(record: CostBudgetAuditRecord, scope: BudgetPolicyScope): string | undefined {
  if (scope.type === "project") return projectIdForCostBudgetRecord(record);
  if (scope.type === "goal") return goalIdForCostBudgetRecord(record);
  if (scope.type === "work_item") return workItemIdForCostBudgetRecord(record);
  if (scope.type === "run") return runIdForCostBudgetRecord(record);
  if (scope.type === "action") return actionIdForCostBudgetRecord(record);
  if (scope.type === "model") return record.context?.model ?? (record.subject.type === "model" ? record.subject.id : undefined);
  return undefined;
}

function contextHasBudgetScope(context: BudgetEvaluationContext): boolean {
  return Boolean(
    context.projectId ??
    context.goalId ??
    context.workItemId ??
    context.runId ??
    context.actionId ??
    context.model ??
    context.provider,
  );
}

export function budgetPolicyAppliesToContext(
  policy: BudgetPolicyRecord,
  context: BudgetEvaluationContext,
  observations: CostBudgetAuditRecord[] = [],
): boolean {
  const scopedValue = budgetScopeValueForContext(context, policy.scope);
  if (scopedValue !== undefined) return scopedValue === policy.scope.id;
  if (!contextHasBudgetScope(context)) return true;
  if (!context.projectId) return false;
  return observations.some((record) =>
    policyMatchesRecord(policy, record) && projectIdForCostBudgetRecord(record) === context.projectId
  );
}

function policyMatchesRecord(policy: BudgetPolicyRecord, record: CostBudgetAuditRecord): boolean {
  return budgetScopeValueForRecord(record, policy.scope) === policy.scope.id;
}

function stateOrder(state: BudgetEnforcementState): number {
  return { ok: 0, watch: 1, defer: 2, block: 3, needs_bk: 4 }[state];
}

function maxBudgetState(states: BudgetEnforcementState[]): BudgetEnforcementState {
  return states.sort((left, right) => stateOrder(right) - stateOrder(left))[0] ?? "ok";
}

function totalForCurrency(records: CostBudgetAuditRecord[], policy: BudgetPolicyRecord): CostBudgetTotal[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    if (record.cost.kind === "unknown") continue;
    if (record.cost.kind === "estimated" && !policy.includesEstimated) continue;
    totals.set(record.cost.currency, (totals.get(record.cost.currency) ?? 0) + record.cost.amount);
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

function knownAmountForPolicy(records: CostBudgetAuditRecord[], policy: BudgetPolicyRecord): number {
  let total = 0;
  for (const record of records) {
    if (record.cost.kind === "unknown") continue;
    if (record.cost.currency !== policy.thresholds.currency) continue;
    if (record.cost.kind === "estimated" && !policy.includesEstimated) continue;
    total += record.cost.amount;
  }
  return total;
}

function decisionApprovesBudgetPolicy(policy: BudgetPolicyRecord, decisions: DecisionItem[]): boolean {
  const decisionId = policy.governance?.decisionId;
  if (!decisionId) return false;
  return decisions.some((decision) =>
    decision.id === decisionId &&
    (decision.kind === "budget_change" || decision.kind === "risk_acceptance") &&
    decision.status === "resolved" &&
    decision.resolution === "approved" &&
    decision.resolvedBy === "bk" &&
    Boolean(decision.resolvedAt) &&
    decision.subject?.type === "budget" &&
    decision.subject.id === policy.id,
  );
}

function eventApprovesBudgetPolicy(policy: BudgetPolicyRecord, events: GovernanceEventRecord[]): boolean {
  const eventId = policy.governance?.governanceEventId;
  if (!eventId) return false;
  return events.some((event) =>
    event.id === eventId &&
    event.kind === "transition_approved" &&
    event.subject.type === "budget" &&
    event.subject.id === policy.id,
  );
}

export function validateBudgetPolicyGovernance(input: {
  policy: BudgetPolicyRecord;
  decisions?: DecisionItem[];
  governanceEvents?: GovernanceEventRecord[];
}): string[] {
  const policy = input.policy;
  if (policy.status !== "active") return [];
  const violations: string[] = [];
  if (!policy.governance) {
    violations.push(`budget policy ${policy.id} is active without governance evidence`);
    return violations;
  }
  if (policy.governance.approvedBy !== "bk") {
    violations.push(`budget policy ${policy.id} governance evidence must be approved by BK`);
  }
  if (!decisionApprovesBudgetPolicy(policy, input.decisions ?? [])) {
    violations.push(`budget policy ${policy.id} is missing approved BK budget_change decision evidence`);
  }
  if (!eventApprovesBudgetPolicy(policy, input.governanceEvents ?? [])) {
    violations.push(`budget policy ${policy.id} is missing transition_approved governance event evidence`);
  }
  return violations;
}

export function evaluateBudgetPolicy(
  policy: BudgetPolicyRecord,
  records: CostBudgetAuditRecord[],
): BudgetPolicyEvaluation {
  const matched = records.filter((record) => policyMatchesRecord(policy, record));
  const unknownObservations = matched.filter((record) => record.cost.kind === "unknown").length;
  const knownAmount = knownAmountForPolicy(matched, policy);
  const states: BudgetEnforcementState[] = ["ok"];
  const reasons: string[] = [];

  if (unknownObservations > 0) {
    states.push(policy.thresholds.unknownCost ?? "defer");
    reasons.push(`unknown cost observations=${unknownObservations} for ${policy.scope.type}:${policy.scope.id}`);
  }
  if (policy.thresholds.blockAtAmount !== undefined && knownAmount >= policy.thresholds.blockAtAmount) {
    states.push("block");
    reasons.push(`known ${policy.thresholds.currency} cost ${knownAmount} reached block limit ${policy.thresholds.blockAtAmount}`);
  } else if (policy.thresholds.deferAtAmount !== undefined && knownAmount >= policy.thresholds.deferAtAmount) {
    states.push("defer");
    reasons.push(`known ${policy.thresholds.currency} cost ${knownAmount} reached defer limit ${policy.thresholds.deferAtAmount}`);
  } else if (policy.thresholds.watchAtAmount !== undefined && knownAmount >= policy.thresholds.watchAtAmount) {
    states.push("watch");
    reasons.push(`known ${policy.thresholds.currency} cost ${knownAmount} reached watch limit ${policy.thresholds.watchAtAmount}`);
  }

  return {
    policy,
    state: maxBudgetState(states),
    reasons: reasons.length ? reasons : [`budget policy ${policy.id} is within deterministic limits`],
    knownTotals: totalForCurrency(matched, policy),
    unknownObservations,
    matchedObservations: matched.length,
  };
}

export function evaluateBudgetEnforcement(input: {
  policies?: BudgetPolicyRecord[];
  observations?: CostBudgetAuditRecord[];
  context?: BudgetEvaluationContext;
  decisions?: DecisionItem[];
  governanceEvents?: GovernanceEventRecord[];
}): BudgetEnforcementDecision {
  const context = input.context ?? {};
  const policies = (input.policies ?? []).filter((policy) =>
    policy.status !== "disabled" && budgetPolicyAppliesToContext(policy, context, input.observations ?? [])
  );
  if (!policies.length) {
    return {
      state: "ok",
      reasons: ["no active budget policy applies"],
      policyEvaluations: [],
      governanceViolations: [],
    };
  }

  const governanceViolations = policies.flatMap((policy) =>
    validateBudgetPolicyGovernance({
      policy,
      decisions: input.decisions,
      governanceEvents: input.governanceEvents,
    }),
  );
  if (governanceViolations.length) {
    return {
      state: "needs_bk",
      reasons: governanceViolations,
      policyEvaluations: [],
      governanceViolations,
    };
  }

  const active = policies.filter((policy) => policy.status === "active");
  const proposed = policies.filter((policy) => policy.status === "proposed");
  const policyEvaluations = active.map((policy) => evaluateBudgetPolicy(policy, input.observations ?? []));
  const states = policyEvaluations.map((evaluation) => evaluation.state);
  const reasons = policyEvaluations.flatMap((evaluation) =>
    evaluation.state === "ok" ? [] : evaluation.reasons.map((reason) => `${evaluation.policy.id}: ${reason}`),
  );
  if (proposed.length > 0 && active.length === 0) {
    return {
      state: "needs_bk",
      reasons: proposed.map((policy) => `budget policy ${policy.id} is proposed and needs BK approval before enforcement`),
      policyEvaluations,
      governanceViolations: [],
    };
  }

  const state = maxBudgetState(states);
  return {
    state,
    reasons: reasons.length ? reasons : ["budget policy limits are ok"],
    policyEvaluations,
    governanceViolations: [],
  };
}

export async function loadBudgetPolicyRecords(path: string): Promise<BudgetPolicyRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: BudgetPolicyRecord[] = [];
  const seenIds = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`malformed budget policy record at line ${index + 1}: invalid JSON`);
    }

    let record: BudgetPolicyRecord;
    try {
      record = parseBudgetPolicyRecord(parsed);
    } catch (err) {
      throw new Error(`malformed budget policy record at line ${index + 1}: ${(err as Error).message}`);
    }

    if (seenIds.has(record.id)) {
      throw new Error(`malformed budget policy record at line ${index + 1}: duplicate budget policy id: ${record.id}`);
    }
    seenIds.add(record.id);
    records.push(record);
  });
  return records;
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

export class BudgetPolicyStore {
  constructor(private readonly path: string) {}

  async list(): Promise<BudgetPolicyRecord[]> {
    return loadBudgetPolicyRecords(this.path);
  }

  async find(id: string): Promise<BudgetPolicyRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  async load(id: string): Promise<BudgetPolicyRecord> {
    const record = await this.find(id);
    if (!record) throw new Error(`budget policy not found: ${id}`);
    return record;
  }

  async append(record: BudgetPolicyRecord): Promise<BudgetPolicyRecord> {
    const normalized = parseBudgetPolicyRecord(record);
    const records = await this.list();
    const existing = records.find((item) => item.id === normalized.id);
    if (existing) return existing;

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }

  async create(input: CreateBudgetPolicyRecordInput): Promise<BudgetPolicyRecord> {
    return this.append(createBudgetPolicyRecord(input));
  }
}
