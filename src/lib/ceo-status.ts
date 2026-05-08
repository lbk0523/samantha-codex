import type { TaskSpec } from "./contracts";
import {
  decisionAllowsOrchestratorMaterialization,
  decisionHasCurrentPlanSubject,
  decisionLifecycleStatus,
  type DecisionItem,
} from "./decision-store";
import type { RunSummary } from "./ledger";
import type { OpsSnapshot } from "./ops-diagnostics";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "./orchestrator-store";
import type { RemoteActionRecord } from "./remote-action-store";
import { recoveryResolvedPlanIds } from "./recovery-continuity";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import { buildOperatingSurfaceView } from "./operating-surface";

export type CeoOverall = "idle" | "active" | "needs_decision" | "blocked" | "failed" | "needs_recovery";

export type CeoStatusItemKind =
  | "action"
  | "task"
  | "run"
  | "orchestration_request"
  | "orchestrator_plan"
  | "diagnostic";

export interface CeoStatusItem {
  kind: CeoStatusItemKind;
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  detail?: string;
}

export interface CeoDecisionSummary {
  kind: "decision" | "orchestrator_plan";
  id: string;
  title: string;
  status: string;
  reason: string;
  updatedAt?: string;
  subject?: string;
  options?: string[];
}

export type CeoNextActionKind =
  | "none"
  | "plan"
  | "review_plan"
  | "answer_questions"
  | "resolve_decision"
  | "approve_action"
  | "watch_action"
  | "dispatch_task"
  | "merge_check"
  | "push"
  | "cleanup"
  | "recover"
  | "diagnose";

export interface CeoNextAction {
  kind: CeoNextActionKind;
  label: string;
  command?: string;
  targetId?: string;
  reason: string;
}

export interface CeoStatusSnapshot {
  generatedAt: string;
  overall: CeoOverall;
  completed: CeoStatusItem[];
  active: CeoStatusItem[];
  blocked: CeoStatusItem[];
  historicalFailures: CeoStatusItem[];
  needsDecision: CeoDecisionSummary[];
  risks: string[];
  nextAction: CeoNextAction;
}

export interface BuildCeoStatusSnapshotInput {
  generatedAt?: string;
  runs?: RunSummary[];
  tasks?: TaskSpec[];
  decisions?: DecisionItem[];
  actions?: RemoteActionRecord[];
  orchestrationRequests?: OrchestrationRequestRecord[];
  orchestratorPlans?: OrchestratorPlanRecord[];
  lifecycles?: RunLifecycleRecord[];
  ops?: OpsSnapshot;
}

export interface FormatCeoStatusReportOptions {
  completedLimit?: number;
}

const activeActionStatuses = new Set(["running", "approved", "waiting", "pending"]);
const activeTaskStatuses = new Set(["in_progress", "pending"]);

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function itemTimestamp(item: { updatedAt?: string }): number {
  return timestamp(item.updatedAt);
}

function sortRecent<T extends { updatedAt?: string; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => itemTimestamp(b) - itemTimestamp(a) || a.id.localeCompare(b.id));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(oneLine).filter(Boolean))];
}

function latestRunNeedingIntegration(
  runs: RunSummary[],
  lifecycles: RunLifecycleRecord[],
): { run: RunSummary; lifecycle?: RunLifecycleRecord; nextKind: "merge_check" | "push" | "cleanup" } | undefined {
  const lifecyclesByRunId = new Map(lifecycles.map((record) => [record.runId, record]));
  const latestLifecycleUpdate = Math.max(0, ...lifecycles.map((record) => timestamp(record.updatedAt)));

  for (const run of runs.slice().reverse()) {
    if (!run.pass || !run.commit) continue;
    const lifecycle = lifecyclesByRunId.get(run.runId);
    if (lifecycle?.mergedAt && lifecycle.pushedAt && lifecycle.cleanedAt) continue;
    if (!lifecycle && latestLifecycleUpdate !== 0 && timestamp(run.finishedAt) <= latestLifecycleUpdate) continue;

    if (!lifecycle?.mergedAt) return { run, lifecycle, nextKind: "merge_check" };
    if (!lifecycle.pushedAt) return { run, lifecycle, nextKind: "push" };
    return { run, lifecycle, nextKind: "cleanup" };
  }

  return undefined;
}

