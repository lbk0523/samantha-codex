import type { WorkItemAncestry } from "./ancestry";
import type { TaskSpec } from "./contracts";
import type { CostBudgetAuditRecord } from "./cost-budget-audit";
import type { DecisionItem } from "./decision-store";
import type { RunSummary } from "./ledger";
import type { OpsSnapshot } from "./ops-diagnostics";
import type { OrchestratorPlanBlocker } from "./orchestrator-blockers";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "./orchestrator-store";
import type {
  QueueAdmissionDecision,
  QueueAdmissionRecord,
  QueueAdmissionSubjectKind,
  QueuePressureClass,
} from "./queue-admission";
import type { RemoteActionRecord } from "./remote-action-store";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { TaskDraftRecord } from "./task-draft-store";

export interface QueuePressureMetrics {
  pendingRequests: number;
  deferredRequests: number;
  pendingBkDecisions: number;
  taskDrafts: number;
  activeTasks: number;
  activeActions: number;
  runningActions: number;
  failedPlans: number;
  recoveryNeeds: number;
  failedRuns: number;
  runLifecycleGaps: number;
  outboxBacklog: number;
  budgetAuditGaps: number;
  unsafeHostIssues: number;
}

export interface QueuePressureSnapshot {
  projectId?: string;
  pressureClass: QueuePressureClass;
  metrics: QueuePressureMetrics;
  reasons: string[];
}

export interface QueuePressureInput {
  requests?: OrchestrationRequestRecord[];
  plans?: OrchestratorPlanRecord[];
  decisions?: DecisionItem[];
  taskDrafts?: TaskDraftRecord[];
  tasks?: TaskSpec[];
  actions?: RemoteActionRecord[];
  runs?: RunSummary[];
  lifecycles?: RunLifecycleRecord[];
  budgetObservations?: CostBudgetAuditRecord[];
  orchestratorPlanBlockers?: OrchestratorPlanBlocker[];
  ops?: OpsSnapshot;
}

export interface QueueAdmissionDecisionResult {
  subjectKind: QueueAdmissionSubjectKind;
  decision: QueueAdmissionDecision;
  pressure: QueuePressureSnapshot;
  reason: string;
}

const pressureOrder: Record<QueuePressureClass, number> = {
  normal: 0,
  watch: 1,
  defer: 2,
  block: 3,
  needs_bk: 4,
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function projectIdFromAncestry(ancestry: WorkItemAncestry | undefined): string | undefined {
  return ancestry?.mode === "assigned" ? ancestry.projectId : undefined;
}

function directProjectId(record: unknown): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;
  if (typeof value.projectId === "string" && value.projectId.trim()) return value.projectId;
  const context = value.context;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    const projectId = (context as Record<string, unknown>).projectId;
    if (typeof projectId === "string" && projectId.trim()) return projectId;
  }
  return undefined;
}

function recordProjectId(record: { ancestry?: WorkItemAncestry } | unknown): string | undefined {
  if (record && typeof record === "object" && !Array.isArray(record)) {
    const ancestry = (record as { ancestry?: WorkItemAncestry }).ancestry;
    return projectIdFromAncestry(ancestry) ?? directProjectId(record);
  }
  return undefined;
}

function filterProject<T>(records: T[] | undefined, projectId: string | undefined): T[] {
  const values = records ?? [];
  if (!projectId) return values;
  return values.filter((record) => recordProjectId(record) === projectId);
}

function activeTask(task: TaskSpec): boolean {
  return task.status === "pending" || task.status === "in_progress";
}

function activeAction(action: RemoteActionRecord): boolean {
  return action.status === "pending" || action.status === "waiting" || action.status === "approved" || action.status === "running";
}

function planNeedsRecovery(plan: OrchestratorPlanRecord): boolean {
  return plan.status === "failed" || Boolean(plan.synthesisFailure) || Boolean(plan.synthesis && plan.synthesis.outcome !== "pass");
}

function requestDeferred(request: OrchestrationRequestRecord): boolean {
  return request.status === "pending_plan" && request.admission !== undefined && request.admission.decision !== "accept";
}

function actionNeedsRecovery(action: RemoteActionRecord): boolean {
  return action.status === "failed" || action.result?.pass === false;
}

function lifecycleOpen(lifecycle: RunLifecycleRecord): boolean {
  return !lifecycle.cleanedAt;
}

