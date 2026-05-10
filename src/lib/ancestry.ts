export type GoalStatus = "active" | "blocked" | "completed" | "canceled" | "archived";
export type GoalPriority = "low" | "normal" | "high" | "urgent";

export interface GoalParentContext {
  projectId?: string;
  goalId?: string;
  workItemId?: string;
  note?: string;
}

export interface GoalRecord {
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  status: GoalStatus;
  createdAt: string;
  priority?: GoalPriority;
  parent?: GoalParentContext;
}

export interface AssignedWorkItemAncestry {
  mode: "assigned";
  projectId: string;
  goalId: string;
  workItemId: string;
}

export interface UnassignedWorkItemAncestry {
  mode: "unassigned";
  workItemId?: string;
  reason?: string;
}

export interface LegacyWorkItemAncestry {
  mode: "legacy";
  workItemId?: string;
  reason: "missing_ancestry" | "pre_m3_record" | "unknown_source";
}

export type WorkItemAncestry = AssignedWorkItemAncestry | UnassignedWorkItemAncestry | LegacyWorkItemAncestry;

export type AncestryRecordKind =
  | "request"
  | "plan"
  | "decision"
  | "task"
  | "action"
  | "run"
  | "lifecycle"
  | "recovery"
  | "report"
  | "governance_event"
  | "budget_observation";

export interface AncestryValidationRecord {
  kind: AncestryRecordKind;
  id: string;
  ancestry?: WorkItemAncestry;
}

export interface MaterializedExecutionAncestryInput {
  plan: AncestryValidationRecord;
  records: AncestryValidationRecord[];
}

export const ANCESTRY_FIELD_CONTRACTS: Record<AncestryRecordKind, { field: "ancestry"; missingRecordMode: "legacy" }> = {
  request: { field: "ancestry", missingRecordMode: "legacy" },
  plan: { field: "ancestry", missingRecordMode: "legacy" },
  decision: { field: "ancestry", missingRecordMode: "legacy" },
  task: { field: "ancestry", missingRecordMode: "legacy" },
  action: { field: "ancestry", missingRecordMode: "legacy" },
  run: { field: "ancestry", missingRecordMode: "legacy" },
  lifecycle: { field: "ancestry", missingRecordMode: "legacy" },
  recovery: { field: "ancestry", missingRecordMode: "legacy" },
  report: { field: "ancestry", missingRecordMode: "legacy" },
  governance_event: { field: "ancestry", missingRecordMode: "legacy" },
  budget_observation: { field: "ancestry", missingRecordMode: "legacy" },
};

const goalStatuses: readonly GoalStatus[] = ["active", "blocked", "completed", "canceled", "archived"];
const goalPriorities: readonly GoalPriority[] = ["low", "normal", "high", "urgent"];
const ancestryRecordKinds = new Set(Object.keys(ANCESTRY_FIELD_CONTRACTS));

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

function optionalStableIdViolations(value: unknown, label: string): string[] {
  return value === undefined ? [] : stableIdViolations(value, label);
}

function timestampViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (Number.isNaN(new Date(normalized).getTime())) return [`${label} must be a valid date: ${normalized}`];
  return [];
}

function stringFieldViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  if (!oneLine(value)) return [`${label} is required`];
  return [];
}

export function legacyAncestry(reason: LegacyWorkItemAncestry["reason"] = "missing_ancestry"): LegacyWorkItemAncestry {
  return { mode: "legacy", reason };
}

export function normalizeRecordAncestry(record: { ancestry?: WorkItemAncestry }): WorkItemAncestry {
  return record.ancestry ?? legacyAncestry("missing_ancestry");
}

export function parseWorkItemAncestry(value: unknown, label = "ancestry"): WorkItemAncestry {
  const ancestry = value as WorkItemAncestry;
  const violations = validateWorkItemAncestry(ancestry, { label });
  if (violations.length > 0) throw new Error(violations[0]);
  return ancestry;
}

export function parseOptionalWorkItemAncestry(value: unknown, label = "ancestry"): WorkItemAncestry | undefined {
  return value === undefined ? undefined : parseWorkItemAncestry(value, label);
}

export function validateGoalRecord(goal: GoalRecord): string[] {
  const violations: string[] = [];
  if (!isObject(goal)) return ["goal must be an object"];
  if (goal.schemaVersion !== 1) violations.push(`goal schemaVersion must be 1`);
  violations.push(...stableIdViolations(goal.id, "goal.id"));
  violations.push(...stableIdViolations(goal.projectId, "goal.projectId"));
  violations.push(...stringFieldViolations(goal.title, "goal.title"));
  if (!goalStatuses.includes(goal.status)) violations.push(`goal.status is invalid: ${String(goal.status)}`);
  violations.push(...timestampViolations(goal.createdAt, "goal.createdAt"));
  if (goal.priority !== undefined && !goalPriorities.includes(goal.priority)) {
    violations.push(`goal.priority is invalid: ${String(goal.priority)}`);
  }
  if (goal.parent !== undefined) {
    if (!isObject(goal.parent)) {
      violations.push("goal.parent must be an object");
    } else {
      violations.push(...optionalStableIdViolations(goal.parent.projectId, "goal.parent.projectId"));
      violations.push(...optionalStableIdViolations(goal.parent.goalId, "goal.parent.goalId"));
      violations.push(...optionalStableIdViolations(goal.parent.workItemId, "goal.parent.workItemId"));
      if (goal.parent.projectId && goal.parent.projectId !== goal.projectId) {
        violations.push(`goal.parent.projectId must match goal.projectId: ${goal.parent.projectId} != ${goal.projectId}`);
      }
      if (goal.parent.note !== undefined) violations.push(...stringFieldViolations(goal.parent.note, "goal.parent.note"));
    }
  }
  return violations;
}