function actionUpdatedAt(action: RemoteActionRecord): string {
  return action.completedAt ?? action.startedAt ?? action.approvedAt ?? action.createdAt;
}

function actionNeedsRecovery(action: RemoteActionRecord): boolean {
  return action.status === "failed" || action.result?.pass === false;
}

function planUpdatedAt(plan: OrchestratorPlanRecord): string {
  return (
    plan.synthesisAt ??
    plan.resultReportedAt ??
    plan.materializedAt ??
    plan.approvedAt ??
    plan.completedAt ??
    plan.createdAt
  );
}

function planNeedsRecovery(plan: OrchestratorPlanRecord): boolean {
  return plan.status === "failed" || Boolean(plan.synthesisFailure) || Boolean(plan.synthesis && plan.synthesis.outcome !== "pass");
}

function decisionUpdatedAt(decision: DecisionItem): string {
  return decision.resolvedAt ?? decision.archivedAt ?? decision.updatedAt ?? decision.createdAt;
}

function decisionSubjectText(decision: DecisionItem): string | undefined {
  return decision.subject ? `${decision.subject.type}:${decision.subject.id}` : undefined;
}

function decisionSubjectKey(decision: DecisionItem): string | undefined {
  return decisionSubjectText(decision);
}

function latestDecisionBySubject(decisions: DecisionItem[]): Map<string, DecisionItem> {
  const bySubject = new Map<string, DecisionItem>();
  for (const decision of decisions) {
    const subject = decisionSubjectKey(decision);
    if (!subject || decision.status === "archived") continue;
    bySubject.set(subject, decision);
  }
  return bySubject;
}

function taskItem(task: TaskSpec): CeoStatusItem {
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    status: task.status,
    detail: `agent=${task.targetAgent}`,
  };
}

function runItem(run: RunSummary): CeoStatusItem {
  return {
    kind: "run",
    id: run.runId,
    title: run.taskTitle,
    status: run.outcome,
    updatedAt: run.finishedAt,
    detail: run.failureReason ? oneLine(run.failureReason) : run.commit ? `commit=${run.commit.slice(0, 12)}` : undefined,
  };
}

function blockedPlanDetail(plan: OrchestratorPlanRecord): string {
  if (plan.synthesisFailure) return oneLine(plan.synthesisFailure);
  if (plan.synthesis && plan.synthesis.outcome !== "pass") return `synthesis=${plan.synthesis.outcome}`;
  return oneLine(plan.failure ?? "plan generation failed");
}

function nextActionForIntegration(input: {
  run: RunSummary;
  nextKind: "merge_check" | "push" | "cleanup";
}): CeoNextAction {
  if (input.nextKind === "merge_check") {
    return {
      kind: "merge_check",
      label: "Check merge gate for latest passed worker run",
      command: `bun run samantha merge:check --run-log=${input.run.logPath} --repo-root=${input.run.repoRoot}`,
      targetId: input.run.runId,
      reason: "Passed run has a commit that is not fully integrated.",
    };
  }
  if (input.nextKind === "push") {
    return {
      kind: "push",
      label: "Push integrated worker commit",
      command: `bun run samantha merge:push --run-log=${input.run.logPath} --repo-root=${input.run.repoRoot}`,
      targetId: input.run.runId,
      reason: "Run lifecycle is merged but not pushed.",
    };
  }
  return {
    kind: "cleanup",
    label: "Clean up completed worker worktree",
    command: `bun run samantha worktree:cleanup --run-log=${input.run.logPath} --repo-root=${input.run.repoRoot}`,
    targetId: input.run.runId,
    reason: "Run lifecycle is merged and pushed but not cleaned.",
  };
}

