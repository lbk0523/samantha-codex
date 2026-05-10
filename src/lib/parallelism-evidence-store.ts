import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOptionalWorkItemAncestry, type WorkItemAncestry } from "./ancestry";
import type { AgentRole, TaskResultMode } from "./contracts";
import { compactEntityId } from "./ids";
import type { OrchestratorPlanRecord } from "./orchestrator-store";
import { DEFAULT_SAFETY_POLICY } from "./policy";
import type { RemoteActionRecord } from "./remote-action-store";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { WorkerRunLog } from "./run-log";

export type ParallelismEvidenceOutcome = "pass" | "failed" | "mixed" | "blocked";
export type ParallelismEvidenceGateStatus = "not_applicable" | "pending" | "completed" | "failed" | "blocked";

export interface ParallelismEvidenceRef {
  taskId: string;
  actionId?: string;
  runId?: string;
  runLogPath?: string;
  agentId: string;
  agentRole: AgentRole;
  resultMode: TaskResultMode;
  outcome: ParallelismEvidenceOutcome;
  changedFiles: string[];
}

export interface ParallelismEvidenceVerification {
  pass: boolean;
  summary: string;
  failedCommands?: string[];
}

export interface ParallelismWriterConflictSafety {
  schemaVersion: 1;
  evaluatedAt: string;
  advisoryOnly: true;
  advisorySafe: boolean;
  mayIncreaseWriterCap: false;
  writerCap: number;
  candidateCount: number;
  violations: string[];
}

export interface ParallelismEvidenceRecord {
  schemaVersion: 1;
  id: string;
  observedAt: string;
  planId: string;
  ancestry?: WorkItemAncestry;
  batches: string[][];
  refs: ParallelismEvidenceRef[];
  agentRoles: AgentRole[];
  resultModes: TaskResultMode[];
  writerCount: number;
  changedFiles: string[];
  verification: ParallelismEvidenceVerification;
  mergeStatus: ParallelismEvidenceGateStatus;
  cleanupStatus: ParallelismEvidenceGateStatus;
  outcome: ParallelismEvidenceOutcome;
  summary?: string;
  writerConflictSafety?: ParallelismWriterConflictSafety;
}

export interface CreateParallelismEvidenceInput {
  observedAt: string;
  planId: string;
  ancestry?: WorkItemAncestry;
  batches: string[][];
  refs: ParallelismEvidenceRef[];
  verification: ParallelismEvidenceVerification;
  mergeStatus: ParallelismEvidenceGateStatus;
  cleanupStatus: ParallelismEvidenceGateStatus;
  outcome: ParallelismEvidenceOutcome;
  changedFiles?: string[];
  summary?: string;
  writerConflictSafety?: ParallelismWriterConflictSafety;
  id?: string;
  dedupeKey?: string;
}

export interface ParallelismEvidenceFilter {
  planId?: string;
  projectId?: string;
  goalId?: string;
  workItemId?: string;
  outcome?: ParallelismEvidenceOutcome;
  role?: AgentRole;
  resultMode?: TaskResultMode;
  taskId?: string;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return uniqueStrings(value.map((item) => requireString(item, label)));
}

function normalizeBatches(value: unknown): string[][] {
  if (!Array.isArray(value)) throw new Error("batches must be an array");
  return value.map((batch, index) => {
    if (!Array.isArray(batch)) throw new Error(`batches.${index} must be an array`);
    return batch.map((item) => requireString(item, `batches.${index}`));
  });
}

function parseAgentRole(value: unknown): AgentRole {
  if (
    value === "writer" ||
    value === "reviewer" ||
    value === "evaluator" ||
    value === "spec" ||
    value === "researcher" ||
    value === "content" ||
    value === "operations"
  ) {
    return value;
  }
  throw new Error(`unknown agent role: ${describeUnknown(value)}`);
}

function parseResultMode(value: unknown): TaskResultMode {
  if (value === "write" || value === "report") return value;
  throw new Error(`unknown result mode: ${describeUnknown(value)}`);
}

