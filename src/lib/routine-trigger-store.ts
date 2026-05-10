import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskSpec } from "./contracts";
import type { DecisionItem } from "./decision-store";
import {
  parseGovernanceRiskClass,
  type GovernanceRiskClass,
} from "./governance-taxonomy";
import { compactEntityId } from "./ids";
import { buildOrchestrationRequestId, type OrchestrationRequestRecord, type OrchestratorPlanRecord } from "./orchestrator-store";
import { assignedOrchestrationAncestry } from "./orchestration-ancestry";
import type { QueueAdmissionRecord } from "./queue-admission";
import type { RemoteActionRecord } from "./remote-action-store";
import { riskPolicyAllowsTransition, type RiskApprovalEvidence, type RiskPolicyDecision } from "./risk-policy";

export const ROUTINE_TRIGGER_SOURCE_KINDS = ["schedule", "webhook", "api"] as const;
export type RoutineTriggerSourceKind = (typeof ROUTINE_TRIGGER_SOURCE_KINDS)[number];

export const ROUTINE_TRIGGER_OBSERVATION_STATUSES = [
  "recorded",
  "coalesced",
  "ignored_disabled",
  "ignored_stale",
] as const;
export type RoutineTriggerObservationStatus = (typeof ROUTINE_TRIGGER_OBSERVATION_STATUSES)[number];

export interface RoutineTriggerFingerprintInput {
  key: string;
  value: string;
}

export interface RoutineTriggerAuthority {
  dispatch: false;
  approve: false;
  merge: false;
  push: false;
  cleanup: false;
  recover: false;
  bypassProjectGates: false;
  expandConnectorAuthority: false;
  expandSecretAuthority: false;
}

export const ROUTINE_TRIGGER_INTAKE_ONLY_AUTHORITY: RoutineTriggerAuthority = {
  dispatch: false,
  approve: false,
  merge: false,
  push: false,
  cleanup: false,
  recover: false,
  bypassProjectGates: false,
  expandConnectorAuthority: false,
  expandSecretAuthority: false,
};

export interface RoutineTriggerRecord {
  schemaVersion: 1;
  id: string;
  triggerId: string;
  sourceKind: RoutineTriggerSourceKind;
  projectId: string;
  enabled: boolean;
  riskClass: GovernanceRiskClass;
  sourceEvidence: string[];
  fingerprintInputs: RoutineTriggerFingerprintInput[];
  fingerprint: string;
  authority: RoutineTriggerAuthority;
  createdAt: string;
  updatedAt: string;
  staleAfter?: string;
  activationDecisionId?: string;
}

export interface CreateRoutineTriggerRecordInput {
  triggerId: string;
  sourceKind: RoutineTriggerSourceKind;
  projectId: string;
  enabled: boolean;
  riskClass: GovernanceRiskClass;
  sourceEvidence: string[];
  fingerprintInputs: RoutineTriggerFingerprintInput[];
  createdAt: string;
  updatedAt?: string;
  staleAfter?: string;
  activationDecisionId?: string;
  id?: string;
  authority?: Partial<Record<keyof RoutineTriggerAuthority, boolean>>;
}

export type RoutineActiveWorkKind = "request" | "plan" | "task" | "action" | "decision";

export interface RoutineActiveWorkRef {
  kind: RoutineActiveWorkKind;
  id: string;
  status: string;
  routineTriggerId?: string;
  routineFingerprint: string;
}

export interface RoutineFingerprintCoalescingInput {
  fingerprint: string;
  requests?: OrchestrationRequestRecord[];
  plans?: OrchestratorPlanRecord[];
  tasks?: TaskSpec[];
  actions?: RemoteActionRecord[];
  decisions?: DecisionItem[];
}

export interface RoutineTriggerObservationRecord {
  schemaVersion: 1;
  id: string;
  triggerId: string;
  routineId: string;
  sourceKind: RoutineTriggerSourceKind;
  projectId: string;
  observedAt: string;
  status: RoutineTriggerObservationStatus;
  fingerprint: string;
  fingerprintInputs: RoutineTriggerFingerprintInput[];
  sourceEvidence: string[];
  coalescedWith?: RoutineActiveWorkRef[];
  admission?: QueueAdmissionRecord;
}

export interface CreateRoutineTriggerObservationInput {
  trigger: RoutineTriggerRecord;
  observedAt: string;
  sourceEvidence?: string[];
  activeWork?: Omit<RoutineFingerprintCoalescingInput, "fingerprint">;
  admission?: QueueAdmissionRecord;
  id?: string;
}

