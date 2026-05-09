import type { TaskSpec } from "./contracts";
import { decisionLifecycleStatus, type DecisionItem } from "./decision-store";
import type { RunSummary } from "./ledger";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "./orchestrator-store";
import type { RemoteActionRecord } from "./remote-action-store";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { WorkerRunLog } from "./run-log";

export type OperatorReviewSubjectType = "auto" | "request" | "plan" | "decision" | "task" | "action" | "run";

export interface OperatorReviewSubject {
  type: OperatorReviewSubjectType;
  id: string;
}

export interface OperatorReviewReportInput {
  subject: OperatorReviewSubject;
  requests: OrchestrationRequestRecord[];
  plans: OrchestratorPlanRecord[];
  decisions: DecisionItem[];
  tasks: TaskSpec[];
  actions: RemoteActionRecord[];
  runs: RunSummary[];
  runLogs?: WorkerRunLog[];
  lifecycles?: RunLifecycleRecord[];
}

interface ReviewContext {
  requestsById: Map<string, OrchestrationRequestRecord>;
  plansById: Map<string, OrchestratorPlanRecord>;
  decisionsById: Map<string, DecisionItem>;
  tasksById: Map<string, TaskSpec>;
  actionsById: Map<string, RemoteActionRecord>;
  runsById: Map<string, RunSummary>;
  runLogsByRunId: Map<string, WorkerRunLog>;
  lifecyclesByRunId: Map<string, RunLifecycleRecord>;
  input: OperatorReviewReportInput;
}

interface ResolvedReviewTarget {
  label: string;
  request?: OrchestrationRequestRecord;
  plans: OrchestratorPlanRecord[];
  decision?: DecisionItem;
  task?: TaskSpec;
  action?: RemoteActionRecord;
  run?: RunSummary;
}

function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function code(value: string | undefined): string {
  return `\`${oneLine(value).replace(/`/g, "'") || "unknown"}\``;
}