function countRunLifecycleGaps(runs: RunSummary[], lifecycles: RunLifecycleRecord[]): number {
  const lifecycleByRunId = new Map(lifecycles.map((lifecycle) => [lifecycle.runId, lifecycle]));
  let gaps = lifecycles.filter(lifecycleOpen).length;
  for (const run of runs) {
    if (!run.pass || !run.commit) continue;
    if (!lifecycleByRunId.has(run.runId)) gaps += 1;
  }
  return gaps;
}

function classFromMetrics(metrics: QueuePressureMetrics): { pressureClass: QueuePressureClass; reasons: string[] } {
  const classes: Array<{ pressureClass: QueuePressureClass; reason: string }> = [];

  if (metrics.unsafeHostIssues > 0) {
    classes.push({ pressureClass: "block", reason: `unsafe host state=${metrics.unsafeHostIssues}` });
  }
  if (metrics.pendingBkDecisions > 0) {
    classes.push({ pressureClass: "needs_bk", reason: `pending BK decisions=${metrics.pendingBkDecisions}` });
  }
  if (metrics.recoveryNeeds > 0) {
    classes.push({ pressureClass: "block", reason: `recovery blockers=${metrics.recoveryNeeds}` });
  }
  if (metrics.activeActions > 0) {
    classes.push({ pressureClass: "defer", reason: `active actions=${metrics.activeActions}` });
  }
  if (metrics.pendingRequests >= 3) {
    classes.push({ pressureClass: "defer", reason: `pending requests=${metrics.pendingRequests}` });
  }
  if (metrics.activeTasks >= 5) {
    classes.push({ pressureClass: "defer", reason: `active tasks=${metrics.activeTasks}` });
  }
  if (metrics.taskDrafts >= 5) {
    classes.push({ pressureClass: "defer", reason: `task drafts=${metrics.taskDrafts}` });
  }
  if (metrics.outboxBacklog >= 5) {
    classes.push({ pressureClass: "defer", reason: `outbox backlog=${metrics.outboxBacklog}` });
  }
  if (metrics.runLifecycleGaps > 0) {
    classes.push({ pressureClass: "watch", reason: `run lifecycle gaps=${metrics.runLifecycleGaps}` });
  }
  if (metrics.budgetAuditGaps > 0) {
    classes.push({ pressureClass: metrics.budgetAuditGaps >= 5 ? "defer" : "watch", reason: `budget audit gaps=${metrics.budgetAuditGaps}` });
  }

  if (classes.length === 0) return { pressureClass: "normal", reasons: [] };
  classes.sort((left, right) => pressureOrder[right.pressureClass] - pressureOrder[left.pressureClass] || left.reason.localeCompare(right.reason));
  return {
    pressureClass: classes[0].pressureClass,
    reasons: classes.map((item) => item.reason),
  };
}

export function buildQueuePressureSnapshot(input: QueuePressureInput = {}, options: { projectId?: string } = {}): QueuePressureSnapshot {
  const requests = filterProject(input.requests, options.projectId);
  const plans = filterProject(input.plans, options.projectId);
  const decisions = filterProject(input.decisions, options.projectId);
  const taskDrafts = filterProject(input.taskDrafts, options.projectId);
  const tasks = filterProject(input.tasks, options.projectId);
  const actions = filterProject(input.actions, options.projectId);
  const runs = filterProject(input.runs, options.projectId);
  const lifecycles = filterProject(input.lifecycles, options.projectId);
  const budgetObservations = filterProject(input.budgetObservations, options.projectId);
  const blockers = input.orchestratorPlanBlockers ?? [];
  const projectPlanIds = new Set(plans.map((plan) => plan.id));
  const projectBlockers = options.projectId ? blockers.filter((blocker) => projectPlanIds.has(blocker.planId)) : blockers;
  const unsafeHostIssues = (input.ops?.issues ?? []).filter((issue) => issue.severity === "unsafe_to_continue").length;
  const failedPlans = plans.filter(planNeedsRecovery).length;
  const failedRuns = runs.filter((run) => !run.pass).length;
  const failedActions = actions.filter(actionNeedsRecovery).length;

  const metrics: QueuePressureMetrics = {
    pendingRequests: requests.filter((request) => request.status === "pending_plan").length,
    deferredRequests: requests.filter(requestDeferred).length,
    pendingBkDecisions: decisions.filter((decision) => decision.status === "pending").length,
    taskDrafts: taskDrafts.filter((draft) => draft.status === "drafted").length,
    activeTasks: tasks.filter(activeTask).length,
    activeActions: actions.filter(activeAction).length,
    runningActions: actions.filter((action) => action.status === "running").length,
    failedPlans,
    recoveryNeeds: failedPlans + failedActions + failedRuns + projectBlockers.length,
    failedRuns,
    runLifecycleGaps: countRunLifecycleGaps(runs, lifecycles),
    outboxBacklog: (input.ops?.queues.unsentRemoteOutboxCount ?? 0) + (input.ops?.queues.pendingInboxCount ?? 0),
    budgetAuditGaps: budgetObservations.filter((observation) => observation.cost.kind === "unknown").length,
    unsafeHostIssues,
  };
  const classification = classFromMetrics(metrics);
  return {
    projectId: options.projectId,
    pressureClass: classification.pressureClass,
    metrics,
    reasons: classification.reasons,
  };
}