function chooseNextAction(input: {
  active: CeoStatusItem[];
  blocked: CeoStatusItem[];
  historicalFailures: CeoStatusItem[];
  needsDecision: CeoDecisionSummary[];
  approvedPlans: CeoStatusItem[];
  actions: RemoteActionRecord[];
  tasks: TaskSpec[];
  orchestrationRequests: OrchestrationRequestRecord[];
  integration?: { run: RunSummary; lifecycle?: RunLifecycleRecord; nextKind: "merge_check" | "push" | "cleanup" };
  ops?: OpsSnapshot;
}): CeoNextAction {
  const latestDecision = input.needsDecision[0];
  if (latestDecision?.kind === "decision") {
    const command = latestDecision.options?.includes("approve")
      ? "bun run samantha decisions:approve-latest"
      : "bun run samantha decisions:list --pending";
    return {
      kind: "resolve_decision",
      label: "Resolve the latest pending BK decision",
      command,
      targetId: latestDecision.id,
      reason: latestDecision.reason,
    };
  }
  if (latestDecision?.status === "questions") {
    return {
      kind: "answer_questions",
      label: "Answer or revise the current orchestrator plan",
      command: "/revise <answer>",
      targetId: latestDecision.id,
      reason: latestDecision.reason,
    };
  }
  if (latestDecision) {
    return {
      kind: "review_plan",
      label: "Review the current orchestrator plan",
      command: "/go or /revise <feedback>",
      targetId: latestDecision.id,
      reason: latestDecision.reason,
    };
  }

  const approvedPlan = input.approvedPlans[0];
  if (approvedPlan) {
    return {
      kind: "review_plan",
      label: "Materialize the approved orchestrator plan",
      command: "/go",
      targetId: approvedPlan.id,
      reason: "BK approved the plan decision; Samantha can now create gated worker actions.",
    };
  }

  const pendingRequest = input.orchestrationRequests
    .slice()
    .reverse()
    .find((request) => request.status === "pending_plan");
  if (pendingRequest) {
    return {
      kind: "plan",
      label: "Create a plan for the pending work request",
      command: "/plan",
      targetId: pendingRequest.id,
      reason: "Pending orchestration request has not been planned.",
    };
  }

  const latestPendingAction = input.actions.slice().reverse().find((action) => action.status === "pending");
  if (latestPendingAction) {
    return {
      kind: "approve_action",
      label: "Approve or reject the pending worker action",
      command: "/go",
      targetId: latestPendingAction.id,
      reason: "A worker action is waiting for BK approval.",
    };
  }

  const liveAction = input.actions
    .slice()
    .reverse()
    .find((action) => action.status === "running" || action.status === "approved" || action.status === "waiting");
  if (liveAction) {
    return {
      kind: "watch_action",
      label: "Watch the active worker action",
      command: "/now",
      targetId: liveAction.id,
      reason: `Action is ${liveAction.status}.`,
    };
  }

  if (input.integration) return nextActionForIntegration(input.integration);

  if (input.blocked.length > 0) {
    return {
      kind: "recover",
      label: "Inspect blocked work before dispatching more work",
      command: "/problems",
      targetId: input.blocked[0]?.id,
      reason: input.blocked[0]?.detail ?? "Blocked work exists.",
    };
  }

  if (input.ops?.failures.length) {
    return {
      kind: "diagnose",
      label: "Inspect operational diagnostics",
      command: "bun run samantha doctor",
      reason: input.ops.failures[0] ?? "Operational diagnostics failed.",
    };
  }

  const pendingTask = input.tasks.find((task) => task.status === "pending");
  if (pendingTask) {
    return {
      kind: "dispatch_task",
      label: "Dispatch the pending task",
      command: `bun run samantha tasks:dispatch ${pendingTask.id} --repo-root=<repo>`,
      targetId: pendingTask.id,
      reason: "A task is ready but no dispatch action exists.",
    };
  }

  if (input.historicalFailures.length > 0) {
    return {
      kind: "recover",
      label: "Review unresolved historical failure",
      command: "/problems",
      targetId: input.historicalFailures[0]?.id,
      reason: input.historicalFailures[0]?.detail ?? "Historical failed work remains unresolved.",
    };
  }

  return {
    kind: "none",
    label: "No safe action required",
    reason: "No active work, blockers, decisions, or pending integration were found.",
  };
}