function parseOutcome(value: unknown): ParallelismEvidenceOutcome {
  if (value === "pass" || value === "failed" || value === "mixed" || value === "blocked") return value;
  throw new Error(`unknown parallelism evidence outcome: ${describeUnknown(value)}`);
}

function parseGateStatus(value: unknown): ParallelismEvidenceGateStatus {
  if (
    value === "not_applicable" ||
    value === "pending" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked"
  ) {
    return value;
  }
  throw new Error(`unknown parallelism evidence gate status: ${describeUnknown(value)}`);
}

function normalizeVerification(value: unknown): ParallelismEvidenceVerification {
  const verification = requireRecord(value, "verification");
  const pass = verification.pass;
  if (typeof pass !== "boolean") throw new Error("verification.pass must be a boolean");
  const failedCommands = verification.failedCommands === undefined
    ? undefined
    : normalizeStringList(verification.failedCommands, "verification.failedCommands");
  return {
    pass,
    summary: requireString(verification.summary, "verification.summary"),
    failedCommands: failedCommands?.length ? failedCommands : undefined,
  };
}

function normalizeWriterConflictSafety(value: unknown): ParallelismWriterConflictSafety | undefined {
  if (value === undefined) return undefined;
  const safety = requireRecord(value, "writerConflictSafety");
  if (safety.schemaVersion !== 1) {
    throw new Error(`writerConflictSafety.schemaVersion must be 1`);
  }
  if (safety.advisoryOnly !== true) throw new Error("writerConflictSafety.advisoryOnly must be true");
  if (typeof safety.advisorySafe !== "boolean") throw new Error("writerConflictSafety.advisorySafe must be a boolean");
  if (safety.mayIncreaseWriterCap !== false) {
    throw new Error("writerConflictSafety.mayIncreaseWriterCap must be false");
  }
  const writerCap = safety.writerCap;
  const candidateCount = safety.candidateCount;
  if (typeof writerCap !== "number" || !Number.isInteger(writerCap) || writerCap < 1) {
    throw new Error("writerConflictSafety.writerCap must be a positive integer");
  }
  if (typeof candidateCount !== "number" || !Number.isInteger(candidateCount) || candidateCount < 0) {
    throw new Error("writerConflictSafety.candidateCount must be a non-negative integer");
  }
  return {
    schemaVersion: 1,
    evaluatedAt: requireTimestamp(safety.evaluatedAt),
    advisoryOnly: true,
    advisorySafe: safety.advisorySafe,
    mayIncreaseWriterCap: false,
    writerCap,
    candidateCount,
    violations: normalizeStringList(safety.violations ?? [], "writerConflictSafety.violations"),
  };
}

function normalizeRef(value: unknown): ParallelismEvidenceRef {
  const ref = requireRecord(value, "ref");
  return {
    taskId: requireString(ref.taskId, "ref.taskId"),
    actionId: optionalString(ref.actionId, "ref.actionId"),
    runId: optionalString(ref.runId, "ref.runId"),
    runLogPath: optionalString(ref.runLogPath, "ref.runLogPath"),
    agentId: requireString(ref.agentId, "ref.agentId"),
    agentRole: parseAgentRole(ref.agentRole),
    resultMode: parseResultMode(ref.resultMode),
    outcome: parseOutcome(ref.outcome),
    changedFiles: normalizeStringList(ref.changedFiles ?? [], "ref.changedFiles"),
  };
}

function roleForAgentId(agentId: string): AgentRole {
  if (agentId === "codex-worker") return "writer";
  if (agentId === "codex-reviewer") return "reviewer";
  if (agentId === "codex-evaluator") return "evaluator";
  if (agentId === "codex-spec") return "spec";
  if (agentId === "codex-researcher") return "researcher";
  if (agentId === "codex-content") return "content";
  if (agentId === "codex-operations") return "operations";
  return "operations";
}

