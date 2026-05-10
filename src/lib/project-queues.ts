import { normalizeRecordAncestry, type WorkItemAncestry } from "./ancestry";
import type { CeoReportRecord } from "./ceo-report-store";
import type { TaskSpec } from "./contracts";
import type { CostBudgetAuditRecord } from "./cost-budget-audit";
import type { DecisionItem } from "./decision-store";
import type { GovernanceEventRecord } from "./governance-event-store";
import type { RunSummary } from "./ledger";
import type { OrchestratorPlanBlocker } from "./orchestrator-blockers";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "./orchestrator-store";
import type { OpsSnapshot } from "./ops-diagnostics";
import { buildQueuePressureSnapshot, formatQueuePressureSnapshot, type QueuePressureSnapshot } from "./queue-pressure";
import type { RemoteActionRecord } from "./remote-action-store";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { TaskDraftRecord } from "./task-draft-store";

export type ProjectQueueRecordKind =
  | "request"
  | "plan"
  | "decision"
  | "task_draft"
  | "task"
  | "action"
  | "run"
  | "lifecycle"
  | "recovery"
  | "report"
  | "governance_event"
  | "budget_observation";

export type ProjectQueueBucketKind = "project" | "unassigned" | "legacy";

export interface ProjectQueueBucket {
  kind: ProjectQueueBucketKind;
  projectId?: string;
  label: string;
}

export interface ProjectQueueCounts {
  total: number;
  active: number;
  blocked: number;
  completed: number;
  pendingBkDecisions: number;
  activeActions: number;
  failedRuns: number;
  recoveryNeeds: number;
  auditGaps: number;
  records: Record<ProjectQueueRecordKind, number>;
}

export interface ProjectQueueSection {
  bucket: ProjectQueueBucket;
  counts: ProjectQueueCounts;
}

export interface ProjectQueueSnapshot {
  filterProjectId?: string;
  totals: ProjectQueueCounts;
  projects: ProjectQueueSection[];
  unassigned: ProjectQueueSection;
  legacy: ProjectQueueSection;
  selectedProject?: ProjectQueueSection;
  globalBlockers: string[];
  pressure: QueuePressureSnapshot;
}

export interface ProjectQueueInput {
  requests?: OrchestrationRequestRecord[];
  plans?: OrchestratorPlanRecord[];
  decisions?: DecisionItem[];
  taskDrafts?: TaskDraftRecord[];
  tasks?: TaskSpec[];
  actions?: RemoteActionRecord[];
  runs?: RunSummary[];
  lifecycles?: RunLifecycleRecord[];
  reports?: CeoReportRecord[];
  governanceEvents?: GovernanceEventRecord[];
  budgetObservations?: CostBudgetAuditRecord[];
  orchestratorPlanBlockers?: OrchestratorPlanBlocker[];
  ops?: OpsSnapshot;
  globalBlockers?: string[];
}

interface QueueRecord {
  kind: ProjectQueueRecordKind;
  id: string;
  bucket: ProjectQueueBucket;
  status?: string;
  active: boolean;
  blocked: boolean;
  completed: boolean;
  pendingBkDecision: boolean;
  activeAction: boolean;
  failedRun: boolean;
  recoveryNeed: boolean;
  auditGap: boolean;
}

const recordKinds: ProjectQueueRecordKind[] = [
  "request",
  "plan",
  "decision",
  "task_draft",
  "task",
  "action",
  "run",
  "lifecycle",
  "recovery",
  "report",
  "governance_event",
  "budget_observation",
];

const activeActionStatuses = new Set(["pending", "waiting", "approved", "running"]);
const activeTaskStatuses = new Set(["pending", "in_progress"]);
const activePlanStatuses = new Set(["planned", "questions", "approved", "materialized"]);

function emptyCounts(): ProjectQueueCounts {
  return {
    total: 0,
    active: 0,
    blocked: 0,
    completed: 0,
    pendingBkDecisions: 0,
    activeActions: 0,
    failedRuns: 0,
    recoveryNeeds: 0,
    auditGaps: 0,
    records: Object.fromEntries(recordKinds.map((kind) => [kind, 0])) as Record<ProjectQueueRecordKind, number>,
  };
}