function chooseOverall(input: {
  active: CeoStatusItem[];
  blocked: CeoStatusItem[];
  historicalFailures: CeoStatusItem[];
  needsDecision: CeoDecisionSummary[];
  currentNeedsRecovery: boolean;
  ops?: OpsSnapshot;
}): CeoOverall {
  if (input.currentNeedsRecovery) return "needs_recovery";
  if (input.needsDecision.length > 0) return "needs_decision";
  if (input.ops?.failures.length) return "failed";
  if (input.blocked.length > 0) return "blocked";
  if (input.active.length > 0) return "active";
  if (input.historicalFailures.length > 0) return "needs_recovery";
  return "idle";
}

export function buildCeoStatusSnapshot(input: BuildCeoStatusSnapshotInput = {}): CeoStatusSnapshot {
  const runs = input.runs ?? [];
  const tasks = input.tasks ?? [];
  const decisions = input.decisions ?? [];
  const actions = input.actions ?? [];
  const orchestrationRequests = input.orchestrationRequests ?? [];
  const orchestratorPlans = input.orchestratorPlans ?? [];
  const lifecycles = input.lifecycles ?? [];
  const resolvedPlanIds = recoveryResolvedPlanIds({
    requests: orchestrationRequests,
    plans: orchestratorPlans,
    actions,
  });
  const resolvedActionIds = new Set(
    orchestratorPlans
      .filter((plan) => resolvedPlanIds.has(plan.id))
      .flatMap((plan) => plan.actionIds ?? []),
  );
  const resolvedTaskIds = new Set(
    orchestratorPlans
      .filter((plan) => resolvedPlanIds.has(plan.id))
      .flatMap((plan) => plan.taskIds ?? []),
  );
  const actionTaskIds = new Set(actions.map((action) => action.taskId));
  const decisionsBySubject = latestDecisionBySubject(decisions);
  const activePendingDecisions = decisions.filter(
    (decision) => decision.status === "pending" && decisionHasCurrentPlanSubject(decision, orchestratorPlans),
  );
  const decisionSubjectKeys = new Set(decisionsBySubject.keys());

  const approvedPlans = sortRecent(
    orchestratorPlans
      .filter((plan) => plan.status === "planned")
      .filter((plan) => decisionAllowsOrchestratorMaterialization(decisionsBySubject.get(`orchestrator_plan:${plan.id}`)))
      .map((plan) => ({
        kind: "orchestrator_plan" as const,
        id: plan.id,
        title: oneLine(plan.payload?.summary ?? plan.requestId),
        status: plan.status,
        updatedAt: planUpdatedAt(plan),
        detail: "approved; waiting for materialization",
      })),
  );

  const active: CeoStatusItem[] = [
    ...actions
      .filter((action) => activeActionStatuses.has(action.status))
      .map((action) => ({
        kind: "action" as const,
        id: action.id,
        title: action.taskTitle,
        status: action.status,
        updatedAt: actionUpdatedAt(action),
        detail: `task=${action.taskId}`,
      })),
    ...tasks
      .filter((task) => activeTaskStatuses.has(task.status) && !actionTaskIds.has(task.id))
      .map(taskItem),
    ...orchestrationRequests
      .filter((request) => request.status === "pending_plan")
      .map((request) => ({
        kind: "orchestration_request" as const,
        id: request.id,
        title: oneLine(request.text),
        status: request.status,
        updatedAt: request.createdAt,
        detail: "waiting for plan",
      })),
    ...approvedPlans,
  ];

  const pendingDecisionSubjectKeys = new Set(
    activePendingDecisions
      .map((decision) => decisionSubjectText(decision))
      .filter((value): value is string => Boolean(value)),
  );

  const needsDecision: CeoDecisionSummary[] = sortRecent([
    ...activePendingDecisions
      .map((decision) => ({
        kind: "decision" as const,
        id: decision.id,
        title: decision.title,
        status: decisionLifecycleStatus(decision),
        reason: decision.prompt,
        updatedAt: decisionUpdatedAt(decision),
        subject: decisionSubjectText(decision),
        options: decision.options,
      })),
    ...orchestratorPlans
      .filter((plan) => plan.status === "planned" || plan.status === "questions")
      .filter((plan) => !pendingDecisionSubjectKeys.has(`orchestrator_plan:${plan.id}`))
      .filter((plan) => !decisionSubjectKeys.has(`orchestrator_plan:${plan.id}`))
      .map((plan) => ({
        kind: "orchestrator_plan" as const,
        id: plan.id,
        title: oneLine(plan.payload?.summary ?? plan.requestId),
        status: plan.status as "planned" | "questions",
        reason:
          plan.status === "questions"
            ? `${plan.payload?.questions.length ?? 0} question(s) need BK input.`
            : "Plan needs BK approval, revision, or cancellation.",
        updatedAt: planUpdatedAt(plan),
      })),
  ]);

  const failedActions = actions.filter((action) => actionNeedsRecovery(action) && !resolvedActionIds.has(action.id));
  const archivedTaskIds = new Set(tasks.filter((task) => task.status === "archived").map((task) => task.id));
  const failedRuns = runs.filter(
    (run) => !run.pass && !resolvedTaskIds.has(run.taskId) && !archivedTaskIds.has(run.taskId),
  );
  const failedPlans = orchestratorPlans.filter((plan) => planNeedsRecovery(plan) && !resolvedPlanIds.has(plan.id));
  const blockedTasks = tasks.filter((task) => task.status === "blocked" || task.status === "failed");

  const blocked: CeoStatusItem[] = [
    ...failedActions.map((action) => ({
      kind: "action" as const,
      id: action.id,
      title: action.taskTitle,
      status: action.status,
      updatedAt: actionUpdatedAt(action),
      detail: oneLine(action.result?.failure ?? action.result?.outcome ?? "action failed or reported non-passing result"),
    })),
    ...failedPlans.map((plan) => ({
      kind: "orchestrator_plan" as const,
      id: plan.id,
      title: oneLine(plan.payload?.summary ?? plan.requestId),
      status: plan.status,
      updatedAt: planUpdatedAt(plan),
      detail: blockedPlanDetail(plan),
    })),
    ...blockedTasks.map(taskItem),
  ];

  const historicalFailures = failedRuns.map(runItem);

  const completed = sortRecent([
    ...actions
      .filter((action) => action.status === "completed" && action.result?.pass !== false)
      .map((action) => ({
        kind: "action" as const,
        id: action.id,
        title: action.taskTitle,
        status: action.status,
        updatedAt: action.completedAt ?? action.createdAt,
        detail: action.result?.runId ? `run=${action.result.runId}` : undefined,
      })),
    ...runs.filter((run) => run.pass).map(runItem),
    ...tasks.filter((task) => task.status === "completed").map(taskItem),
  ]);

  const integration = latestRunNeedingIntegration(runs, lifecycles);
  const risks = unique([
    ...failedActions.map((action) => `Failed action ${action.id}: ${action.result?.failure ?? action.result?.outcome ?? action.status}`),
    ...failedPlans.map((plan) => `Plan needs recovery ${plan.id}: ${blockedPlanDetail(plan)}`),
    ...orchestratorPlans
      .filter((plan) => plan.status === "planned" || plan.status === "questions")
      .flatMap((plan) => plan.payload?.risks ?? []),
    ...decisions.filter((decision) => decision.status === "pending").map((decision) => decision.risk ?? ""),
    ...(input.ops?.failures ?? []),
    ...(input.ops?.warnings ?? []),
    ...failedRuns.map((run) => `Historical failed run ${run.runId}: ${run.failureReason ?? run.outcome}`),
  ]);

  const sortedActive = sortRecent(active);
  const sortedBlocked = sortRecent(blocked);
  const sortedHistoricalFailures = sortRecent(historicalFailures);
  const nextAction = chooseNextAction({
    active: sortedActive,
    blocked: sortedBlocked,
    historicalFailures: sortedHistoricalFailures,
    needsDecision,
    approvedPlans,
    actions,
    tasks,
    orchestrationRequests,
    integration,
    ops: input.ops,
  });

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    overall: chooseOverall({
      active: sortedActive,
      blocked: sortedBlocked,
      historicalFailures: sortedHistoricalFailures,
      needsDecision,
      currentNeedsRecovery: failedActions.length > 0 || failedPlans.length > 0,
      ops: input.ops,
    }),
    completed,
    active: sortedActive,
    blocked: sortedBlocked,
    historicalFailures: sortedHistoricalFailures,
    needsDecision,
    risks,
    nextAction,
  };
}