export interface RoutineObservationRequestInput {
  trigger: RoutineTriggerRecord;
  observation: RoutineTriggerObservationRecord;
  requestText: string;
  createdAt?: string;
  requestId?: string;
  source?: OrchestrationRequestRecord["source"];
  senderId?: string;
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

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error(`${label} must be a valid date: ${timestamp}`);
  }
  return timestamp;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireTimestamp(value, label);
}

function parseSourceKind(value: unknown): RoutineTriggerSourceKind {
  if (typeof value === "string" && (ROUTINE_TRIGGER_SOURCE_KINDS as readonly string[]).includes(value)) {
    return value as RoutineTriggerSourceKind;
  }
  throw new Error(`unknown routine trigger source kind: ${describeUnknown(value)}`);
}

function parseObservationStatus(value: unknown): RoutineTriggerObservationStatus {
  if (typeof value === "string" && (ROUTINE_TRIGGER_OBSERVATION_STATUSES as readonly string[]).includes(value)) {
    return value as RoutineTriggerObservationStatus;
  }
  throw new Error(`unknown routine trigger observation status: ${describeUnknown(value)}`);
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = [...new Set(value.map((item) => requireString(item, label)))];
  if (normalized.length === 0) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeFingerprintInputs(value: unknown): RoutineTriggerFingerprintInput[] {
  if (!Array.isArray(value)) throw new Error("fingerprintInputs must be an array");
  const inputs = value.map((item, index) => {
    const input = requireRecord(item, `fingerprintInputs[${index}]`);
    return {
      key: requireString(input.key, `fingerprintInputs[${index}].key`),
      value: requireString(input.value, `fingerprintInputs[${index}].value`),
    };
  });
  if (inputs.length === 0) throw new Error("fingerprintInputs is required");

  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.key)) throw new Error(`duplicate fingerprint input key: ${input.key}`);
    seen.add(input.key);
  }
  return inputs.slice().sort((left, right) => left.key.localeCompare(right.key) || left.value.localeCompare(right.value));
}

function normalizeAuthority(value: unknown): RoutineTriggerAuthority {
  const authority = value === undefined ? {} : requireRecord(value, "authority");
  for (const key of Object.keys(ROUTINE_TRIGGER_INTAKE_ONLY_AUTHORITY) as Array<keyof RoutineTriggerAuthority>) {
    const field = authority[key];
    if (field !== undefined && field !== false) {
      throw new Error(`routine triggers are intake records only: authority.${key} must be false`);
    }
  }
  return { ...ROUTINE_TRIGGER_INTAKE_ONLY_AUTHORITY };
}

function normalizeActiveWorkRefs(value: unknown): RoutineActiveWorkRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("coalescedWith must be an array");
  const refs = value.map((item, index) => {
    const ref = requireRecord(item, `coalescedWith[${index}]`);
    const kind = requireString(ref.kind, `coalescedWith[${index}].kind`);
    if (!["request", "plan", "task", "action", "decision"].includes(kind)) {
      throw new Error(`unknown routine active work kind: ${kind}`);
    }
    return {
      kind: kind as RoutineActiveWorkKind,
      id: requireString(ref.id, `coalescedWith[${index}].id`),
      status: requireString(ref.status, `coalescedWith[${index}].status`),
      routineTriggerId: ref.routineTriggerId === undefined ? undefined : requireString(ref.routineTriggerId, `coalescedWith[${index}].routineTriggerId`),
      routineFingerprint: requireString(ref.routineFingerprint, `coalescedWith[${index}].routineFingerprint`),
    };
  });
  return refs.length ? refs : undefined;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeJsonLines<T>(path: string, items: T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const raw = items.map((item) => JSON.stringify(item)).join("\n");
  await writeFile(path, raw.length ? `${raw}\n` : "", "utf8");
}