export function decideQueueAdmission(input: {
  pressure: QueuePressureSnapshot;
  subjectKind: QueueAdmissionSubjectKind;
}): QueueAdmissionDecisionResult {
  const { pressure, subjectKind } = input;
  const reason = oneLine(pressure.reasons[0] ?? "queue pressure is normal");

  if (pressure.metrics.unsafeHostIssues > 0) {
    return { subjectKind, decision: "block", pressure, reason };
  }
  if (subjectKind === "recovery_request") {
    if (pressure.metrics.pendingBkDecisions > 0) return { subjectKind, decision: "ask_bk", pressure, reason };
    return { subjectKind, decision: "accept", pressure, reason: "recovery intake is allowed to address the current blocker" };
  }
  if (pressure.metrics.pendingBkDecisions > 0) {
    return {
      subjectKind,
      decision: subjectKind === "routine_trigger" || subjectKind === "action" ? "ask_bk" : "defer",
      pressure,
      reason,
    };
  }
  if (pressure.metrics.recoveryNeeds > 0) {
    return { subjectKind, decision: subjectKind === "action" ? "block" : "defer", pressure, reason };
  }
  if (pressure.pressureClass === "normal" || pressure.pressureClass === "watch") {
    return { subjectKind, decision: "accept", pressure, reason };
  }
  if (pressure.pressureClass === "defer") return { subjectKind, decision: "defer", pressure, reason };
  if (pressure.pressureClass === "needs_bk") return { subjectKind, decision: "ask_bk", pressure, reason };
  return { subjectKind, decision: "block", pressure, reason };
}

export function queueAdmissionRecord(input: {
  decidedAt: string;
  result: QueueAdmissionDecisionResult;
}): QueueAdmissionRecord {
  return {
    schemaVersion: 1,
    decidedAt: input.decidedAt,
    subjectKind: input.result.subjectKind,
    decision: input.result.decision,
    pressureClass: input.result.pressure.pressureClass,
    reason: input.result.reason,
  };
}

export function formatQueuePressureSnapshot(pressure: QueuePressureSnapshot): string[] {
  const metrics = pressure.metrics;
  return [
    "Queue pressure:",
    `- class: ${pressure.pressureClass}${pressure.projectId ? ` project=${pressure.projectId}` : ""}`,
    `- intake: pending_requests=${metrics.pendingRequests} deferred_requests=${metrics.deferredRequests} pending_bk=${metrics.pendingBkDecisions} task_drafts=${metrics.taskDrafts}`,
    `- execution: active_tasks=${metrics.activeTasks} active_actions=${metrics.activeActions} running_actions=${metrics.runningActions} recovery_needs=${metrics.recoveryNeeds} failed_runs=${metrics.failedRuns}`,
    `- audit: lifecycle_gaps=${metrics.runLifecycleGaps} outbox_backlog=${metrics.outboxBacklog} budget_audit_gaps=${metrics.budgetAuditGaps} unsafe_host=${metrics.unsafeHostIssues}`,
    `- reasons: ${pressure.reasons.length ? pressure.reasons.join("; ") : "none"}`,
  ];
}

export function formatQueueAdmissionDecision(result: QueueAdmissionDecisionResult): string {
  return [
    "# queue-admission",
    "",
    `Decision: ${result.decision}`,
    `Subject: ${result.subjectKind}`,
    `Pressure: ${result.pressure.pressureClass}`,
    `Reason: ${result.reason}`,
    "",
    "No worker dispatch, merge, push, cleanup, recovery, or approval was performed.",
  ].join("\n");
}