function addCounts(counts: ProjectQueueCounts, record: QueueRecord): void {
  counts.total += 1;
  counts.records[record.kind] += 1;
  if (record.active) counts.active += 1;
  if (record.blocked) counts.blocked += 1;
  if (record.completed) counts.completed += 1;
  if (record.pendingBkDecision) counts.pendingBkDecisions += 1;
  if (record.activeAction) counts.activeActions += 1;
  if (record.failedRun) counts.failedRuns += 1;
  if (record.recoveryNeed) counts.recoveryNeeds += 1;
  if (record.auditGap) counts.auditGaps += 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function directProjectId(record: unknown): string | undefined {
  if (!isObject(record)) return undefined;
  if (typeof record.projectId === "string" && record.projectId.trim()) return record.projectId;
  if (isObject(record.context) && typeof record.context.projectId === "string" && record.context.projectId.trim()) {
    return record.context.projectId;
  }
  if (isObject(record.subject) && record.subject.type === "project" && typeof record.subject.id === "string" && record.subject.id.trim()) {
    return record.subject.id;
  }
  return undefined;
}

export function projectQueueBucketForRecord(record: { ancestry?: WorkItemAncestry } | unknown): ProjectQueueBucket {
  const ancestry = isObject(record) ? (record.ancestry as WorkItemAncestry | undefined) : undefined;
  if (ancestry) {
    const normalized = normalizeRecordAncestry({ ancestry });
    if (normalized.mode === "assigned") {
      return { kind: "project", projectId: normalized.projectId, label: normalized.projectId };
    }
    if (normalized.mode === "unassigned") return { kind: "unassigned", label: "unassigned" };
    return { kind: "legacy", label: "legacy" };
  }

  const projectId = directProjectId(record);
  if (projectId) return { kind: "project", projectId, label: projectId };
  return { kind: "legacy", label: "legacy" };
}

export function matchesProjectQueueFilter(record: { ancestry?: WorkItemAncestry } | unknown, projectId: string | undefined): boolean {
  if (!projectId) return true;
  const bucket = projectQueueBucketForRecord(record);
  return bucket.kind === "project" && bucket.projectId === projectId;
}

export function filterProjectQueueRecords<T extends { ancestry?: WorkItemAncestry }>(records: T[], projectId: string | undefined): T[] {
  return projectId ? records.filter((record) => matchesProjectQueueFilter(record, projectId)) : records;
}

function baseRecord(input: {
  kind: ProjectQueueRecordKind;
  id: string;
  bucket: ProjectQueueBucket;
  status?: string;
  active?: boolean;
  blocked?: boolean;
  completed?: boolean;
  pendingBkDecision?: boolean;
  activeAction?: boolean;
  failedRun?: boolean;
  recoveryNeed?: boolean;
  auditGap?: boolean;
}): QueueRecord {
  return {
    kind: input.kind,
    id: input.id,
    bucket: input.bucket,
    status: input.status,
    active: input.active ?? false,
    blocked: input.blocked ?? false,
    completed: input.completed ?? false,
    pendingBkDecision: input.pendingBkDecision ?? false,
    activeAction: input.activeAction ?? false,
    failedRun: input.failedRun ?? false,
    recoveryNeed: input.recoveryNeed ?? false,
    auditGap: input.auditGap ?? false,
  };
}

function decisionSubjectKey(decision: DecisionItem): string | undefined {
  return decision.subject ? `${decision.subject.type}:${decision.subject.id}` : undefined;
}

function queueRecords(input: ProjectQueueInput): QueueRecord[] {
  const planById = new Map((input.plans ?? []).map((plan) => [plan.id, plan]));
  const blockedPlanIds = new Set((input.orchestratorPlanBlockers ?? []).map((blocker) => blocker.planId));
  const pendingDecisionSubjectKeys = new Set(
    (input.decisions ?? [])
      .filter((decision) => decision.status === "pending")
      .map((decision) => decisionSubjectKey(decision))
      .filter((value): value is string => Boolean(value)),
  );
  return [
    ...(input.requests ?? []).map((request) =>
      baseRecord({
        kind: request.recoveryOfPlanId ? "recovery" : "request",
        id: request.id,
        bucket: projectQueueBucketForRecord(request),
        status: request.status,
        active: request.status === "pending_plan",
        blocked: Boolean(request.recoveryOfPlanId) && request.status === "pending_plan",
        completed: request.status !== "pending_plan",
        recoveryNeed: Boolean(request.recoveryOfPlanId) && request.status === "pending_plan",
      }),
    ),
    ...(input.plans ?? []).map((plan) =>
      baseRecord({
        kind: "plan",
        id: plan.id,
        bucket: projectQueueBucketForRecord(plan),
        status: plan.status,
        active: activePlanStatuses.has(plan.status) && !blockedPlanIds.has(plan.id),
        blocked: plan.status === "failed" || blockedPlanIds.has(plan.id) || Boolean(plan.synthesisFailure) || Boolean(plan.synthesis && plan.synthesis.outcome !== "pass"),
        completed: ["canceled", "superseded", "materialized"].includes(plan.status) && !blockedPlanIds.has(plan.id),
        pendingBkDecision: (plan.status === "planned" || plan.status === "questions") && !pendingDecisionSubjectKeys.has(`orchestrator_plan:${plan.id}`),
        recoveryNeed: plan.status === "failed" || Boolean(plan.synthesisFailure) || Boolean(plan.synthesis && plan.synthesis.outcome !== "pass"),
      }),
    ),
    ...(input.orchestratorPlanBlockers ?? [])
      .filter((blocker) => !planById.has(blocker.planId))
      .map((blocker) =>
        baseRecord({
          kind: "plan",
          id: blocker.planId,
          bucket: { kind: "legacy", label: "legacy" },
          status: "blocked",
          blocked: true,
          recoveryNeed: true,
        }),
      ),
    ...(input.decisions ?? []).map((decision) =>
      baseRecord({
        kind: "decision",
        id: decision.id,
        bucket: projectQueueBucketForRecord(decision),
        status: decision.status,
        active: decision.status === "pending",
        completed: decision.status !== "pending",
        pendingBkDecision: decision.status === "pending",
      }),
    ),
    ...(input.taskDrafts ?? []).map((draft) =>
      baseRecord({
        kind: "task_draft",
        id: draft.id,
        bucket: projectQueueBucketForRecord(draft),
        status: draft.status,
        active: draft.status === "drafted",
        completed: draft.status !== "drafted",
      }),
    ),
    ...(input.tasks ?? []).map((task) =>
      baseRecord({
        kind: "task",
        id: task.id,
        bucket: projectQueueBucketForRecord(task),
        status: task.status,
        active: activeTaskStatuses.has(task.status),
        blocked: task.status === "blocked" || task.status === "failed",
        completed: task.status === "completed" || task.status === "archived",
        recoveryNeed: task.status === "blocked" || task.status === "failed",
      }),
    ),
    ...(input.actions ?? []).map((action) =>
      baseRecord({
        kind: "action",
        id: action.id,
        bucket: projectQueueBucketForRecord(action),
        status: action.status,
        active: activeActionStatuses.has(action.status),
        blocked: action.status === "failed" || action.result?.pass === false,
        completed: action.status === "completed" && action.result?.pass !== false,
        activeAction: activeActionStatuses.has(action.status),
        recoveryNeed: action.status === "failed" || action.result?.pass === false,
      }),
    ),
    ...(input.runs ?? []).map((run) =>
      baseRecord({
        kind: "run",
        id: run.runId,
        bucket: projectQueueBucketForRecord(run),
        status: run.outcome,
        blocked: !run.pass,
        completed: run.pass,
        failedRun: !run.pass,
        recoveryNeed: !run.pass,
      }),
    ),
    ...(input.lifecycles ?? []).map((lifecycle) =>
      baseRecord({
        kind: "lifecycle",
        id: lifecycle.runId,
        bucket: projectQueueBucketForRecord(lifecycle),
        status: lifecycle.cleanedAt ? "cleaned" : lifecycle.pushedAt ? "pushed" : lifecycle.mergedAt ? "merged" : "open",
        active: !lifecycle.cleanedAt,
        completed: Boolean(lifecycle.cleanedAt),
      }),
    ),
    ...(input.reports ?? []).map((report) =>
      baseRecord({
        kind: "report",
        id: report.id,
        bucket: projectQueueBucketForRecord(report),
        status: report.overall,
        completed: true,
      }),
    ),
    ...(input.governanceEvents ?? []).map((event) =>
      baseRecord({
        kind: "governance_event",
        id: event.id,
        bucket: projectQueueBucketForRecord(event),
        status: event.kind,
        completed: true,
        auditGap: event.kind === "audit_gap_recorded",
      }),
    ),
    ...(input.budgetObservations ?? []).map((observation) =>
      baseRecord({
        kind: "budget_observation",
        id: observation.id,
        bucket: projectQueueBucketForRecord(observation),
        status: observation.cost.kind,
        completed: true,
        auditGap: observation.cost.kind === "unknown",
      }),
    ),
  ];
}

function section(bucket: ProjectQueueBucket): ProjectQueueSection {
  return { bucket, counts: emptyCounts() };
}

function addToSection(sections: Map<string, ProjectQueueSection>, bucket: ProjectQueueBucket, record: QueueRecord): void {
  const key = bucket.kind === "project" ? `project:${bucket.projectId}` : bucket.kind;
  const current = sections.get(key) ?? section(bucket);
  addCounts(current.counts, record);
  sections.set(key, current);
}

export function buildProjectQueueSnapshot(input: ProjectQueueInput, options: { filterProjectId?: string } = {}): ProjectQueueSnapshot {
  const totals = emptyCounts();
  const sections = new Map<string, ProjectQueueSection>();
  const unassigned = section({ kind: "unassigned", label: "unassigned" });
  const legacy = section({ kind: "legacy", label: "legacy" });

  for (const record of queueRecords(input)) {
    addCounts(totals, record);
    if (record.bucket.kind === "project") {
      addToSection(sections, record.bucket, record);
    } else if (record.bucket.kind === "unassigned") {
      addCounts(unassigned.counts, record);
    } else {
      addCounts(legacy.counts, record);
    }
  }

  const projects = [...sections.values()].sort((left, right) => left.bucket.label.localeCompare(right.bucket.label));
  return {
    filterProjectId: options.filterProjectId,
    totals,
    projects,
    unassigned,
    legacy,
    selectedProject: options.filterProjectId
      ? projects.find((item) => item.bucket.projectId === options.filterProjectId) ?? section({ kind: "project", projectId: options.filterProjectId, label: options.filterProjectId })
      : undefined,
    globalBlockers: input.globalBlockers ?? [],
    pressure: buildQueuePressureSnapshot({
      requests: input.requests,
      plans: input.plans,
      decisions: input.decisions,
      taskDrafts: input.taskDrafts,
      tasks: input.tasks,
      actions: input.actions,
      runs: input.runs,
      lifecycles: input.lifecycles,
      budgetObservations: input.budgetObservations,
      orchestratorPlanBlockers: input.orchestratorPlanBlockers,
      ops: input.ops,
    }, { projectId: options.filterProjectId }),
  };
}

function countSummary(counts: ProjectQueueCounts): string {
  return [
    `records=${counts.total}`,
    `active=${counts.active}`,
    `blocked=${counts.blocked}`,
    `completed=${counts.completed}`,
    `pending_bk=${counts.pendingBkDecisions}`,
    `active_actions=${counts.activeActions}`,
    `failed_runs=${counts.failedRuns}`,
    `recovery_needs=${counts.recoveryNeeds}`,
    `audit_gaps=${counts.auditGaps}`,
  ].join(" ");
}

export function formatProjectQueueSection(section: ProjectQueueSection): string {
  return `${section.bucket.label}: ${countSummary(section.counts)}`;
}

export function formatProjectQueueSnapshot(snapshot: ProjectQueueSnapshot): string[] {
  const projectLines = snapshot.projects.length
    ? snapshot.projects.map((item) => `- project ${formatProjectQueueSection(item)}`)
    : ["- project none: records=0 active=0 blocked=0 completed=0 pending_bk=0 active_actions=0 failed_runs=0 recovery_needs=0 audit_gaps=0"];
  return [
    "Project queues:",
    `- filter: ${snapshot.filterProjectId ? `project=${snapshot.filterProjectId}` : "all projects"}; global blockers preserved`,
    `- cross-project total: ${countSummary(snapshot.totals)}`,
    ...(snapshot.selectedProject ? [`- selected ${formatProjectQueueSection(snapshot.selectedProject)}`] : []),
    ...projectLines,
    `- unassigned ${formatProjectQueueSection(snapshot.unassigned)}`,
    `- legacy ${formatProjectQueueSection(snapshot.legacy)}`,
    `- global blockers: ${snapshot.globalBlockers.length}`,
    ...formatQueuePressureSnapshot(snapshot.pressure),
  ];
}