export function buildRoutineTriggerFingerprint(input: {
  triggerId: string;
  projectId: string;
  sourceKind: RoutineTriggerSourceKind;
  fingerprintInputs: RoutineTriggerFingerprintInput[];
}): string {
  const canonical = JSON.stringify({
    triggerId: requireString(input.triggerId, "triggerId"),
    projectId: requireString(input.projectId, "projectId"),
    sourceKind: parseSourceKind(input.sourceKind),
    fingerprintInputs: normalizeFingerprintInputs(input.fingerprintInputs),
  });
  return `routine-fp-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

export function buildRoutineTriggerRecordId(input: {
  triggerId: string;
  projectId: string;
  createdAt: string;
}): string {
  return compactEntityId({
    prefix: "routine",
    createdAt: requireTimestamp(input.createdAt, "createdAt"),
    label: input.triggerId,
    source: `${input.projectId}|${input.triggerId}`,
  });
}

export function createRoutineTriggerRecord(input: CreateRoutineTriggerRecordInput): RoutineTriggerRecord {
  const triggerId = requireString(input.triggerId, "triggerId");
  const projectId = requireString(input.projectId, "projectId");
  const sourceKind = parseSourceKind(input.sourceKind);
  const createdAt = requireTimestamp(input.createdAt, "createdAt");
  const updatedAt = input.updatedAt ? requireTimestamp(input.updatedAt, "updatedAt") : createdAt;
  const fingerprintInputs = normalizeFingerprintInputs(input.fingerprintInputs);
  const staleAfter = optionalTimestamp(input.staleAfter, "staleAfter");
  const fingerprint = buildRoutineTriggerFingerprint({ triggerId, projectId, sourceKind, fingerprintInputs });
  const activationDecisionId = input.activationDecisionId ? requireString(input.activationDecisionId, "activationDecisionId") : undefined;
  const enabled = requireBoolean(input.enabled, "enabled");

  if (enabled && !activationDecisionId) {
    throw new Error("enabled routine trigger requires activationDecisionId");
  }

  return {
    schemaVersion: 1,
    id: input.id ? requireString(input.id, "id") : buildRoutineTriggerRecordId({ triggerId, projectId, createdAt }),
    triggerId,
    sourceKind,
    projectId,
    enabled,
    riskClass: parseGovernanceRiskClass(input.riskClass),
    sourceEvidence: normalizeStringList(input.sourceEvidence, "sourceEvidence"),
    fingerprintInputs,
    fingerprint,
    authority: normalizeAuthority(input.authority),
    createdAt,
    updatedAt,
    staleAfter,
    activationDecisionId,
  };
}

export function parseRoutineTriggerRecord(value: unknown): RoutineTriggerRecord {
  const record = requireRecord(value, "routine trigger");
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported routine trigger schemaVersion: ${describeUnknown(record.schemaVersion)}`);
  }
  const normalized = createRoutineTriggerRecord({
    id: requireString(record.id, "id"),
    triggerId: requireString(record.triggerId, "triggerId"),
    sourceKind: parseSourceKind(record.sourceKind),
    projectId: requireString(record.projectId, "projectId"),
    enabled: requireBoolean(record.enabled, "enabled"),
    riskClass: parseGovernanceRiskClass(record.riskClass),
    sourceEvidence: normalizeStringList(record.sourceEvidence, "sourceEvidence"),
    fingerprintInputs: normalizeFingerprintInputs(record.fingerprintInputs),
    createdAt: requireTimestamp(record.createdAt, "createdAt"),
    updatedAt: requireTimestamp(record.updatedAt, "updatedAt"),
    staleAfter: optionalTimestamp(record.staleAfter, "staleAfter"),
    activationDecisionId: record.activationDecisionId === undefined ? undefined : requireString(record.activationDecisionId, "activationDecisionId"),
    authority: normalizeAuthority(record.authority),
  });
  const fingerprint = requireString(record.fingerprint, "fingerprint");
  if (fingerprint !== normalized.fingerprint) {
    throw new Error(`routine trigger fingerprint mismatch: expected ${normalized.fingerprint}`);
  }
  return normalized;
}

function isActiveRequest(record: OrchestrationRequestRecord): boolean {
  return record.status === "pending_plan";
}

function isActivePlan(record: OrchestratorPlanRecord): boolean {
  return record.status === "planned" || record.status === "questions";
}

function isActiveTask(record: TaskSpec): boolean {
  return record.status === "pending" || record.status === "in_progress";
}

function isActiveAction(record: RemoteActionRecord): boolean {
  return record.status === "pending" || record.status === "waiting" || record.status === "approved" || record.status === "running";
}

function isUnresolvedDecision(record: DecisionItem): boolean {
  return record.status === "pending";
}

function activeRef(input: {
  kind: RoutineActiveWorkKind;
  id: string;
  status: string;
  routineTriggerId?: string;
  routineFingerprint?: string;
}): RoutineActiveWorkRef | undefined {
  if (!input.routineFingerprint) return undefined;
  return {
    kind: input.kind,
    id: input.id,
    status: input.status,
    routineTriggerId: input.routineTriggerId,
    routineFingerprint: input.routineFingerprint,
  };
}