function resultModeForRef(input: { action: RemoteActionRecord; runLog?: WorkerRunLog }): TaskResultMode {
  if (input.runLog?.task.resultMode) return input.runLog.task.resultMode;
  return input.action.targetAgent === "codex-worker" ? "write" : "report";
}

function outcomeForAction(action: RemoteActionRecord): ParallelismEvidenceOutcome {
  if (action.status === "pending" || action.status === "waiting" || action.status === "approved" || action.status === "running") {
    return "blocked";
  }
  if (action.status === "failed" || action.result?.pass === false) return "failed";
  return "pass";
}

function recordOutcome(refs: ParallelismEvidenceRef[]): ParallelismEvidenceOutcome {
  if (refs.some((ref) => ref.outcome === "blocked")) return "blocked";
  const failed = refs.some((ref) => ref.outcome === "failed");
  const passed = refs.some((ref) => ref.outcome === "pass");
  if (failed && passed) return "mixed";
  return failed ? "failed" : "pass";
}

function failedCommandsForRunLog(runLog: WorkerRunLog): string[] {
  return runLog.result.evaluation?.verifyResults
    .filter((result) => result.exitCode !== 0)
    .map((result) => result.command) ?? [];
}

function gateStatusForWriterRefs(
  refs: ParallelismEvidenceRef[],
  lifecycles: RunLifecycleRecord[] | undefined,
  field: "mergedAt" | "cleanedAt",
): ParallelismEvidenceGateStatus {
  const writerRefs = refs.filter((ref) => ref.resultMode === "write" || ref.agentRole === "writer");
  const writerCount = writerRefs.length;
  if (writerCount === 0) return "not_applicable";
  if (writerRefs.some((ref) => ref.outcome === "failed")) return field === "mergedAt" ? "failed" : "blocked";
  if (writerRefs.some((ref) => ref.outcome === "blocked")) return "blocked";
  if (!lifecycles?.length) return "pending";
  const lifecycleRunIds = new Set(lifecycles.filter((lifecycle) => lifecycle[field]).map((lifecycle) => lifecycle.runId));
  return writerRefs.every((ref) => ref.runId && lifecycleRunIds.has(ref.runId)) ? "completed" : "pending";
}

function buildParallelismEvidenceId(input: Omit<CreateParallelismEvidenceInput, "id">): string {
  const source = input.dedupeKey ?? [
    input.observedAt,
    input.planId,
    JSON.stringify(input.batches),
    input.refs.map((ref) => `${ref.taskId}:${ref.actionId ?? ""}:${ref.runId ?? ""}:${ref.outcome}`).join("|"),
    input.outcome,
  ].join("|");

  return compactEntityId({
    prefix: "parallel-evidence",
    createdAt: input.observedAt,
    label: input.planId,
    source,
  });
}

export function createParallelismEvidenceRecord(input: CreateParallelismEvidenceInput): ParallelismEvidenceRecord {
  const observedAt = requireTimestamp(input.observedAt);
  const planId = requireString(input.planId, "planId");
  const ancestry = parseOptionalWorkItemAncestry(input.ancestry);
  const batches = normalizeBatches(input.batches);
  const refs = input.refs.map(normalizeRef);
  if (refs.length === 0) throw new Error("parallelism evidence requires at least one ref");
  const writerCount = refs.filter((ref) => ref.resultMode === "write" || ref.agentRole === "writer").length;
  if (writerCount > DEFAULT_SAFETY_POLICY.writerCap) {
    throw new Error(`parallelism evidence writerCount exceeds policy cap: ${writerCount} > ${DEFAULT_SAFETY_POLICY.writerCap}`);
  }
  const changedFiles = normalizeStringList(input.changedFiles ?? refs.flatMap((ref) => ref.changedFiles), "changedFiles");
  if (writerCount === 0 && changedFiles.length > 0) {
    throw new Error("report-only parallel evidence must not include changed files");
  }
  const agentRoles = uniqueStrings(refs.map((ref) => ref.agentRole)) as AgentRole[];
  const resultModes = uniqueStrings(refs.map((ref) => ref.resultMode)) as TaskResultMode[];
  const verification = normalizeVerification(input.verification);
  const mergeStatus = parseGateStatus(input.mergeStatus);
  const cleanupStatus = parseGateStatus(input.cleanupStatus);
  const outcome = parseOutcome(input.outcome);
  const summary = optionalString(input.summary, "summary");
  const writerConflictSafety = normalizeWriterConflictSafety(input.writerConflictSafety);
  const id = input.id ? requireString(input.id, "id") : buildParallelismEvidenceId({
    observedAt,
    planId,
    ancestry,
    batches,
    refs,
    verification,
    mergeStatus,
    cleanupStatus,
    outcome,
    changedFiles,
    summary,
    dedupeKey: input.dedupeKey,
  });

  return {
    schemaVersion: 1,
    id,
    observedAt,
    planId,
    ancestry,
    batches,
    refs,
    agentRoles,
    resultModes,
    writerCount,
    changedFiles,
    verification,
    mergeStatus,
    cleanupStatus,
    outcome,
    summary,
    writerConflictSafety,
  };
}