function formatItem(item: CeoStatusItem): string {
  const detail = item.detail ? ` - ${item.detail}` : "";
  return `- ${item.title} (${item.kind}:${item.id}, ${item.status})${detail}`;
}

function formatDecision(item: CeoDecisionSummary): string {
  const prefix = item.kind === "decision" ? "Decision" : "Plan";
  const options = item.options?.length ? ` options=${item.options.join("/")}` : "";
  return `- ${prefix}: ${item.title} (${item.status}${options}) - ${item.reason}`;
}

function formatSection<T>(items: T[], render: (item: T) => string, empty: string): string[] {
  return items.length ? items.map(render) : [`- ${empty}`];
}

export function formatCeoStatusReport(
  snapshot: CeoStatusSnapshot,
  options: FormatCeoStatusReportOptions = {},
): string {
  const view = buildOperatingSurfaceView(snapshot);
  const completed = snapshot.completed.slice(0, options.completedLimit ?? snapshot.completed.length);

  return [
    "# ceo:status",
    "",
    `Generated: ${snapshot.generatedAt}`,
    `Overall: ${snapshot.overall}`,
    `Summary: ${view.summary}`,
    `Headline: ${view.headline}`,
    "",
    "Next safe action:",
    `- ${view.primaryAction.label}`,
    view.primaryAction.telegramCommand ? `- Telegram: ${view.primaryAction.telegramCommand}` : "",
    view.primaryAction.localCommand ? `- Local fallback: ${view.primaryAction.localCommand}` : "",
    `- Reason: ${view.primaryAction.reason}`,
    "",
    "Needs BK:",
    ...formatSection(snapshot.needsDecision, formatDecision, "none"),
    "",
    "Active work:",
    ...formatSection(snapshot.active, formatItem, "none"),
    "",
    "Blocked / recovery:",
    ...formatSection(snapshot.blocked, formatItem, "none"),
    "",
    "Historical failures:",
    ...formatSection(snapshot.historicalFailures, formatItem, "none"),
    "",
    "Completed work:",
    ...formatSection(completed, formatItem, "none"),
    "",
    "Risks:",
    ...(snapshot.risks.length ? snapshot.risks.map((risk) => `- ${risk}`) : ["- none"]),
  ].filter((line) => line !== "").join("\n");
}