export function findRoutineFingerprintMatches(input: RoutineFingerprintCoalescingInput): RoutineActiveWorkRef[] {
  const fingerprint = requireString(input.fingerprint, "fingerprint");
  const refs = [
    ...(input.requests ?? [])
      .filter(isActiveRequest)
      .map((request) => activeRef({ kind: "request", id: request.id, status: request.status, routineTriggerId: request.routineTriggerId, routineFingerprint: request.routineFingerprint })),
    ...(input.plans ?? [])
      .filter(isActivePlan)
      .map((plan) => activeRef({ kind: "plan", id: plan.id, status: plan.status, routineTriggerId: plan.routineTriggerId, routineFingerprint: plan.routineFingerprint })),
    ...(input.tasks ?? [])
      .filter(isActiveTask)
      .map((task) => activeRef({ kind: "task", id: task.id, status: task.status, routineTriggerId: task.routineTriggerId, routineFingerprint: task.routineFingerprint })),
    ...(input.actions ?? [])
      .filter(isActiveAction)
      .map((action) => activeRef({ kind: "action", id: action.id, status: action.status, routineTriggerId: action.routineTriggerId, routineFingerprint: action.routineFingerprint })),
    ...(input.decisions ?? [])
      .filter(isUnresolvedDecision)
      .map((decision) => activeRef({ kind: "decision", id: decision.id, status: decision.status, routineTriggerId: decision.routineTriggerId, routineFingerprint: decision.routineFingerprint })),
  ].filter((ref): ref is RoutineActiveWorkRef => Boolean(ref));

  return refs
    .filter((ref) => ref.routineFingerprint === fingerprint)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

export function buildRoutineTriggerObservationId(input: {
  triggerId: string;
  observedAt: string;
  fingerprint: string;
}): string {
  return compactEntityId({
    prefix: "routine-observation",
    createdAt: requireTimestamp(input.observedAt, "observedAt"),
    label: input.triggerId,
    source: `${input.triggerId}|${input.fingerprint}|${input.observedAt}`,
  });
}

export function createRoutineTriggerObservation(input: CreateRoutineTriggerObservationInput): RoutineTriggerObservationRecord {
  const trigger = parseRoutineTriggerRecord(input.trigger);
  const observedAt = requireTimestamp(input.observedAt, "observedAt");
  const sourceEvidence = input.sourceEvidence ? normalizeStringList(input.sourceEvidence, "sourceEvidence") : trigger.sourceEvidence;
  const coalescedWith = findRoutineFingerprintMatches({
    fingerprint: trigger.fingerprint,
    requests: input.activeWork?.requests,
    plans: input.activeWork?.plans,
    tasks: input.activeWork?.tasks,
    actions: input.activeWork?.actions,
    decisions: input.activeWork?.decisions,
  });
  const stale = trigger.staleAfter ? new Date(observedAt).getTime() > new Date(trigger.staleAfter).getTime() : false;
  const status: RoutineTriggerObservationStatus = !trigger.enabled
    ? "ignored_disabled"
    : stale
      ? "ignored_stale"
      : coalescedWith.length > 0
        ? "coalesced"
        : "recorded";

  return {
    schemaVersion: 1,
    id: input.id ?? buildRoutineTriggerObservationId({
      triggerId: trigger.triggerId,
      observedAt,
      fingerprint: trigger.fingerprint,
    }),
    triggerId: trigger.triggerId,
    routineId: trigger.id,
    sourceKind: trigger.sourceKind,
    projectId: trigger.projectId,
    observedAt,
    status,
    fingerprint: trigger.fingerprint,
    fingerprintInputs: trigger.fingerprintInputs,
    sourceEvidence,
    coalescedWith: coalescedWith.length ? coalescedWith : undefined,
    admission: input.admission,
  };
}

export function routineObservationToOrchestrationRequest(input: RoutineObservationRequestInput): OrchestrationRequestRecord | undefined {
  const trigger = parseRoutineTriggerRecord(input.trigger);
  const observation = parseRoutineTriggerObservationRecord(input.observation);
  if (observation.routineId !== trigger.id) {
    throw new Error(`routine observation does not belong to trigger: ${observation.routineId} != ${trigger.id}`);
  }
  if (observation.fingerprint !== trigger.fingerprint) {
    throw new Error(`routine observation fingerprint does not match trigger: ${observation.fingerprint} != ${trigger.fingerprint}`);
  }
  if (observation.status !== "recorded") return undefined;
  if (observation.admission && observation.admission.decision !== "accept") return undefined;

  const text = oneLine(input.requestText);
  if (!text) throw new Error("routine request text is required");
  const createdAt = input.createdAt ? requireTimestamp(input.createdAt, "createdAt") : observation.observedAt;
  const requestId = input.requestId ?? buildOrchestrationRequestId(createdAt, `routine-${observation.id}`);
  return {
    schemaVersion: 1,
    id: requestId,
    ancestry: assignedOrchestrationAncestry({
      projectId: trigger.projectId,
      workItemId: requestId,
    }),
    routineTriggerId: trigger.triggerId,
    routineFingerprint: trigger.fingerprint,
    source: input.source ?? "local",
    senderId: input.senderId ? requireString(input.senderId, "senderId") : undefined,
    text,
    status: "pending_plan",
    createdAt,
    admission: observation.admission,
  };
}

export function parseRoutineTriggerObservationRecord(value: unknown): RoutineTriggerObservationRecord {
  const record = requireRecord(value, "routine trigger observation");
  if (record.schemaVersion !== 1) {
    throw new Error(`unsupported routine trigger observation schemaVersion: ${describeUnknown(record.schemaVersion)}`);
  }
  return {
    schemaVersion: 1,
    id: requireString(record.id, "id"),
    triggerId: requireString(record.triggerId, "triggerId"),
    routineId: requireString(record.routineId, "routineId"),
    sourceKind: parseSourceKind(record.sourceKind),
    projectId: requireString(record.projectId, "projectId"),
    observedAt: requireTimestamp(record.observedAt, "observedAt"),
    status: parseObservationStatus(record.status),
    fingerprint: requireString(record.fingerprint, "fingerprint"),
    fingerprintInputs: normalizeFingerprintInputs(record.fingerprintInputs),
    sourceEvidence: normalizeStringList(record.sourceEvidence, "sourceEvidence"),
    coalescedWith: normalizeActiveWorkRefs(record.coalescedWith),
    admission: record.admission as QueueAdmissionRecord | undefined,
  };
}

export function routineActivationPolicy(input: {
  routine: RoutineTriggerRecord;
  approvalEvidence?: RiskApprovalEvidence[];
}): RiskPolicyDecision {
  const routine = parseRoutineTriggerRecord(input.routine);
  return riskPolicyAllowsTransition({
    subjectType: "routine",
    subjectId: routine.id,
    transitionKind: "activate",
    declaredRiskClass: "high",
    approvalEvidence: input.approvalEvidence,
    approvedDecisionKinds: ["routine_change", "risk_acceptance"],
  });
}

export class RoutineTriggerStore {
  constructor(private readonly path: string) {}

  async list(): Promise<RoutineTriggerRecord[]> {
    return (await readJsonLines<unknown>(this.path)).map(parseRoutineTriggerRecord);
  }

  async find(id: string): Promise<RoutineTriggerRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  async append(record: RoutineTriggerRecord): Promise<void> {
    const normalized = parseRoutineTriggerRecord(record);
    const records = await this.list();
    if (records.some((existing) => existing.id === normalized.id)) {
      throw new Error(`routine trigger already exists: ${normalized.id}`);
    }
    if (records.some((existing) => existing.triggerId === normalized.triggerId && existing.projectId === normalized.projectId)) {
      throw new Error(`routine trigger id already exists for project: ${normalized.projectId}/${normalized.triggerId}`);
    }
    await writeJsonLines(this.path, [...records, normalized]);
  }
}

export class RoutineTriggerObservationStore {
  constructor(private readonly path: string) {}

  async list(): Promise<RoutineTriggerObservationRecord[]> {
    return (await readJsonLines<unknown>(this.path)).map(parseRoutineTriggerObservationRecord);
  }

  async append(record: RoutineTriggerObservationRecord): Promise<void> {
    const normalized = parseRoutineTriggerObservationRecord(record);
    const records = await this.list();
    if (records.some((existing) => existing.id === normalized.id)) {
      throw new Error(`routine trigger observation already exists: ${normalized.id}`);
    }
    await writeJsonLines(this.path, [...records, normalized]);
  }

  async observe(input: CreateRoutineTriggerObservationInput): Promise<RoutineTriggerObservationRecord> {
    const observation = createRoutineTriggerObservation(input);
    await this.append(observation);
    return observation;
  }
}