export function validateWorkItemAncestry(ancestry: WorkItemAncestry, input: { goals?: GoalRecord[]; label?: string } = {}): string[] {
  const label = input.label ?? "ancestry";
  const violations: string[] = [];
  if (!isObject(ancestry)) return [`${label} must be an object`];

  if (ancestry.mode === "assigned") {
    violations.push(...stableIdViolations(ancestry.projectId, `${label}.projectId`));
    violations.push(...stableIdViolations(ancestry.goalId, `${label}.goalId`));
    violations.push(...stableIdViolations(ancestry.workItemId, `${label}.workItemId`));
    const goal = input.goals?.find((item) => item.id === ancestry.goalId);
    if (input.goals && !goal) violations.push(`${label}.goalId is unknown: ${ancestry.goalId}`);
    if (goal && goal.projectId !== ancestry.projectId) {
      violations.push(`${label}.projectId must match goal projectId: ${ancestry.projectId} != ${goal.projectId}`);
    }
    return violations;
  }

  if (ancestry.mode === "unassigned") {
    violations.push(...optionalStableIdViolations(ancestry.workItemId, `${label}.workItemId`));
    if (ancestry.reason !== undefined) violations.push(...stringFieldViolations(ancestry.reason, `${label}.reason`));
    return violations;
  }

  if (ancestry.mode === "legacy") {
    violations.push(...optionalStableIdViolations(ancestry.workItemId, `${label}.workItemId`));
    if (!["missing_ancestry", "pre_m3_record", "unknown_source"].includes(ancestry.reason)) {
      violations.push(`${label}.reason is invalid: ${String(ancestry.reason)}`);
    }
    return violations;
  }

  return [`${label}.mode is invalid: ${String((ancestry as { mode?: unknown }).mode)}`];
}

export function validateAncestryRecords(input: { goals?: GoalRecord[]; records: AncestryValidationRecord[] }): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  const goals = input.goals ?? [];

  for (const goal of goals) {
    violations.push(...validateGoalRecord(goal));
  }

  for (const record of input.records) {
    const recordLabel = `${record.kind} ${record.id}`;
    if (!ancestryRecordKinds.has(record.kind)) violations.push(`record kind is invalid: ${String(record.kind)}`);
    violations.push(...stableIdViolations(record.id, `${record.kind}.id`));
    const key = `${record.kind}:${record.id}`;
    if (seen.has(key)) violations.push(`duplicate ancestry record: ${key}`);
    seen.add(key);
    violations.push(...validateWorkItemAncestry(normalizeRecordAncestry(record), { goals, label: `${recordLabel}.ancestry` }));
  }

  return violations;
}

export function validateSameProjectMaterializedExecutionPlan(input: MaterializedExecutionAncestryInput): string[] {
  const violations: string[] = [];
  const planAncestry = normalizeRecordAncestry(input.plan);
  violations.push(...validateWorkItemAncestry(planAncestry, { label: `plan ${input.plan.id}.ancestry` }));

  if (planAncestry.mode !== "assigned") {
    violations.push(`materialized plan ${input.plan.id} must have assigned ancestry`);
    return violations;
  }

  for (const record of input.records) {
    const ancestry = normalizeRecordAncestry(record);
    violations.push(...validateWorkItemAncestry(ancestry, { label: `${record.kind} ${record.id}.ancestry` }));
    if (ancestry.mode !== "assigned") {
      violations.push(`${record.kind} ${record.id} must have assigned ancestry for materialized plan ${input.plan.id}`);
      continue;
    }
    if (ancestry.projectId !== planAncestry.projectId) {
      violations.push(`${record.kind} ${record.id} projectId must match materialized plan projectId: ${ancestry.projectId} != ${planAncestry.projectId}`);
    }
    if (ancestry.goalId !== planAncestry.goalId) {
      violations.push(`${record.kind} ${record.id} goalId must match materialized plan goalId: ${ancestry.goalId} != ${planAncestry.goalId}`);
    }
    if (ancestry.workItemId !== planAncestry.workItemId) {
      violations.push(`${record.kind} ${record.id} workItemId must match materialized plan workItemId: ${ancestry.workItemId} != ${planAncestry.workItemId}`);
    }
  }

  return violations;
}