export function createParallelismEvidenceFromPlanResult(input: {
  observedAt: string;
  plan: OrchestratorPlanRecord;
  actions: RemoteActionRecord[];
  runLogs: WorkerRunLog[];
  lifecycles?: RunLifecycleRecord[];
  summary?: string;
  writerConflictSafety?: ParallelismWriterConflictSafety;
}): ParallelismEvidenceRecord {
  const runLogForAction = (action: RemoteActionRecord) =>
    input.runLogs.find((log) => log.runId === action.result?.runId || log.task.id === action.taskId);
  const refs = input.actions.map((action) => {
    const runLog = runLogForAction(action);
    return {
      taskId: action.taskId,
      actionId: action.id,
      runId: action.result?.runId ?? runLog?.runId,
      runLogPath: action.result?.runLogPath,
      agentId: runLog?.agent.id ?? action.targetAgent,
      agentRole: runLog?.agent.role ?? roleForAgentId(action.targetAgent),
      resultMode: resultModeForRef({ action, runLog }),
      outcome: outcomeForAction(action),
      changedFiles: runLog?.result.evaluation?.changedFiles ?? runLog?.result.commit?.files ?? [],
    };
  });
  const outcome = recordOutcome(refs);
  const failedCommands = uniqueStrings(input.runLogs.flatMap(failedCommandsForRunLog));

  return createParallelismEvidenceRecord({
    observedAt: input.observedAt,
    planId: input.plan.id,
    ancestry: input.plan.ancestry,
    batches: input.plan.payload?.batches ?? [input.actions.map((action) => action.taskId)],
    refs,
    verification: {
      pass: outcome === "pass",
      summary: outcome === "pass"
        ? `Recorded ${refs.length} parallelism evidence refs.`
        : `Recorded preserved evidence with outcome ${outcome}.`,
      failedCommands: failedCommands.length ? failedCommands : undefined,
    },
    mergeStatus: gateStatusForWriterRefs(refs, input.lifecycles, "mergedAt"),
    cleanupStatus: gateStatusForWriterRefs(refs, input.lifecycles, "cleanedAt"),
    outcome,
    summary: input.summary,
    writerConflictSafety: input.writerConflictSafety,
  });
}