function clip(value: string | undefined, maxLength = 700): string {
  const text = oneLine(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function statusText(value: string | undefined): string {
  return value ? code(value) : code("missing");
}

function makeContext(input: OperatorReviewReportInput): ReviewContext {
  return {
    requestsById: new Map(input.requests.map((request) => [request.id, request])),
    plansById: new Map(input.plans.map((plan) => [plan.id, plan])),
    decisionsById: new Map(input.decisions.map((decision) => [decision.id, decision])),
    tasksById: new Map(input.tasks.map((task) => [task.id, task])),
    actionsById: new Map(input.actions.map((action) => [action.id, action])),
    runsById: new Map(input.runs.map((run) => [run.runId, run])),
    runLogsByRunId: new Map((input.runLogs ?? []).map((runLog) => [runLog.runId, runLog])),
    lifecyclesByRunId: new Map((input.lifecycles ?? []).map((lifecycle) => [lifecycle.runId, lifecycle])),
    input,
  };
}

function inferSubjectType(ctx: ReviewContext, id: string): OperatorReviewSubjectType {
  if (ctx.requestsById.has(id)) return "request";
  if (ctx.plansById.has(id)) return "plan";
  if (ctx.decisionsById.has(id)) return "decision";
  if (ctx.tasksById.has(id)) return "task";
  if (ctx.actionsById.has(id)) return "action";
  if (ctx.runsById.has(id)) return "run";
  return "auto";
}

function plansForRequest(ctx: ReviewContext, requestId: string): OrchestratorPlanRecord[] {
  return ctx.input.plans.filter((plan) => plan.requestId === requestId);
}

function actionsForPlan(ctx: ReviewContext, plan: OrchestratorPlanRecord): RemoteActionRecord[] {
  const actionIds = plan.actionIds ?? [];
  if (actionIds.length) {
    return actionIds.flatMap((id) => {
      const action = ctx.actionsById.get(id);
      return action ? [action] : [];
    });
  }
  return ctx.input.actions.filter((action) => action.orchestratorPlanId === plan.id);
}

function decisionsForPlan(ctx: ReviewContext, plan: OrchestratorPlanRecord): DecisionItem[] {
  return ctx.input.decisions.filter(
    (decision) => decision.subject?.type === "orchestrator_plan" && decision.subject.id === plan.id,
  );
}

function taskForAction(ctx: ReviewContext, action: RemoteActionRecord): TaskSpec | undefined {
  return ctx.tasksById.get(action.taskId);
}

function runForAction(ctx: ReviewContext, action: RemoteActionRecord): RunSummary | undefined {
  if (action.result?.runId) return ctx.runsById.get(action.result.runId);
  return ctx.input.runs.find((run) => run.taskId === action.taskId);
}

function runLogForRun(ctx: ReviewContext, run: RunSummary | undefined): WorkerRunLog | undefined {
  return run ? ctx.runLogsByRunId.get(run.runId) : undefined;
}

function runLogForAction(ctx: ReviewContext, action: RemoteActionRecord): WorkerRunLog | undefined {
  if (action.result?.runId) return ctx.runLogsByRunId.get(action.result.runId);
  return ctx.input.runLogs?.find((runLog) => runLog.task.id === action.taskId);
}

function relatedPlanForAction(ctx: ReviewContext, action: RemoteActionRecord): OrchestratorPlanRecord | undefined {
  return action.orchestratorPlanId ? ctx.plansById.get(action.orchestratorPlanId) : undefined;
}

function relatedPlanForTask(ctx: ReviewContext, task: TaskSpec): OrchestratorPlanRecord | undefined {
  const action = ctx.input.actions.find((item) => item.taskId === task.id);
  if (action) return relatedPlanForAction(ctx, action);
  return ctx.input.plans.find((plan) => (plan.taskIds ?? []).includes(task.id));
}

function relatedPlanForRun(ctx: ReviewContext, run: RunSummary): OrchestratorPlanRecord | undefined {
  const action = ctx.input.actions.find((item) => item.result?.runId === run.runId || item.taskId === run.taskId);
  const task = ctx.tasksById.get(run.taskId);
  return action ? relatedPlanForAction(ctx, action) : task ? relatedPlanForTask(ctx, task) : undefined;
}

function resolveTarget(ctx: ReviewContext, subject: OperatorReviewSubject): ResolvedReviewTarget | undefined {
  const type = subject.type === "auto" ? inferSubjectType(ctx, subject.id) : subject.type;

  if (type === "request") {
    const request = ctx.requestsById.get(subject.id);
    if (!request) return undefined;
    return {
      label: `request ${code(request.id)}`,
      request,
      plans: plansForRequest(ctx, request.id),
    };
  }

  if (type === "plan") {
    const plan = ctx.plansById.get(subject.id);
    if (!plan) return undefined;
    return {
      label: `plan ${code(plan.id)}`,
      request: ctx.requestsById.get(plan.requestId),
      plans: [plan],
    };
  }

  if (type === "decision") {
    const decision = ctx.decisionsById.get(subject.id);
    if (!decision) return undefined;
    const plan = decision.subject?.type === "orchestrator_plan" ? ctx.plansById.get(decision.subject.id) : undefined;
    const action = decision.subject?.type === "remote_action" ? ctx.actionsById.get(decision.subject.id) : undefined;
    const task = decision.subject?.type === "task" ? ctx.tasksById.get(decision.subject.id) : action ? taskForAction(ctx, action) : undefined;
    const run = decision.subject?.type === "run" ? ctx.runsById.get(decision.subject.id) : action ? runForAction(ctx, action) : undefined;
    const relatedPlan = plan ?? (action ? relatedPlanForAction(ctx, action) : task ? relatedPlanForTask(ctx, task) : run ? relatedPlanForRun(ctx, run) : undefined);
    return {
      label: `decision ${code(decision.id)}`,
      request: relatedPlan ? ctx.requestsById.get(relatedPlan.requestId) : undefined,
      plans: relatedPlan ? [relatedPlan] : [],
      decision,
      task,
      action,
      run,
    };
  }

  if (type === "task") {
    const task = ctx.tasksById.get(subject.id);
    if (!task) return undefined;
    const plan = relatedPlanForTask(ctx, task);
    return {
      label: `task ${code(task.id)}`,
      request: plan ? ctx.requestsById.get(plan.requestId) : undefined,
      plans: plan ? [plan] : [],
      task,
    };
  }

  if (type === "action") {
    const action = ctx.actionsById.get(subject.id);
    if (!action) return undefined;
    const plan = relatedPlanForAction(ctx, action);
    return {
      label: `action ${code(action.id)}`,
      request: plan ? ctx.requestsById.get(plan.requestId) : undefined,
      plans: plan ? [plan] : [],
      task: taskForAction(ctx, action),
      action,
      run: runForAction(ctx, action),
    };
  }

  if (type === "run") {
    const run = ctx.runsById.get(subject.id);
    if (!run) return undefined;
    const plan = relatedPlanForRun(ctx, run);
    return {
      label: `run ${code(run.runId)}`,
      request: plan ? ctx.requestsById.get(plan.requestId) : undefined,
      plans: plan ? [plan] : [],
      task: ctx.tasksById.get(run.taskId),
      action: ctx.input.actions.find((action) => action.result?.runId === run.runId || action.taskId === run.taskId),
      run,
    };
  }

  return undefined;
}

function planFailed(plan: OrchestratorPlanRecord, actions: RemoteActionRecord[]): boolean {
  if (plan.status === "failed") return true;
  if (plan.synthesis && plan.synthesis.outcome !== "pass") return true;
  return actions.some((action) => action.status === "failed" || action.result?.pass === false);
}

function planBlocked(plan: OrchestratorPlanRecord, actions: RemoteActionRecord[], runs: RunSummary[]): boolean {
  if (plan.status === "questions" || plan.synthesis?.outcome === "blocked" || plan.synthesis?.outcome === "needs-BK") return true;
  if (actions.some((action) => action.status === "waiting" || action.result?.outcome === "blocked")) return true;
  return runs.some((run) => run.outcome === "blocked");
}

function runIsPartiallyIntegrated(run: RunSummary, lifecycle: RunLifecycleRecord | undefined): boolean {
  return Boolean(run.pass && run.commit && (!lifecycle?.mergedAt || !lifecycle.pushedAt || !lifecycle.cleanedAt));
}

function actionPassed(action: RemoteActionRecord | undefined): boolean {
  return Boolean(action && action.status === "completed" && action.result?.pass !== false);
}

function recoveryPlanFixed(ctx: ReviewContext, plan: OrchestratorPlanRecord): boolean {
  if (plan.status !== "materialized" || !plan.resultReportedAt || plan.synthesis?.outcome !== "pass") return false;
  const actionIds = plan.actionIds ?? [];
  if (!actionIds.length) return false;
  return actionIds.every((id) => actionPassed(ctx.actionsById.get(id)));
}

function recoveryRequestsForPlan(ctx: ReviewContext, planId: string): OrchestrationRequestRecord[] {
  return ctx.input.requests.filter((request) => request.recoveryOfPlanId === planId);
}

function finalStateLabels(ctx: ReviewContext, target: ResolvedReviewTarget): string[] {
  const labels = new Set<string>();
  const plans = target.plans;
  const actions = plans.flatMap((plan) => actionsForPlan(ctx, plan));
  const runs = actions.flatMap((action) => {
    const run = runForAction(ctx, action);
    return run ? [run] : [];
  });
  if (target.action && !actions.includes(target.action)) actions.push(target.action);
  if (target.run && !runs.includes(target.run)) runs.push(target.run);

  if (plans.some((plan) => planBlocked(plan, actionsForPlan(ctx, plan), runs))) labels.add("blocked");
  if (plans.some((plan) => planFailed(plan, actionsForPlan(ctx, plan))) || actions.some((action) => action.status === "failed" || action.result?.pass === false) || runs.some((run) => !run.pass)) {
    labels.add("failed");
  }
  if (plans.some((plan) => recoveryRequestsForPlan(ctx, plan.id).some((request) => plansForRequest(ctx, request.id).some((recoveryPlan) => recoveryPlanFixed(ctx, recoveryPlan))))) {
    labels.add("recovered");
  }
  if (target.request?.recoveryOfPlanId && plans.some((plan) => recoveryPlanFixed(ctx, plan))) labels.add("recovered");
  if (runs.some((run) => runIsPartiallyIntegrated(run, ctx.lifecyclesByRunId.get(run.runId)))) labels.add("partially_integrated");

  const allFinalActions = actions.length > 0 && actions.every((action) => action.status === "completed" && action.result?.pass !== false);
  const allRunsIntegrated = runs.every((run) => !run.commit || !run.pass || !runIsPartiallyIntegrated(run, ctx.lifecyclesByRunId.get(run.runId)));
  const allPlansPassing = plans.every((plan) => !plan.synthesis || plan.synthesis.outcome === "pass");
  if (allFinalActions && allRunsIntegrated && allPlansPassing && !labels.has("failed") && !labels.has("blocked")) {
    labels.add("completed");
  }

  return labels.size ? [...labels] : ["unknown"];
}

function requestLines(request: OrchestrationRequestRecord | undefined, gaps: string[], plan?: OrchestratorPlanRecord): string[] {
  if (!request) {
    if (plan) gaps.push(`request: missing request record ${plan.requestId} for plan ${plan.id}`);
    return ["- request: missing"];
  }
  return [
    `- request ${code(request.id)} status=${statusText(request.status)} source=${statusText(request.source)} created=${code(request.createdAt)}`,
    request.recoveryOfPlanId ? `  recoveryOf=${code(request.recoveryOfPlanId)}` : "",
    `  text: ${clip(request.text)}`,
  ].filter(Boolean);
}

function planLines(plan: OrchestratorPlanRecord): string[] {
  return [
    `- plan ${code(plan.id)} status=${statusText(plan.status)} created=${code(plan.createdAt)}`,
    plan.completedAt ? `  completed=${code(plan.completedAt)}` : "",
    plan.approvedAt ? `  approved=${code(plan.approvedAt)}` : "",
    plan.materializedAt ? `  materialized=${code(plan.materializedAt)}` : "",
    plan.resultReportedAt ? `  resultReported=${code(plan.resultReportedAt)}` : "",
    plan.synthesis ? `  synthesis=${code(plan.synthesis.outcome)} summary=${clip(plan.synthesis.summary)}` : "",
    plan.synthesisFailure ? `  synthesisFailure=${clip(plan.synthesisFailure)}` : "",
    plan.payload?.summary ? `  summary: ${clip(plan.payload.summary)}` : "",
    plan.payload?.risks.length ? `  plan risks: ${plan.payload.risks.map(clip).join(" / ")}` : "",
  ].filter(Boolean);
}

function decisionLines(ctx: ReviewContext, plan: OrchestratorPlanRecord, gaps: string[]): string[] {
  const decisions = decisionsForPlan(ctx, plan);
  if (!decisions.length) {
    if (plan.status === "planned" || plan.status === "questions" || plan.status === "approved" || plan.status === "materialized") {
      gaps.push(`decision: no decision record for plan ${plan.id}`);
    }
    return ["- decision: none recorded"];
  }

  if (plan.status === "materialized" && !decisions.some((decision) => decision.status === "resolved" && decision.resolution === "approved")) {
    gaps.push(`decision: plan ${plan.id} materialized without an approved decision record`);
  }

  return decisions.map((decision) => {
    const resolution = decision.resolution ? ` resolution=${code(decision.resolution)}` : "";
    const resolved = decision.resolvedAt ? ` resolved=${code(decision.resolvedAt)} by=${code(decision.resolvedBy)}` : "";
    const risk = decision.risk ? ` risk=${code(decision.risk)}` : "";
    return `- decision ${code(decision.id)} kind=${code(decision.kind)} status=${code(decisionLifecycleStatus(decision))}${resolution}${resolved}${risk}`;
  });
}

function proposedTaskLines(plan: OrchestratorPlanRecord): string[] {
  const proposals = plan.payload?.tasks ?? [];
  if (!proposals.length) return ["- proposed tasks: none recorded"];
  return proposals.map((task) =>
    `- proposed ${code(task.id)} title=${clip(task.title)} agent=${code(task.targetAgent)} mode=${code(task.resultMode ?? "write")} verify=${code(String(task.verifyCommands.length))}`,
  );
}

function materializedTaskLines(ctx: ReviewContext, plan: OrchestratorPlanRecord, actions: RemoteActionRecord[], gaps: string[]): string[] {
  const ids = plan.taskIds ?? [];
  const taskIds = ids.length ? ids : [...new Set(actions.map((action) => action.taskId))];
  if (plan.status === "materialized" && !ids.length) gaps.push(`task: materialized plan ${plan.id} has no taskIds; reconstructed task links from actions`);
  if (!taskIds.length) {
    if (plan.status === "materialized") gaps.push(`task: materialized plan ${plan.id} has no task records`);
    return ["- task: none recorded"];
  }

  return taskIds.map((id) => {
    const task = ctx.tasksById.get(id);
    if (!task) {
      gaps.push(`task: missing task record ${id} for plan ${plan.id}`);
      return `- task ${code(id)} missing`;
    }
    return `- task ${code(task.id)} status=${code(task.status)} agent=${code(task.targetAgent)} mode=${code(task.resultMode ?? "write")} files=${code(String(task.targetFiles.length))} verify=${code(String(task.verifyCommands.length))}`;
  });
}

function actionLines(ctx: ReviewContext, plan: OrchestratorPlanRecord, actions: RemoteActionRecord[], gaps: string[]): string[] {
  for (const id of plan.actionIds ?? []) {
    if (!ctx.actionsById.has(id)) gaps.push(`action: missing action record ${id} for plan ${plan.id}`);
  }
  if (!actions.length) {
    if (plan.status === "materialized") gaps.push(`action: materialized plan ${plan.id} has no action records`);
    return ["- action: none recorded"];
  }

  return actions.map((action) => {
    const result = action.result;
    const dependency = action.dependsOnActionIds?.length ? ` dependsOn=${code(action.dependsOnActionIds.join(","))}` : "";
    const run = result?.runId ? ` run=${code(result.runId)}` : "";
    const pass = result?.pass === undefined ? "" : ` pass=${result.pass ? "yes" : "no"}`;
    const failure = result?.failure ? ` failure=${clip(result.failure)}` : "";
    return `- action ${code(action.id)} status=${code(action.status)} task=${code(action.taskId)} created=${code(action.createdAt)} approved=${code(action.approvedAt)} started=${code(action.startedAt)} completed=${code(action.completedAt)}${dependency}${run}${pass}${failure}`;
  });
}

function runLines(ctx: ReviewContext, actions: RemoteActionRecord[], targetRun: RunSummary | undefined, gaps: string[]): string[] {
  const runs: Array<{ action?: RemoteActionRecord; run?: RunSummary; runLog?: WorkerRunLog }> = actions
    .map((action) => ({ action, run: runForAction(ctx, action), runLog: runLogForAction(ctx, action) }))
    .filter((item, index, items) => item.run && items.findIndex((candidate) => candidate.run?.runId === item.run?.runId) === index);
  if (targetRun && !runs.some((item) => item.run?.runId === targetRun.runId)) {
    runs.push({ action: actions.find((action) => action.result?.runId === targetRun.runId), run: targetRun, runLog: runLogForRun(ctx, targetRun) });
  }

  for (const action of actions) {
    if ((action.status === "completed" || action.status === "failed") && !action.result?.runId) {
      gaps.push(`run: final action ${action.id} has no runId`);
    }
    if (action.result?.runId && !ctx.runsById.has(action.result.runId)) {
      gaps.push(`run: missing run summary ${action.result.runId} for action ${action.id}`);
    }
    if (action.result?.runLogPath && !runLogForAction(ctx, action)) {
      gaps.push(`run: missing run log ${action.result.runLogPath} for action ${action.id}`);
    }
  }
  if (targetRun && !runLogForRun(ctx, targetRun)) gaps.push(`run: missing run log ${targetRun.logPath} for run ${targetRun.runId}`);

  if (!runs.length) return ["- run: none recorded"];

  return runs.flatMap(({ run }) => {
    if (!run) return [];
    return [
      `- run ${code(run.runId)} outcome=${code(run.outcome)} pass=${run.pass ? "yes" : "no"} task=${code(run.taskId)} finished=${code(run.finishedAt)}`,
      run.commit ? `  commit=${code(run.commit)}` : "  commit=none",
      run.failureReason ? `  failure=${clip(run.failureReason)}` : "",
      `  runLog=${code(run.logPath)}`,
      `  worktree=${code(run.worktreePath)}`,
    ].filter(Boolean);
  });
}

function verifyLines(ctx: ReviewContext, actions: RemoteActionRecord[], targetRun: RunSummary | undefined, gaps: string[]): string[] {
  const runLogs = actions
    .map((action) => runLogForAction(ctx, action))
    .filter((runLog, index, items): runLog is WorkerRunLog => Boolean(runLog) && items.findIndex((candidate) => candidate?.runId === runLog?.runId) === index);
  const targetRunLog = runLogForRun(ctx, targetRun);
  if (targetRunLog && !runLogs.some((runLog) => runLog.runId === targetRunLog.runId)) runLogs.push(targetRunLog);
  if (!runLogs.length) return ["- verify: none recorded"];

  return runLogs.flatMap((runLog) => {
    const expectedCommands = runLog.task.verifyCommands;
    const results = runLog.result.evaluation?.verifyResults ?? [];
    if (expectedCommands.length > 0 && results.length === 0) {
      gaps.push(`verify: run ${runLog.runId} has ${expectedCommands.length} expected verify command(s) but no verify results`);
    }
    const changedFiles = runLog.result.evaluation?.changedFiles ?? runLog.result.commit?.files ?? [];
    const lines = [
      `- verify run=${code(runLog.runId)} harness=${code(runLog.result.evaluation?.harness?.status ?? "missing")} expected=${code(String(expectedCommands.length))}`,
      runLog.result.evaluation?.parseError ? `  parseError=${clip(runLog.result.evaluation.parseError)}` : "",
      changedFiles.length ? `  changedFiles=${changedFiles.map(code).join(", ")}` : "  changedFiles=none",
    ].filter(Boolean);
    if (!results.length) return lines;
    return [
      ...lines,
      ...results.map((result) => `  ${result.exitCode === 0 ? "pass" : "fail"} exit=${code(String(result.exitCode))} command=${code(result.command)}`),
    ];
  });
}

function integrationLines(ctx: ReviewContext, actions: RemoteActionRecord[], targetRun: RunSummary | undefined, gaps: string[]): string[] {
  const runs = actions
    .map((action) => runForAction(ctx, action))
    .filter((run, index, items): run is RunSummary => Boolean(run) && items.findIndex((candidate) => candidate?.runId === run?.runId) === index);
  if (targetRun && !runs.some((run) => run.runId === targetRun.runId)) runs.push(targetRun);
  const committed = runs.filter((run) => run.pass && run.commit);
  if (!committed.length) return ["- merge: not applicable (no passing committed run)", "- push: not applicable", "- cleanup: not applicable"];

  return committed.flatMap((run) => {
    const lifecycle = ctx.lifecyclesByRunId.get(run.runId);
    if (!lifecycle) {
      gaps.push(`merge: no lifecycle record for committed run ${run.runId}`);
      return [
        `- merge run=${code(run.runId)} status=${code("missing")}`,
        `- push run=${code(run.runId)} status=${code("missing")}`,
        `- cleanup run=${code(run.runId)} status=${code("missing")}`,
      ];
    }
    if (!lifecycle.mergedAt) gaps.push(`merge: no mergedAt timestamp for committed run ${run.runId}`);
    if (!lifecycle.pushedAt) gaps.push(`push: no pushedAt timestamp for committed run ${run.runId}`);
    if (!lifecycle.cleanedAt) gaps.push(`cleanup: no cleanedAt timestamp for committed run ${run.runId}`);
    return [
      `- merge run=${code(run.runId)} status=${lifecycle.mergedAt ? "yes" : "missing"} at=${code(lifecycle.mergedAt)}`,
      `- push run=${code(run.runId)} status=${lifecycle.pushedAt ? "yes" : "missing"} at=${code(lifecycle.pushedAt)}`,
      `- cleanup run=${code(run.runId)} status=${lifecycle.cleanedAt ? "yes" : "missing"} at=${code(lifecycle.cleanedAt)}`,
    ];
  });
}

function recoveryLines(ctx: ReviewContext, plan: OrchestratorPlanRecord, request: OrchestrationRequestRecord | undefined, gaps: string[]): string[] {
  const lines: string[] = [];
  if (request?.recoveryOfPlanId) {
    const sourcePlan = ctx.plansById.get(request.recoveryOfPlanId);
    if (!sourcePlan) gaps.push(`recovery: missing source plan ${request.recoveryOfPlanId} for recovery request ${request.id}`);
    lines.push(`- recoveryOf=${code(request.recoveryOfPlanId)} sourceStatus=${statusText(sourcePlan?.status)}`);
    lines.push(
      recoveryPlanFixed(ctx, plan)
        ? `- recovery verdict: fixed source plan ${code(request.recoveryOfPlanId)}`
        : `- recovery verdict: not fixed or not fully reported for source plan ${code(request.recoveryOfPlanId)}`,
    );
  }

  const recoveryRequests = recoveryRequestsForPlan(ctx, plan.id);
  if (!recoveryRequests.length) {
    if (planFailed(plan, actionsForPlan(ctx, plan))) gaps.push(`recovery: failed plan ${plan.id} has no recovery request`);
    return lines.length ? lines : ["- recovery: none recorded"];
  }

  for (const recoveryRequest of recoveryRequests) {
    lines.push(`- recovery request ${code(recoveryRequest.id)} status=${code(recoveryRequest.status)} created=${code(recoveryRequest.createdAt)}`);
    const recoveryPlans = plansForRequest(ctx, recoveryRequest.id);
    if (!recoveryPlans.length) {
      gaps.push(`recovery: request ${recoveryRequest.id} has no recovery plan`);
      lines.push("  plan=missing");
      continue;
    }
    for (const recoveryPlan of recoveryPlans) {
      const verdict = recoveryPlanFixed(ctx, recoveryPlan)
        ? "fixed"
        : planFailed(recoveryPlan, actionsForPlan(ctx, recoveryPlan))
          ? "still failing"
          : "pending";
      lines.push(`  plan ${code(recoveryPlan.id)} status=${code(recoveryPlan.status)} synthesis=${code(recoveryPlan.synthesis?.outcome)} verdict=${code(verdict)}`);
    }
  }

  return lines;
}

function workflowLines(ctx: ReviewContext, target: ResolvedReviewTarget, gaps: string[]): string[] {
  const lines: string[] = [];
  if (!target.plans.length) {
    lines.push("## Chain", "", ...requestLines(target.request, gaps), "- plan: none recorded");
    if (target.decision) lines.push(`- decision ${code(target.decision.id)} kind=${code(target.decision.kind)} status=${code(decisionLifecycleStatus(target.decision))}`);
    if (target.task) lines.push(`- task ${code(target.task.id)} status=${code(target.task.status)}`);
    if (target.action) lines.push(...actionLines(ctx, { id: "unplanned", requestId: "", status: "materialized", createdAt: "", schemaVersion: 1 } as OrchestratorPlanRecord, [target.action], gaps));
    if (target.run) lines.push(...runLines(ctx, target.action ? [target.action] : [], target.run, gaps));
    return lines;
  }

  for (const plan of target.plans) {
    const request = ctx.requestsById.get(plan.requestId) ?? target.request;
    const actions = actionsForPlan(ctx, plan);
    lines.push(
      "## Chain",
      "",
      "request -> plan -> decision -> task -> action -> run -> verify -> merge -> push -> cleanup -> recovery",
      "",
      "Request:",
      ...requestLines(request, gaps, plan),
      "",
      "Plan:",
      ...planLines(plan),
      "",
      "Decision / Approval:",
      ...decisionLines(ctx, plan, gaps),
      "",
      "Task:",
      ...(plan.status === "planned" || plan.status === "questions" ? proposedTaskLines(plan) : materializedTaskLines(ctx, plan, actions, gaps)),
      "",
      "Action:",
      ...actionLines(ctx, plan, actions, gaps),
      "",
      "Run:",
      ...runLines(ctx, actions, target.run, gaps),
      "",
      "Verify:",
      ...verifyLines(ctx, actions, target.run, gaps),
      "",
      "Merge / Push / Cleanup:",
      ...integrationLines(ctx, actions, target.run, gaps),
      "",
      "Recovery:",
      ...recoveryLines(ctx, plan, request, gaps),
      "",
      "Remaining Risks:",
      ...(remainingRiskLines(ctx, plan).length ? remainingRiskLines(ctx, plan) : ["- none recorded"]),
      "",
    );
  }
  return lines;
}

function remainingRiskLines(ctx: ReviewContext, plan: OrchestratorPlanRecord): string[] {
  const values = [
    ...(plan.payload?.risks ?? []),
    ...(plan.synthesis?.risks ?? []),
    ...decisionsForPlan(ctx, plan).flatMap((decision) => decision.risk ? [decision.risk] : []),
  ];
  return [...new Set(values.map(clip).filter(Boolean))].map((risk) => `- ${risk}`);
}

export function operatorReviewReport(input: OperatorReviewReportInput): string {
  const ctx = makeContext(input);
  const target = resolveTarget(ctx, input.subject);
  if (!target) {
    return ["# operator-review", "", `Target not found: ${code(input.subject.id)}`].join("\n");
  }

  const gaps: string[] = [];
  const body = workflowLines(ctx, target, gaps);
  const states = finalStateLabels(ctx, target);
  const uniqueGaps = [...new Set(gaps)];

  return [
    "# operator-review",
    "",
    `Target: ${target.label}`,
    `Final state: ${states.join(", ")}`,
    `Audit gaps: ${uniqueGaps.length ? uniqueGaps.length : "none"}`,
    "",
    ...body,
    "## Audit Gaps",
    "",
    ...(uniqueGaps.length ? uniqueGaps.map((gap) => `- ${gap}`) : ["- none"]),
    "",
    "## Local References",
    "",
    `- requests: ${code("state/orchestration-requests.jsonl")}`,
    `- plans: ${code("state/orchestrator-plans.jsonl")}`,
    `- decisions: ${code("state/decisions.jsonl")}`,
    `- tasks: ${code("state/tasks.jsonl")}`,
    `- actions: ${code("state/remote-actions.jsonl")}`,
    `- runs: ${code("state/runs.jsonl")}`,
    `- lifecycle: ${code("state/run-lifecycle.jsonl")}`,
  ].join("\n");
}