export function parseParallelismEvidenceRecord(value: unknown): ParallelismEvidenceRecord {
  const record = requireRecord(value, "parallelism evidence record");
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported parallelism evidence schemaVersion: ${describeUnknown(record.schemaVersion)}`);
  }
  if (!Array.isArray(record.refs)) throw new Error("refs must be an array");
  return createParallelismEvidenceRecord({
    id: requireString(record.id, "id"),
    observedAt: requireTimestamp(record.observedAt),
    planId: requireString(record.planId, "planId"),
    ancestry: parseOptionalWorkItemAncestry(record.ancestry),
    batches: normalizeBatches(record.batches),
    refs: record.refs.map(normalizeRef),
    verification: normalizeVerification(record.verification),
    mergeStatus: parseGateStatus(record.mergeStatus),
    cleanupStatus: parseGateStatus(record.cleanupStatus),
    outcome: parseOutcome(record.outcome),
    changedFiles: record.changedFiles === undefined ? undefined : normalizeStringList(record.changedFiles, "changedFiles"),
    summary: optionalString(record.summary, "summary"),
    writerConflictSafety: normalizeWriterConflictSafety(record.writerConflictSafety),
  });
}

function projectIdForEvidence(record: ParallelismEvidenceRecord): string | undefined {
  return record.ancestry?.mode === "assigned" ? record.ancestry.projectId : undefined;
}

function goalIdForEvidence(record: ParallelismEvidenceRecord): string | undefined {
  return record.ancestry?.mode === "assigned" ? record.ancestry.goalId : undefined;
}

function workItemIdForEvidence(record: ParallelismEvidenceRecord): string | undefined {
  return record.ancestry?.mode === "assigned" ? record.ancestry.workItemId : undefined;
}

function matchesFilter(record: ParallelismEvidenceRecord, filter: ParallelismEvidenceFilter): boolean {
  if (filter.planId && record.planId !== filter.planId) return false;
  if (filter.projectId && projectIdForEvidence(record) !== filter.projectId) return false;
  if (filter.goalId && goalIdForEvidence(record) !== filter.goalId) return false;
  if (filter.workItemId && workItemIdForEvidence(record) !== filter.workItemId) return false;
  if (filter.outcome && record.outcome !== filter.outcome) return false;
  if (filter.role && !record.agentRoles.includes(filter.role)) return false;
  if (filter.resultMode && !record.resultModes.includes(filter.resultMode)) return false;
  if (filter.taskId && !record.refs.some((ref) => ref.taskId === filter.taskId)) return false;
  if (filter.actionId && !record.refs.some((ref) => ref.actionId === filter.actionId)) return false;
  if (filter.runId && !record.refs.some((ref) => ref.runId === filter.runId)) return false;
  return true;
}

export async function loadParallelismEvidenceRecords(path: string): Promise<ParallelismEvidenceRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: ParallelismEvidenceRecord[] = [];
  const seenIds = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`malformed parallelism evidence at line ${index + 1}: invalid JSON`);
    }

    let record: ParallelismEvidenceRecord;
    try {
      record = parseParallelismEvidenceRecord(parsed);
    } catch (err) {
      throw new Error(`malformed parallelism evidence at line ${index + 1}: ${(err as Error).message}`);
    }

    if (seenIds.has(record.id)) {
      throw new Error(`malformed parallelism evidence at line ${index + 1}: duplicate parallelism evidence id: ${record.id}`);
    }
    seenIds.add(record.id);
    records.push(record);
  });
  return records;
}

export class ParallelismEvidenceStore {
  constructor(private readonly path: string) {}

  async list(filter: ParallelismEvidenceFilter = {}): Promise<ParallelismEvidenceRecord[]> {
    const records = await loadParallelismEvidenceRecords(this.path);
    return Object.keys(filter).length ? records.filter((record) => matchesFilter(record, filter)) : records;
  }

  async find(id: string): Promise<ParallelismEvidenceRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  async load(id: string): Promise<ParallelismEvidenceRecord> {
    const record = await this.find(id);
    if (!record) throw new Error(`parallelism evidence not found: ${id}`);
    return record;
  }

  async append(record: ParallelismEvidenceRecord): Promise<ParallelismEvidenceRecord> {
    const normalized = parseParallelismEvidenceRecord(record);
    const records = await this.list();
    const existing = records.find((item) => item.id === normalized.id);
    if (existing) return existing;

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }

  async create(input: CreateParallelismEvidenceInput): Promise<ParallelismEvidenceRecord> {
    return this.append(createParallelismEvidenceRecord(input));
  }
}
