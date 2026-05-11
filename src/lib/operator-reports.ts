import type { TaskSpec } from "./contracts";
import { buildCeoStatusSnapshot, type CeoStatusSnapshot } from "./ceo-status";
import {
  evaluateBudgetEnforcement,
  summarizeCostBudgetAuditRollups,
  summarizeCostBudgetAuditRecords,
  type BudgetPolicyRecord,
  type CostBudgetAuditRecord,
  type CostBudgetAuditRollup,
  type CostBudgetTotal,
} from "./cost-budget-audit";
import type { DaemonHealthResult, DaemonHeartbeat } from "./daemon";
import { latestCurrentPendingBlockerClarification, type DecisionItem } from "./decision-store";
import type { RunSummary } from "./ledger";
import { buildOperatingSurfaceView } from "./operating-surface";
import type { OpsSnapshot } from "./ops-diagnostics";
import { blockerForPlan, payloadBlockerForPlan, type OrchestratorPlanBlocker } from "./orchestrator-blockers";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord, OrchestratorSynthesisPayload } from "./orchestrator-store";
import type { CeoReportRecord } from "./ceo-report-store";
import type { GovernanceEventRecord } from "./governance-event-store";
import { buildProjectQueueSnapshot, formatProjectQueueSnapshot } from "./project-queues";
import { classifyRemoteRequest, projectRemoteScopeRisk, type ProjectProfile, type ProjectRemoteScope, type RemoteRequestClassification } from "./project-profile";
import type { ProposalRecord } from "./proposal-store";
import { formatQueuePressureGuidance, formatQueuePressureSnapshot, type QueuePressureSnapshot } from "./queue-pressure";
import { remoteActionCommand, type RemoteActionRecord } from "./remote-action-store";
import {
  agentRoleForId,
  agentRoleLabel,
  oneLine,
  resultModeLabel,
  roleOutcomeSummary,
} from "./role-reporting";
import { advisoryRoleTopologySummaryForRole } from "./role-topology";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { WorkerRunLog } from "./run-log";
import type { TaskDraftRecord } from "./task-draft-store";

const telegramCommandReplacements: Array<[RegExp, string]> = [
  [/(^|[^\w/])\/help_advanced\b/g, "$1/help"],
  [/(^|[^\w/])\/help advanced\b/g, "$1/help"],
  [/(^|[^\w/])\/(?:next_action|next-action|runs|run_latest|run_next|run-next|tasks|task|actions|action_current|action|proposals|proposal_next|proposal|drafts|draft_next)\b/g, "$1/now"],
  [/(^|[^\w/])\/run\b/g, "$1/now"],
  [/(^|[^\w/])\/(?:status|dashboard)\b/g, "$1/check"],
  [/(^|[^\w/])\/(?:doctor|health|failures)\b/g, "$1/problems"],
  [/(^|[^\w/])\/(?:accept|draft_approve|draft-approve|yes|prepare_dispatch|prepare-dispatch|approve_action|approve-action)\b/g, "$1/go"],
  [/(^|[^\w/])\/reject\b/g, "$1/cancel"],
  [/(^|[^\w/])\/(?:draft_prepare|draft-prepare)\b/g, "$1/plan"],
  [/(^|[^\w/])\/(?:propose|draft_propose|draft-propose|draft)\b/g, "$1/work <요청>"],
];

function telegramSafeText(value: string): string {
  let safe = value;
  for (const [pattern, replacement] of telegramCommandReplacements) {
    safe = safe.replace(pattern, replacement);
  }
  return safe;
}

function telegramSafeLine(value: string): string {
  return telegramSafeText(oneLine(value));
}

function telegramSafeClipText(text: string, maxLength = 3500): string {
  return clipText(telegramSafeText(text), maxLength);
}

function remoteSafeSuggestion(value: string): string {
  return telegramSafeLine(value);
}

function remoteNotificationText(value: string): string {
  return remoteSafeSuggestion(value)
    .replace(/\b(?:request|plan|action|draft|proposal|run|task|decision)-[a-z0-9][a-z0-9-]{4,}\b/gi, "해당 항목")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "<local path>");
}

function remoteStatusItemLabel(item: { kind: string; title: string; status: string }): string {
  const title = remoteNotificationText(item.title);
  const kindLabels: Record<string, string> = {
    action: "worker action",
    diagnostic: "diagnostic",
    orchestration_request: "work request",
    orchestrator_plan: "plan",
    run: "worker run",
    task: "task",
  };
  if (title && title !== "해당 항목" && !/^(?:request|plan|action|draft|proposal|run|task|decision)-/i.test(title)) return title;
  return `${kindLabels[item.kind] ?? item.kind} ${item.status}`;
}

function remoteActionLabelForNotification(label: string, blocker: { kind: string; title: string; status: string } | undefined): string {
  const safe = remoteNotificationText(label);
  if (!blocker || !safe.includes("해당 항목")) return safe;
  return safe.replace("해당 항목", remoteStatusItemLabel(blocker));
}

function code(value: string): string {
  return `\`${oneLine(value).replace(/`/g, "'")}\``;
}

function recent<T>(items: T[], limit: number): T[] {
  return [...items].slice(-limit).reverse();
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function recordProjectId(record: { ancestry?: { mode: string; projectId?: string } }): string | undefined {
  return record.ancestry?.mode === "assigned" && record.ancestry.projectId ? record.ancestry.projectId : undefined;
}

function recordProjectLabel(record: { ancestry?: { mode: string; projectId?: string } }): string {
  return recordProjectId(record) ?? "unassigned";
}

function isRecoveryRequest(request: OrchestrationRequestRecord): boolean {
  return Boolean(request.recoveryOfPlanId);
}

function currentProjectAction(plan: OrchestratorPlanRecord): string {
  const project = recordProjectId(plan);
  const label = project ?? "unassigned";
  if (!project) return `${label}: 프로젝트를 먼저 확정해야 합니다`;
  if (plan.status === "questions") {
    return `${label}: 답변 ${code(`/answer project:${project} <답변>`)} 또는 수정 ${code(`/revise project:${project} <피드백>`)}`;
  }
  return `${label}: 확인 ${code(`/plan_current project:${project}`)} / 승인+실행 ${code(`/go project:${project}`)} / 취소 ${code(`/cancel project:${project}`)}`;
}

function currentRequestAction(request: OrchestrationRequestRecord): string {
  const project = recordProjectId(request);
  const label = project ?? "unassigned";
  if (!project) return `${label}: 프로젝트 없는 pending 요청 - 로컬 CLI 또는 dashboard에서 출처 확인`;
  if (isRecoveryRequest(request)) return `${label}: 복구 요청 대기 중 / 복구 요청 정리 ${code(`/drop recovery project:${project}`)}`;
  return `${label}: 계획 생성 ${code(`/plan ${project}`)} / 요청 취소 ${code(`/cancel project:${project}`)}`;
}

function currentRequestProjectSummary(input: { projectId: string; requests: OrchestrationRequestRecord[] }): string[] {
  const normal = input.requests.filter((request) => !isRecoveryRequest(request));
  const recovery = input.requests.filter(isRecoveryRequest);
  return [
    `- ${input.projectId}: pending ${input.requests.length}개`,
    normal.length ? `  계획 생성: ${code(`/plan ${input.projectId}`)}` : "",
    normal.length > 1 ? `  오래된 중복 정리: ${code(`/drop stale project:${input.projectId}`)}` : "",
    recovery.length ? "  복구 요청 대기 중" : "",
    recovery.length ? `  복구 요청 정리: ${code(`/drop recovery project:${input.projectId}`)}` : "",
  ].filter(Boolean);
}

function currentPlanAmbiguityReport(input: { plans: OrchestratorPlanRecord[] }): string {
  return [
    "# now",
    "",
    "여러 프로젝트에 현재 계획이 있어 원격 실행/승인을 보류합니다.",
    "",
    "프로젝트별 안전 액션:",
    ...input.plans.map((plan) => `- ${currentProjectAction(plan)}`),
    "",
    "다음 액션:",
    `- 위 목록에서 프로젝트 하나를 골라 해당 명령을 그대로 보내세요.`,
    `- 전체 상태 확인: ${code("/check")}`,
  ].join("\n");
}

function currentRequestAmbiguityReport(input: { requests: OrchestrationRequestRecord[] }): string {
  const byProject = new Map<string, OrchestrationRequestRecord[]>();
  const unassigned: OrchestrationRequestRecord[] = [];
  for (const request of input.requests) {
    const project = recordProjectId(request);
    if (!project) {
      unassigned.push(request);
      continue;
    }
    byProject.set(project, [...(byProject.get(project) ?? []), request]);
  }
  const projectLines = [...byProject.entries()].flatMap(([projectId, requests]) =>
    currentRequestProjectSummary({ projectId, requests }),
  );
  if (projectLines.length === 0) {
    return [
      "# now",
      "",
      "여러 pending 작업 요청이 있지만 모두 프로젝트가 없어 Telegram에서 안전한 계획 명령을 만들 수 없습니다.",
      "",
      "원격에서 보낼 명령:",
      "- 없음",
      "",
      "이유:",
      `- project 없는 pending 요청 ${unassigned.length}개는 ${code("/plan <project>")} 대상이 불명확합니다.`,
      "- Samantha는 내부 request id를 Telegram workflow로 받지 않습니다.",
      "",
      "다음 액션:",
      `- 로컬 CLI/dashboard에서 요청 출처를 확인하고 project가 있는 새 요청으로 다시 제출하거나 정리하세요.`,
      `- 로컬: ${code("bun run samantha orchestrator:current")}`,
      `- 운영 이상 진단: ${code("/problems")}`,
    ].join("\n");
  }
  return [
    "# now",
    "",
    "여러 pending 작업 요청이 있어 원격 계획 생성을 보류합니다.",
    "",
    "프로젝트별 실행 가능한 액션:",
    ...projectLines,
    unassigned.length ? `- unassigned: pending ${unassigned.length}개 - 로컬 CLI 또는 dashboard에서 출처 확인` : "",
    "",
    "다음 액션:",
    `- 위 목록의 프로젝트별 명령을 그대로 보내세요.`,
    unassigned.length ? `- unassigned 요청은 로컬 CLI/dashboard에서 출처를 확인하세요.` : "",
    `- 전체 상태 확인: ${code("/check")}`,
  ].filter(Boolean).join("\n");
}

function latestPrimaryWorkflowTimestamp(input: {
  runs: RunSummary[];
  actions: RemoteActionRecord[];
  orchestrationRequests?: OrchestrationRequestRecord[];
  orchestratorPlans?: OrchestratorPlanRecord[];
  lifecycles?: RunLifecycleRecord[];
}): number {
  return Math.max(
    0,
    ...input.runs.map((run) => timestamp(run.finishedAt)),
    ...input.actions.flatMap((action) => [
      timestamp(action.createdAt),
      timestamp(action.approvedAt),
      timestamp(action.startedAt),
      timestamp(action.completedAt),
    ]),
    ...(input.orchestrationRequests ?? []).flatMap((request) => [
      timestamp(request.createdAt),
      timestamp(request.plannedAt),
      timestamp(request.discardedAt),
    ]),
    ...(input.orchestratorPlans ?? []).flatMap((plan) => [
      timestamp(plan.createdAt),
      timestamp(plan.completedAt),
      timestamp(plan.approvedAt),
      timestamp(plan.materializedAt),
      timestamp(plan.resultReportedAt),
      timestamp(plan.synthesisAt),
      timestamp(plan.canceledAt),
      timestamp(plan.supersededAt),
    ]),
    ...(input.lifecycles ?? []).map((lifecycle) => timestamp(lifecycle.updatedAt)),
  );
}

function shortCommit(commit: string): string {
  return commit ? commit.slice(0, 12) : "";
}

function displayFilePath(file: string): string {
  return oneLine(file).replace(/\//g, " > ");
}

function runLine(run: RunSummary): string {
  const commit = shortCommit(run.commit);
  const reason = run.failureReason ? ` reason=${code(run.failureReason)}` : "";
  return [
    `- ${code(run.runId)}`,
    `outcome=${code(run.outcome)}`,
    `task=${code(run.taskId)}`,
    `finished=${code(run.finishedAt)}`,
    commit ? `commit=${code(commit)}` : "",
    reason,
  ]
    .filter(Boolean)
    .join(" ");
}

function taskLine(task: TaskSpec): string {
  const archive = task.status === "archived" && task.archiveReason ? ` reason=${code(task.archiveReason)}` : "";
  return `- ${code(task.id)} status=${code(task.status)} agent=${code(task.targetAgent)}${archive}`;
}

function proposalLine(proposal: ProposalRecord): string {
  return `- ${code(proposal.id)} status=${code(proposal.status)} created=${code(proposal.createdAt)} text=${oneLine(proposal.text)}`;
}

function draftLine(draft: TaskDraftRecord): string {
  return `- ${code(draft.id)} status=${code(draft.status)} source=${code(draft.sourceProposalId)} created=${code(draft.createdAt)} title=${oneLine(draft.title)}`;
}

function remoteActionLine(action: RemoteActionRecord): string {
  return `- ${code(action.id)} status=${code(action.status)} kind=${code(action.kind)} task=${code(action.taskId)} created=${code(action.createdAt)}`;
}

function costAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function costTotalText(totals: CostBudgetTotal[]): string {
  return totals.length ? totals.map((total) => `${total.currency} ${costAmount(total.amount)}`).join(", ") : "unavailable";
}

function costDataText(record: CostBudgetAuditRecord): string {
  if (record.cost.kind === "unknown") return "unknown";
  return `${record.cost.kind} ${record.cost.currency} ${costAmount(record.cost.amount)}`;
}

function gapReasonText(records: ReturnType<typeof summarizeCostBudgetAuditRollups>["gaps"]): string {
  const counts = new Map<string, number>();
  for (const gap of records) {
    for (const reason of gap.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
}

function rollupLine(label: string, rollups: CostBudgetAuditRollup[]): string {
  if (rollups.length === 0) return `- ${label} rollup: no attributed observations`;
  const visible = rollups.slice(0, 3).map((rollup) =>
    `${rollup.key} observations=${rollup.total} measured=${rollup.measured} estimated=${rollup.estimated} unknown=${rollup.unknown} known_measured=${costTotalText(rollup.measuredTotals)} known_estimated=${costTotalText(rollup.estimatedTotals)} audit_gaps=${rollup.auditGaps}`,
  );
  const more = rollups.length > visible.length ? `; +${rollups.length - visible.length} more` : "";
  return `- ${label} rollup: ${visible.join("; ")}${more}`;
}

function budgetAuditLines(input: {
  records?: CostBudgetAuditRecord[];
  policies?: BudgetPolicyRecord[];
  decisions?: DecisionItem[];
  governanceEvents?: GovernanceEventRecord[];
  projectId?: string;
}): string[] {
  const records = input.records;
  if (!records) return [];
  const budgetGate = evaluateBudgetEnforcement({
    policies: input.policies,
    observations: records,
    context: { projectId: input.projectId },
    decisions: input.decisions,
    governanceEvents: input.governanceEvents,
  });
  const summary = summarizeCostBudgetAuditRecords(records);
  if (summary.total === 0) {
    return [
      "",
      "Budget audit:",
      "- observations: none recorded",
      "- cost total: unavailable (missing cost data is unknown, not zero)",
      `- budget gate: ${budgetGate.state}`,
    ];
  }

  const latest = summary.latest;
  const rollupSummary = summarizeCostBudgetAuditRollups(records);
  return [
    "",
    "Budget audit:",
    `- observations: total=${summary.total} measured=${summary.measured} estimated=${summary.estimated} unknown=${summary.unknown}`,
    `- known measured total: ${costTotalText(summary.measuredTotals)}`,
    `- known estimated total: ${costTotalText(summary.estimatedTotals)}`,
    "- unknown observations are missing cost data, not zero cost",
    `- budget gate: ${budgetGate.state}${budgetGate.state === "ok" ? "" : ` - ${budgetGate.reasons.join("; ")}`}`,
    rollupSummary.gaps.length
      ? `- budget audit gaps: ${rollupSummary.gaps.length} records ${gapReasonText(rollupSummary.gaps)}`
      : "- budget audit gaps: none",
    rollupLine("project", rollupSummary.rollups.project),
    rollupLine("goal", rollupSummary.rollups.goal),
    rollupLine("action", rollupSummary.rollups.action),
    rollupLine("run", rollupSummary.rollups.run),
    rollupLine("model", rollupSummary.rollups.model),
    rollupLine("command", rollupSummary.rollups.command),
    latest
      ? `- latest: subject=${code(`${latest.subject.type}:${latest.subject.id}`)} run=${code(latest.context?.runId ?? "unknown")} action=${code(latest.context?.actionId ?? "unknown")} model=${code(latest.context?.model ?? "unknown")} cost=${code(costDataText(latest))}`
      : "",
  ];
}

function lifecycleText(lifecycle: RunLifecycleRecord | undefined): string {
  if (!lifecycle) return "missing";
  return `merged=${lifecycle.mergedAt ? "yes" : "no"} pushed=${lifecycle.pushedAt ? "yes" : "no"} cleaned=${lifecycle.cleanedAt ? "yes" : "no"}`;
}

function requestIntentLabel(intent: RemoteRequestClassification["intent"]): string {
  const labels: Record<RemoteRequestClassification["intent"], string> = {
    implementation: "implementation",
    planning_report: "planning/report",
    review: "review",
    spec: "spec",
    evaluation: "evaluation",
    recovery: "recovery",
    ambiguity_heavy: "ambiguity-heavy",
  };
  return labels[intent];
}

function safeHandlingLabel(handling: RemoteRequestClassification["safeHandling"]): string {
  const labels: Record<RemoteRequestClassification["safeHandling"], string> = {
    implementation_plan: "implementation plan",
    report_only: "report-only",
    questions_first: "questions-first",
    recovery_plan: "recovery plan",
  };
  return labels[handling];
}

function requestClassificationLine(classification: RemoteRequestClassification): string {
  const agent = classification.preferredAgentId ? ` profile=${code(classification.preferredAgentId)}` : "";
  const mode = classification.resultMode ? ` mode=${code(classification.resultMode)}` : "";
  return `요청 분류: ${code(requestIntentLabel(classification.intent))} handling=${code(safeHandlingLabel(classification.safeHandling))}${mode}${agent}`;
}

function requestClassificationReasonLine(classification: RemoteRequestClassification): string {
  return `분류 근거: ${telegramSafeLine(classification.reasons.join("; "))}`;
}

function roleOutcomeLine(input: {
  agentId?: string;
  title: string;
  mode?: string;
  outcome: string;
  ancestry?: TaskSpec["ancestry"];
  includeContribution?: boolean;
  includeTopology?: boolean;
}): string {
  const role = agentRoleForId(input.agentId);
  const topology = input.includeTopology === false || !role ? "" : advisoryRoleTopologySummaryForRole(role);
  const topologyText = topology ? `; advisory topology: ${topology}` : "";
  return `- ${roleOutcomeSummary({
    agentId: input.agentId,
    role,
    title: input.title,
    mode: input.mode,
    outcome: input.outcome,
    ancestry: input.ancestry,
    includeContribution: input.includeContribution,
  })}${topologyText}`;
}

function taskProposalLine(task: NonNullable<OrchestratorPlanRecord["payload"]>["tasks"][number]): string {
  const dependencies = task.dependencies?.length ? ` deps=${code(String(task.dependencies.length))}` : "";
  const setup = task.setupCommands?.length ?? 0;
  return `- ${code(task.id)} ${telegramSafeLine(task.title)} agent=${code(task.targetAgent)} mode=${code(task.resultMode ?? "write")} files=${code(String(task.targetFiles.length))} setup=${code(String(setup))} verify=${code(String(task.verifyCommands.length))}${dependencies}`;
}

function planBatchDependencyLines(plan: OrchestratorPlanRecord): string[] {
  const payload = plan.payload;
  if (!payload?.batches.length) return [];

  const tasksById = new Map(payload.tasks.map((task) => [task.id, task]));
  const explicitDependencies = payload.tasks.filter((task) => task.dependencies?.length);
  return [
    "",
    "Batch/dependency 흐름:",
    ...payload.batches.map((batch, index) => {
      const labels = batch.map((id) => {
        const task = tasksById.get(id);
        return task ? `${oneLine(task.title)} (${agentRoleLabel(task.targetAgent)}, ${resultModeLabel(task.resultMode)})` : id;
      });
      return `- batch ${index + 1}: ${labels.join(", ")} - ${index === 0 ? "즉시 후보" : "이전 batch 통과 후"}`;
    }),
    ...(explicitDependencies.length
      ? explicitDependencies.map((task) => {
          const dependencies = (task.dependencies ?? []).map((id) => oneLine(tasksById.get(id)?.title ?? id)).join(", ");
          return `- ${oneLine(task.title)} 명시 의존: ${dependencies}`;
        })
      : []),
  ];
}

function actionDependencyLine(action: RemoteActionRecord, tasks: TaskSpec[]): string {
  const task = tasks.find((candidate) => candidate.id === action.taskId);
  const waitCount = action.dependsOnActionIds?.length ?? 0;
  const readiness = waitCount > 0 ? `prerequisites=${waitCount} 통과 후 자동 승인` : "즉시 승인 후보";
  return `- ${oneLine(task?.title ?? action.taskTitle)} status=${code(action.status)} (${readiness})`;
}

function planHasAdvisory(plan: OrchestratorPlanRecord): boolean {
  const payload = plan.payload;
  return Boolean(
    payload?.selectedApproach?.trim() ||
    payload?.rejectedAlternatives?.length ||
    payload?.tradeoffs?.length,
  );
}

function planAdvisoryLines(plan: OrchestratorPlanRecord): string[] {
  const payload = plan.payload;
  if (!payload || !planHasAdvisory(plan)) return [];

  const lines = [
    "",
    "선택/대안 (advisory, /go 제외):",
    payload.selectedApproach?.trim() ? `- 선택 접근: ${telegramSafeLine(payload.selectedApproach)}` : "",
    ...(payload.rejectedAlternatives ?? []).map((alternative) => {
      const tradeoffs = alternative.tradeoffs?.length
        ? ` tradeoffs=${alternative.tradeoffs.map(telegramSafeLine).join(" / ")}`
        : "";
      return `- 거절한 대안: ${telegramSafeLine(alternative.title)} - ${telegramSafeLine(alternative.reason)}${tradeoffs}`;
    }),
    ...(payload.tradeoffs?.length
      ? ["- 트레이드오프:", ...payload.tradeoffs.map((tradeoff) => `  - ${telegramSafeLine(tradeoff)}`)]
      : []),
  ];

  return lines.filter((line) => line !== "");
}

function planRecommendationTraceLines(plan: OrchestratorPlanRecord): string[] {
  const trace = plan.payload?.recommendationTrace ?? [];
  if (!trace.length) return [];
  return [
    "",
    "추천 근거 trace:",
    ...trace.map((item) => {
      const citations = item.citations.map((citation) => `${citation.kind}:${citation.id}`).join(", ");
      return `- ${telegramSafeLine(item.recommendation)}: ${telegramSafeLine(item.reason)} citations=${code(citations)}`;
    }),
  ];
}

function repoName(repoRoot: string | undefined): string {
  const normalized = oneLine(repoRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? "unknown";
}

function compactRankingLines(snapshot: CeoStatusSnapshot): string[] {
  const view = buildOperatingSurfaceView(snapshot);
  const top = snapshot.ranking?.top;
  if (!top) {
    return [
      "# ceo-ranking",
      "",
      "추천: 지금 바로 필요한 ranked action이 없습니다.",
      `Tie-breaker: ${snapshot.ranking?.tieBreaker ?? "none"}`,
    ];
  }

  return [
    "# ceo-ranking",
    "",
    `추천: ${remoteNotificationText(view.primaryAction.label)}`,
    `근거: ${remoteNotificationText(view.primaryAction.reason)}`,
    `Ranking: ${top.signal} score=${top.score}`,
    `Tie-breaker: ${snapshot.ranking?.tieBreaker ?? "none"}`,
    `텔레그램: ${code(view.primaryAction.telegramCommand ?? "/check")}`,
    "이 추천은 실행 승인이 아닙니다.",
  ];
}

function repoSummaryLine(repoRoot: string | undefined): string {
  return `대상 repo: ${code(repoName(repoRoot))}`;
}

function workTypeLine(input: { mode?: string; pass?: boolean; commit?: string }): string {
  if (input.mode === "report") return "작업 유형: 계획/보고 - 커밋 없음 정상";
  if (input.commit) return "작업 유형: 구현/수정 - 커밋 생성, merge 필요";
  if (input.pass) return "작업 유형: 구현/수정 - 커밋 없음 확인 필요";
  return "작업 유형: 구현/수정";
}

function planWorkTypeLine(input: { runLogs: WorkerRunLog[]; mergeCommands: string[]; needsRecovery: boolean }): string {
  if (input.runLogs.length > 0 && input.runLogs.every((runLog) => runLog.task.resultMode === "report")) {
    return input.needsRecovery ? "작업 유형: 계획/보고 - 복구 필요" : "작업 유형: 계획/보고 - 커밋 없음 정상";
  }
  if (input.needsRecovery) return "작업 유형: 구현/수정 - 복구 필요";
  if (input.mergeCommands.length > 0) return "작업 유형: 구현/수정 - merge 필요";
  return "작업 유형: 구현/수정";
}

function planResultOutcomeLabel(input: {
  needsRecovery: boolean;
  verificationFailed: boolean;
  reportOnly: boolean;
  synthesisOutcome?: OrchestratorSynthesisPayload["outcome"];
}): string {
  if (input.needsRecovery) {
    if (input.verificationFailed) return "검증 실패 - 복구 필요";
    if (input.synthesisOutcome === "mixed") return "부분 완료 - 복구 필요";
    if (input.synthesisOutcome === "blocked") return "차단됨 - 복구 필요";
    if (input.synthesisOutcome === "needs-BK") return "BK 확인 필요 - 복구 필요";
    return "복구 필요";
  }
  return input.reportOnly ? "보고 완료" : "구현 통과";
}

function draftNextLines(draft: TaskDraftRecord): string[] {
  if (draft.status !== "drafted") {
    return ["", "다음 액션:", `- 텔레그램: ${code("/now")}`];
  }

  const missing = [
    draft.targetFiles.length === 0 ? "targetFiles" : "",
    draft.verifyCommands.length === 0 ? "verifyCommands" : "",
  ].filter(Boolean);

  return [
    "",
    "다음 액션:",
    missing.length ? `- 텔레그램: ${code("/plan")}` : `- 텔레그램: ${code("/go")}`,
  ];
}

function remoteActionNextLines(action: RemoteActionRecord): string[] {
  if (action.status === "pending") return ["", "다음 액션:", `- 텔레그램: ${code("/go")}`];
  if (action.status === "waiting") return ["", "다음 액션:", `- 텔레그램: ${code("/now")}`];
  if (action.status === "approved" || action.status === "running") {
    return ["", "다음 액션:", `- 텔레그램: ${code("/now")}`];
  }
  if (action.status === "completed") {
    return ["", "다음 액션:", `- 텔레그램: ${code("/now")}`];
  }
  return ["", "다음 액션:", `- 텔레그램: ${code("/problems")}`];
}

function orchestrationRequestNextLines(request: OrchestrationRequestRecord): string[] {
  if (request.admission && request.admission.decision !== "accept") {
    return [
      "",
      "Admission:",
      `- decision=${code(request.admission.decision)} pressure=${code(request.admission.pressureClass)}`,
      `- reason=${telegramSafeLine(request.admission.reason)}`,
      "",
      "다음 액션:",
      `- 먼저 ${code("/check")}의 "Pressure 해결" 섹션에서 막는 원인과 명령을 확인하세요.`,
      `- host/Telegram 자체 이상이면 ${code("/problems")}도 확인하세요.`,
      `- pressure가 해소된 뒤 ${code("/plan")}으로 같은 저장 요청을 다시 계획할 수 있습니다.`,
    ];
  }
  if (request.status === "pending_plan" && request.recoveryOfPlanId) {
    const project = recordProjectId(request);
    return [
      "",
      "다음 액션:",
      `- 상태 확인: ${code("/now")}`,
      project ? `- 복구 요청 정리: ${code(`/drop recovery project:${project}`)}` : "",
    ];
  }
  if (request.status === "pending_plan") {
    const project = recordProjectId(request);
    return [
      "",
      "다음 액션:",
      `- 텔레그램: ${code(project ? `/plan ${project}` : "/plan <project>")}`,
      `- 요청 취소: ${code(project ? `/cancel project:${project}` : "/cancel")}`,
    ];
  }
  return ["", "다음 액션:", `- 텔레그램: ${code("/now")}`];
}

function orchestrationRequestSummary(request: OrchestrationRequestRecord): string {
  const text = telegramSafeLine(request.text);
  if (text.startsWith("복구 계획 요청입니다.")) return "실패 계획 복구 요청";
  if (text.startsWith("계획 수정 요청입니다.")) return "계획 수정 요청";
  return text;
}

function orchestratorPlanBlockerLines(blocker: OrchestratorPlanBlocker): string[] {
  return [
    "",
    "진행 차단:",
    ...blocker.violations.map((violation) => `- ${telegramSafeLine(violation)}`),
  ];
}

function blockedPlanNextLines(blocker: OrchestratorPlanBlocker): string[] {
  return [
    "",
    "다음 액션:",
    `- 계획 수정: ${code(blocker.nextAction.command)}`,
  ];
}

function orchestratorPlanNextLines(plan: OrchestratorPlanRecord, blocker?: OrchestratorPlanBlocker): string[] {
  if (blocker) return blockedPlanNextLines(blocker);
  if (plan.status === "questions") {
    return [
      "",
      "다음 액션:",
      `- 계획 다시 보기: ${code("/plan_current")}`,
      `- 답변/수정 요청: ${code("/revise <피드백>")}`,
      `- 계획 취소: ${code("/cancel")}`,
    ];
  }
  if (plan.status === "planned") {
    return [
      "",
      "다음 액션:",
      `- 계획 다시 보기: ${code("/plan_current")}`,
      `- 계획 승인 및 worker 실행 큐 등록: ${code("/go")}`,
      `- 계획 수정: ${code("/revise <피드백>")}`,
      `- 계획 취소: ${code("/cancel")}`,
    ];
  }
  if (plan.status === "materialized") return ["", "다음 액션:", `- 텔레그램: ${code("/now")}`];
  return ["", "다음 액션:", `- 텔레그램: ${code("/now")}`];
}

function blockerClarificationNowReport(decision: DecisionItem): string {
  return [
    "# now",
    "",
    "BK 확인이 필요한 blocker clarification이 있습니다.",
    `제목: ${telegramSafeLine(decision.title)}`,
    `질문: ${telegramSafeLine(decision.prompt)}`,
    decision.options.length ? `선택지: ${decision.options.map(telegramSafeLine).join(" / ")}` : "",
    decision.risk ? `리스크: ${telegramSafeLine(decision.risk)}` : "",
    "",
    "다음 액션:",
    `- 답변: ${code("/answer <답변>")}`,
    `- 수정 요청: ${code("/revise <피드백>")}`,
    `- 취소: ${code("/cancel")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function recoveryPlanVerdictLine(request: OrchestrationRequestRecord, plan: OrchestratorPlanRecord): string | undefined {
  if (!request.recoveryOfPlanId) return undefined;
  const target = oneLine(plan.payload?.summary ?? request.recoveryOfPlanId);
  if (plan.status === "questions") return `복구 판단: 원 문제는 BK 확인 필요 - ${target}`;
  if (plan.status === "planned") return `복구 판단: 원 문제는 BK 승인 필요 - ${target}`;
  if (plan.status === "failed") return `복구 판단: 원 문제 미해결 - 복구 계획 생성 실패`;
  return undefined;
}

function actionNeedsRecovery(action: RemoteActionRecord): boolean {
  return action.status === "failed" || action.result?.pass === false;
}

function actionVerificationFailed(action: RemoteActionRecord, runLog: WorkerRunLog | undefined): boolean {
  if (runLog?.result.evaluation?.verifyResults.some((result) => result.exitCode !== 0)) return true;
  const text = `${action.result?.outcome ?? ""} ${action.result?.failure ?? ""}`.toLowerCase();
  return text.includes("verify") || text.includes("typecheck") || text.includes("test failed") || text.includes("검증");
}

function latestRecoverablePlan(input: {
  actions: RemoteActionRecord[];
  orchestratorPlans?: OrchestratorPlanRecord[];
  minResultReportedAt?: number;
}): { plan: OrchestratorPlanRecord; actions: RemoteActionRecord[]; failedActions: RemoteActionRecord[] } | undefined {
  const byId = new Map(input.actions.map((action) => [action.id, action]));

  for (const plan of input.orchestratorPlans?.slice().reverse() ?? []) {
    const actionIds = plan.actionIds ?? [];
    if (plan.status !== "materialized" || !plan.resultReportedAt || actionIds.length === 0) continue;
    if (input.minResultReportedAt && timestamp(plan.resultReportedAt) < input.minResultReportedAt) continue;

    const actions = actionIds.map((id) => byId.get(id));
    if (actions.some((action) => !action)) continue;
    if (actions.some((action) => action?.status !== "completed" && action?.status !== "failed")) continue;

    const planActions = actions.filter((action): action is RemoteActionRecord => action !== undefined);
    const failedActions = planActions.filter(actionNeedsRecovery);
    const synthesisNeedsRecovery = plan.synthesis ? plan.synthesis.outcome !== "pass" : false;
    if (failedActions.length > 0 || synthesisNeedsRecovery) return { plan, actions: planActions, failedActions };
  }

  return undefined;
}

function clipText(text: string, maxLength = 3500): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}\n\n...[truncated]`;
}

function stripHarnessResult(text: string): string {
  const marker = text.lastIndexOf("HARNESS_RESULT:");
  if (marker === -1) return text.trim();
  const before = text.slice(0, marker).trim();
  return before || text.replace(/^HARNESS_RESULT:.*$/gm, "").trim();
}

function extractAgentMessages(output: string): string[] {
  const messages: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        messages.push(event.item.text);
      }
    } catch {
      // Non-JSON lines are normal in command output.
    }
  }
  return messages;
}

function workerFinalMessage(runLog: WorkerRunLog | undefined): string {
  if (!runLog) return "worker run log를 읽지 못했습니다.";

  const command = runLog.result.command;
  const output = [command?.stdout ?? "", command?.stderr ?? ""].filter(Boolean).join("\n");
  const agentMessage = extractAgentMessages(output).map(stripHarnessResult).filter(Boolean).at(-1);
  if (agentMessage) return telegramSafeClipText(agentMessage);

  const harnessNote = runLog.result.evaluation?.harness?.note;
  if (harnessNote) return telegramSafeClipText(harnessNote);

  const fallback = stripHarnessResult(output);
  return fallback ? telegramSafeClipText(fallback) : "worker 최종 메시지를 찾지 못했습니다.";
}

function changedFileLines(runLog: WorkerRunLog | undefined): string[] {
  const files = runLog?.result.evaluation?.changedFiles ?? runLog?.result.commit?.files ?? [];
  return files.length ? files.map((file) => `- ${code(file)}`) : ["- 없음"];
}

function verificationLines(runLog: WorkerRunLog | undefined): string[] {
  const evaluation = runLog?.result.evaluation;
  if (!evaluation) return ["- worker 검증 결과 없음"];

  const lines = [
    evaluation.harness ? `- Worker 보고: ${code(evaluation.harness.status)} - ${telegramSafeLine(evaluation.harness.note)}` : "",
    evaluation.parseError ? `- HARNESS_RESULT 파싱 실패: ${telegramSafeLine(evaluation.parseError)}` : "",
    evaluation.verifyOverrideReason ? `- 검증 보정: ${telegramSafeLine(evaluation.verifyOverrideReason)}` : "",
    ...evaluation.verifyResults.map((result) =>
      `- ${result.exitCode === 0 ? "통과" : "실패"} exit ${result.exitCode}: ${code(result.command)}`,
    ),
  ].filter(Boolean);

  return lines.length ? lines : ["- 검증 명령 없음"];
}

export interface RemoteActionArtifactPreview {
  file: string;
  text: string;
}

function artifactPreviewLines(runLog: WorkerRunLog | undefined, previews: RemoteActionArtifactPreview[] | undefined): string[] {
  if (runLog?.task.resultMode !== "report") return [];
  return [
    "",
    "산출물 미리보기:",
    ...(previews?.length
      ? previews.flatMap((preview) => [`파일: ${code(preview.file)}`, clipText(preview.text, 2500)])
      : ["- 없음"]),
  ];
}

function remoteActionResultNextLines(action: RemoteActionRecord, runLog: WorkerRunLog | undefined): string[] {
  const lines = ["", "다음 액션:"];
  if (action.status === "failed") {
    if (action.orchestratorPlanId) {
      lines.push("- 오케스트레이터 계획 결과 보고가 끝난 뒤 복구 가능 여부를 판단합니다.");
      lines.push(`- 텔레그램: ${code("/now")}`);
    } else {
      lines.push(`- 문제 확인: ${code("/problems")}`);
    }
  } else {
    lines.push(`- 텔레그램: ${code("/now")}`);
  }

  if (runLog?.result.pass && runLog.result.commit?.commitHash && action.result?.runLogPath) {
    lines.push("", "로컬 merge 후보:");
    lines.push(code(`bun run samantha merge:check --run-log=${action.result.runLogPath} --repo-root=${runLog.input.repoRoot}`));
  }

  return lines;
}

function proposalNextLines(proposal: ProposalRecord): string[] {
  if (proposal.status === "pending_review") {
    return [
      "",
      "다음 액션:",
      `- 새 흐름으로 다시 요청: ${code("/work <요청>")}`,
      `- 상태 기준으로 다시 판단: ${code("/now")}`,
    ];
  }
  if (proposal.status === "accepted") {
    return ["", "다음 액션:", `- 새 흐름으로 다시 요청: ${code("/work <요청>")}`];
  }
  return ["", "다음 액션:", `- 텔레그램: ${code("/now")}`];
}

function latestReplyFailure(snapshot: OpsSnapshot): string {
  const failure = snapshot.telegram.replyState?.failures?.at(-1);
  if (!failure) return "none";
  return `${failure.file} attempts=${failure.attempts} error=${redactDiagnosticValue(failure.lastError)}`;
}

function redactDiagnosticValue(value: string): string {
  return value
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(Bearer|token|secret|password|api[_-]?key)=\S+/gi, "$1=[redacted]")
    .replace(/\b(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|TELEGRAM_REPLY_CHAT_ID)=\S+/g, "$1=[redacted]");
}

function nextActionLinesForRun(run: RunSummary): string[] {
  if (run.pass && run.commit) {
    return [
      "로컬 다음 액션:",
      code(`bun run samantha merge:check --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
      code(`bun run samantha merge:apply --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
      "merge/push 이후 정리:",
      code(`bun run samantha worktree:cleanup --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
    ];
  }

  if (run.outcome === "blocked") {
    return [
      "로컬 다음 액션:",
      "기존 worker worktree를 수정 또는 검증한 뒤, 변경 파일이 적절하면 finalize 하세요.",
      code(`bun run samantha tasks:finalize-worktree ${run.taskId} --repo-root=${run.repoRoot} --worktree=${run.worktreePath}`),
    ];
  }

  if (!run.pass) {
    return [
      "로컬 다음 액션:",
      "run log를 먼저 확인하고 원인을 이해한 뒤에만 retry 하세요.",
      code(`bun run samantha runs:show ${run.runId}`),
      code(`bun run samantha tasks:retry ${run.taskId}`),
    ];
  }

  return ["로컬 다음 액션: 없음"];
}

function nowLinesForPassedRun(run: RunSummary, lifecycle: RunLifecycleRecord | undefined): string[] {
  if (!run.pass || !run.commit) return [];

  if (lifecycle?.mergedAt && lifecycle.pushedAt && lifecycle.cleanedAt) {
    return [
      "# now",
      "",
      "최근 성공 run은 merge/push/cleanup까지 완료됐습니다.",
      `런: ${code(run.runId)}`,
      `lifecycle: ${lifecycleText(lifecycle)}`,
      "",
      "다음 액션:",
      `- 텔레그램: ${code("/check")}`,
    ];
  }

  if (lifecycle?.mergedAt && lifecycle.pushedAt) {
    return [
      "# now",
      "",
      "최근 성공 run은 push 완료 후 cleanup 승인이 필요합니다.",
      `런: ${code(run.runId)}`,
      "",
      "다음 액션:",
      `- 텔레그램: ${code("/go")}`,
      "",
      "로컬 fallback:",
      code(`bun run samantha worktree:cleanup --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
    ];
  }

  if (lifecycle?.mergedAt) {
    return [
      "# now",
      "",
      "최근 성공 run은 merge 완료 후 push 승인이 필요합니다.",
      `런: ${code(run.runId)}`,
      "",
      "다음 액션:",
      `- 텔레그램: ${code("/go")}`,
      "",
      "로컬 fallback:",
      code(`bun run samantha merge:push --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
    ];
  }

  return [
    "# now",
    "",
    "최근 성공 run의 merge 적용 승인이 필요합니다.",
    `런: ${code(run.runId)}`,
    `태스크: ${code(run.taskId)} - ${oneLine(run.taskTitle)}`,
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/go")}`,
    "",
    "로컬 fallback:",
    code(`bun run samantha merge:check --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
  ];
}

function latestRunNeedingIntegration(runs: RunSummary[], lifecycles: RunLifecycleRecord[] = []): RunSummary | undefined {
  const lifecyclesByRunId = new Map(lifecycles.map((record) => [record.runId, record]));
  const latestLifecycleUpdate = Math.max(0, ...lifecycles.map((record) => Date.parse(record.updatedAt) || 0));
  return runs
    .slice()
    .reverse()
    .find((run) => {
      const lifecycle = lifecyclesByRunId.get(run.runId);
      if (!run.pass || !run.commit) return false;
      if (lifecycle?.mergedAt && lifecycle.pushedAt && lifecycle.cleanedAt) return false;
      if (lifecycle) return true;
      return latestLifecycleUpdate === 0 || (Date.parse(run.finishedAt) || 0) > latestLifecycleUpdate;
    });
}

export function remoteHelpReport(mode: "basic" | "advanced" = "basic"): string {
  if (mode === "advanced") {
    return [
      "# remote:help",
      "",
      "고급 명령 목록은 Telegram에서 제거했습니다.",
      "",
      "다음 액션:",
      `- 텔레그램: ${code("/help")}`,
    ].join("\n");
  }

  return [
    "# remote:help",
    "",
    "기본 흐름:",
    "",
    "- `/work <요청>`: 새 작업 요청 저장",
    "- `/plan`: Orchestrator Agent가 실행 전 계획 작성",
    "- `/plan_current`: 현재 계획 다시 보기",
    "- `/approve`: 현재 단일 계획 승인 결정만 승인",
    "- `/answer <답변>`: 현재 단일 blocker clarification에 답변 기록",
    "- `/go`: 계획 승인, worker 실행 큐 등록, 또는 최신 성공 run 통합 gate 진행",
    "- `/revise <피드백>`: 현재 계획을 수정 요청",
    "- `/cancel`: 승인 전 계획/요청 취소",
    "- `/recover`: 실패한 계획 결과로 복구 계획 요청 생성",
    "- `/drop stale project:<project>`: 같은 프로젝트의 오래된 pending 요청 정리",
    "- `/now`: 지금 보낼 다음 명령 확인",
    "- `/check`: 짧은 상태 확인",
    "- `/problems`: 이상 징후 진단",
    "",
    "일반 실행:",
    "`/work <요청>` -> `/plan` -> `/go` -> `/now`",
    "",
    "자동 분류가 틀렸을 때만 `/plan <project_id> <scope_id>`로 보정하세요.",
    "run, task, action, proposal, draft ID를 직접 입력하는 명령은 Telegram에서 제거했습니다.",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ].join("\n");
}

export function remoteDeprecatedCommandReport(input: { command: string; replacement: string }): string {
  return [
    "# remote:deprecated",
    "",
    "사용한 Telegram 명령은 제거됐습니다.",
    "",
    "현재 Telegram은 오케스트레이터 워크플로우만 직접 다룹니다.",
    "run, task, action, proposal, draft ID를 직접 입력하는 수동 흐름은 로컬 점검용으로만 남깁니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code(input.replacement)}`,
    `- 상태 기준으로 다시 판단: ${code("/now")}`,
  ].join("\n");
}

export function remoteDecisionApprovedReport(): string {
  return [
    "# approve",
    "",
    "현재 계획 승인 결정을 승인했습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/go")}`,
    "",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ].join("\n");
}

export function remoteDecisionRejectedReport(): string {
  return [
    "# reject",
    "",
    "현재 계획 승인 결정을 거절했습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
    "",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ].join("\n");
}

export function remoteApprovalRedirectReport(input: { reason: string }): string {
  return [
    "# approve",
    "",
    remoteNotificationText(input.reason),
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
    "",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ].join("\n");
}

export function remoteProjectAmbiguityReport(input: {
  command: string;
  reason: string;
  example?: string;
  examples?: string[];
}): string {
  const examples = [...new Set(input.examples ?? [])].filter(Boolean);
  return [
    `# ${input.command.replace(/^\//, "")}`,
    "",
    remoteNotificationText(input.reason),
    "",
    "state는 변경하지 않았고 실행 가능한 work도 만들지 않았습니다.",
    "",
    "다음 액션:",
    ...examples.map((example) => `- 프로젝트 지정: ${code(example)}`),
    examples.length === 0 && input.example ? `- 프로젝트 지정: ${code(input.example)}` : "",
    examples.length === 0 && !input.example ? "- 프로젝트를 지정해서 다시 요청하세요." : "",
    `- 텔레그램: ${code("/now")}`,
    "",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ].filter(Boolean).join("\n");
}

export function remoteDuplicatePendingRequestReport(input: { projectId: string }): string {
  return [
    "# work",
    "",
    "이미 같은 pending 요청이 있습니다. 새 요청은 만들지 않았습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code(`/plan ${input.projectId}`)}`,
  ].join("\n");
}

export function remoteDuplicateRecoveryPendingRequestReport(input: { projectId: string }): string {
  return [
    "# recover",
    "",
    "이미 같은 복구 pending 요청이 있습니다. 새 요청은 만들지 않았습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
    `- 복구 요청 정리: ${code(`/drop recovery project:${input.projectId}`)}`,
  ].join("\n");
}

export function remoteDropPendingRequestsReport(input: {
  mode: "stale" | "all" | "recovery";
  projectId: string;
  discardedCount: number;
  keptCount: number;
}): string {
  return [
    "# drop",
    "",
    `프로젝트: ${code(input.projectId)}`,
    `정리 대상: ${code(input.mode)}`,
    `discarded 처리: ${input.discardedCount}개`,
    input.keptCount ? `남은 pending_plan: ${input.keptCount}개` : "남은 pending_plan: 0개",
    "",
    "plan/task/action은 변경하지 않았습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
  ].join("\n");
}

export function remoteAnswerRecordedReport(): string {
  return [
    "# answer",
    "",
    "현재 blocker clarification 답변을 기록했습니다.",
    "",
    "현재 계획은 변경하지 않았고 task/action도 만들지 않았습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
    `- 승인된 안전 계획 진행: ${code("/go")}`,
    "",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ].join("\n");
}

export function remoteAnswerRedirectReport(input: { reason: string }): string {
  return [
    "# answer",
    "",
    remoteNotificationText(input.reason),
    "",
    "답변은 기록하지 않았고 state는 변경하지 않았습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
    "",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ].join("\n");
}

export function runsListReport(runs: RunSummary[], limit = 10): string {
  const lines = recent(runs, limit).map(runLine);
  return ["# runs:list", "", `Total runs: ${runs.length}`, "", ...(lines.length ? lines : ["No runs recorded."])].join("\n");
}

export function runShowReport(runId: string, run: RunSummary | undefined): string {
  if (!run) {
    return ["# runs:show", "", `Run not found: ${code(runId)}`].join("\n");
  }

  return [
    "# runs:show",
    "",
    `Run: ${code(run.runId)}`,
    `Outcome: ${code(run.outcome)}`,
    `Pass: ${run.pass ? "yes" : "no"}`,
    `Task: ${code(run.taskId)} - ${oneLine(run.taskTitle)}`,
    `Agent: ${code(run.agentId)}`,
    `Started: ${code(run.startedAt)}`,
    `Finished: ${code(run.finishedAt)}`,
    run.commit ? `Commit: ${code(run.commit)}` : "Commit: none",
    run.failureReason ? `Failure: ${code(run.failureReason)}` : "",
    `Log: ${code(run.logPath)}`,
    "",
    ...nextActionLinesForRun(run),
  ]
    .filter(Boolean)
    .join("\n");
}

export function nextActionReport(input: { runs: RunSummary[]; tasks: TaskSpec[]; lifecycles?: RunLifecycleRecord[] }): string {
  const activeTasks = input.tasks.filter((task) => task.status !== "archived");
  const archivedTaskIds = new Set(input.tasks.filter((task) => task.status === "archived").map((task) => task.id));
  const pending = activeTasks.find((task) => task.status === "pending");
  if (pending) {
    return [
      "# next-action",
      "",
      "Pending task found.",
      `Task: ${code(pending.id)}`,
      "",
      "Suggested local next action:",
      code(`bun run samantha tasks:dispatch ${pending.id} --repo-root=<repo>`),
      code(`bun run samantha tasks:dispatch ${pending.id} --repo-root=<repo> --execute`),
    ].join("\n");
  }

  const latest = input.runs.at(-1);
  if (latest) {
    if (!latest.pass && archivedTaskIds.has(latest.taskId)) {
      return [
        "# next-action",
        "",
        `Latest run: ${code(latest.runId)}`,
        "",
        "No immediate action.",
        "The failed task is archived, so this stale failure will not be retried.",
      ].join("\n");
    }
    if (latest.pass && latest.commit) {
      const lifecycle = input.lifecycles?.find((record) => record.runId === latest.runId);
      if (lifecycle?.mergedAt && lifecycle.pushedAt && lifecycle.cleanedAt) {
        return [
          "# next-action",
          "",
          `Latest run: ${code(latest.runId)}`,
          "",
          "No immediate action.",
          `Lifecycle: merged=${lifecycle.mergedAt ? "yes" : "no"} pushed=${lifecycle.pushedAt ? "yes" : "no"} cleaned=yes`,
        ].join("\n");
      }
      if (lifecycle?.mergedAt && lifecycle.pushedAt) {
        return [
          "# next-action",
          "",
          `Latest run: ${code(latest.runId)}`,
          "",
          "Suggested local next action:",
          code(`bun run samantha worktree:cleanup --run-log=${latest.logPath} --repo-root=${latest.repoRoot}`),
        ].join("\n");
      }
      if (lifecycle?.mergedAt) {
        return [
          "# next-action",
          "",
          `Latest run: ${code(latest.runId)}`,
          "",
          "Suggested local next action:",
          code(`bun run samantha merge:push --run-log=${latest.logPath} --repo-root=${latest.repoRoot}`),
        ].join("\n");
      }
      return [
        "# next-action",
        "",
        `Latest run: ${code(latest.runId)}`,
        "",
        "Suggested local next action:",
        code(`bun run samantha merge:check --run-log=${latest.logPath} --repo-root=${latest.repoRoot}`),
      ].join("\n");
    }
    return ["# next-action", "", `Latest run: ${code(latest.runId)}`, "", ...nextActionLinesForRun(latest)].join("\n");
  }

  return ["# next-action", "", "No tasks or runs recorded.", "", "Suggested local next action: create a proposal or task draft."].join("\n");
}

export function nowReport(input: {
  runs: RunSummary[];
  tasks: TaskSpec[];
  actions: RemoteActionRecord[];
  decisions?: DecisionItem[];
  proposals?: ProposalRecord[];
  drafts?: TaskDraftRecord[];
  orchestrationRequests?: OrchestrationRequestRecord[];
  orchestratorPlans?: OrchestratorPlanRecord[];
  orchestratorPlanBlockers?: OrchestratorPlanBlocker[];
  ops?: OpsSnapshot;
  lifecycles?: RunLifecycleRecord[];
  reports?: CeoReportRecord[];
  governanceEvents?: GovernanceEventRecord[];
  budgetObservations?: CostBudgetAuditRecord[];
  budgetPolicies?: BudgetPolicyRecord[];
}): string {
  const rankingSnapshot = buildCeoStatusSnapshot({
    runs: input.runs,
    tasks: input.tasks,
    taskDrafts: input.drafts,
    actions: input.actions,
    decisions: input.decisions,
    orchestrationRequests: input.orchestrationRequests,
    orchestratorPlans: input.orchestratorPlans,
    orchestratorPlanBlockers: input.orchestratorPlanBlockers,
    ops: input.ops,
    lifecycles: input.lifecycles,
    reports: input.reports,
    governanceEvents: input.governanceEvents,
    budgetObservations: input.budgetObservations,
    budgetPolicies: input.budgetPolicies,
  });
  const rankingLines = compactRankingLines(rankingSnapshot);
  const currentPlans = (input.orchestratorPlans ?? []).filter((plan) => plan.status === "planned" || plan.status === "questions");
  if (currentPlans.length > 1) return [...rankingLines, "", currentPlanAmbiguityReport({ plans: currentPlans })].join("\n");
  const currentRequests = (input.orchestrationRequests ?? []).filter((request) => request.status === "pending_plan");
  if (currentRequests.length > 1) return [...rankingLines, "", currentRequestAmbiguityReport({ requests: currentRequests })].join("\n");

  const blockerClarification = latestCurrentPendingBlockerClarification(
    input.decisions ?? [],
    input.orchestratorPlans ?? [],
  );
  if (blockerClarification) return [...rankingLines, "", blockerClarificationNowReport(blockerClarification)].join("\n");

  const latestByStatus = (status: RemoteActionRecord["status"]) =>
    input.actions.slice().reverse().find((action) => action.status === status);
  const running = latestByStatus("running");
  if (running) {
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      "worker가 실행 중입니다.",
      `액션: ${code(running.id)}`,
      `태스크: ${code(running.taskId)} - ${oneLine(running.taskTitle)}`,
      ...remoteActionNextLines(running),
    ].join("\n");
  }

  const approved = latestByStatus("approved");
  if (approved) {
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      "액션이 승인되었고 runner 실행을 기다리는 중입니다.",
      `액션: ${code(approved.id)}`,
      `태스크: ${code(approved.taskId)} - ${oneLine(approved.taskTitle)}`,
      ...remoteActionNextLines(approved),
    ].join("\n");
  }

  const pendingAction = latestByStatus("pending");
  if (pendingAction) {
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      "승인 대기 중인 수동 action이 있지만 Telegram `/go`로는 개별 action을 승인하지 않습니다.",
      `액션: ${code(pendingAction.id)}`,
      `태스크: ${code(pendingAction.taskId)} - ${oneLine(pendingAction.taskTitle)}`,
      "",
      "다음 액션:",
      `- 텔레그램: ${code("/problems")}`,
    ].join("\n");
  }

  const waitingAction = latestByStatus("waiting");
  if (waitingAction) {
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      "선행 action 완료를 기다리는 action이 있습니다.",
      `액션: ${code(waitingAction.id)}`,
      `태스크: ${code(waitingAction.taskId)} - ${oneLine(waitingAction.taskTitle)}`,
      waitingAction.dependsOnActionIds?.length ? `의존 action: ${waitingAction.dependsOnActionIds.map(code).join(", ")}` : "",
      ...remoteActionNextLines(waitingAction),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const latestPlan = input.orchestratorPlans
    ?.slice()
    .reverse()
    .find((plan) => plan.status === "planned" || plan.status === "questions");
  if (latestPlan) {
    const blocker = blockerForPlan(input.orchestratorPlanBlockers, latestPlan.id) ?? payloadBlockerForPlan(latestPlan);
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      latestPlan.status === "questions"
        ? "오케스트레이터 계획에 확인 질문이 남아 있습니다."
        : "오케스트레이터 계획이 생성되어 검토를 기다리고 있습니다.",
      `계획: ${code(latestPlan.id)}`,
      `요청: ${code(latestPlan.requestId)}`,
      latestPlan.payload?.summary ? `요약: ${telegramSafeLine(latestPlan.payload.summary)}` : "",
      ...(blocker ? orchestratorPlanBlockerLines(blocker) : []),
      ...orchestratorPlanNextLines(latestPlan, blocker),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const pendingOrchestrationRequest = input.orchestrationRequests
    ?.slice()
    .reverse()
    .find((request) => request.status === "pending_plan");
  if (pendingOrchestrationRequest) {
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      "작업 요청이 오케스트레이터 계획 생성을 기다리고 있습니다.",
      `요청: ${code(pendingOrchestrationRequest.id)}`,
      `내용: ${orchestrationRequestSummary(pendingOrchestrationRequest)}`,
      ...orchestrationRequestNextLines(pendingOrchestrationRequest),
    ].join("\n");
  }

  const primaryWorkflowTimestamp = latestPrimaryWorkflowTimestamp(input);
  const activeTasks = input.tasks.filter((task) => task.status !== "archived");
  const archivedTaskIds = new Set(input.tasks.filter((task) => task.status === "archived").map((task) => task.id));
  const pendingIntegrationRun = latestRunNeedingIntegration(input.runs, input.lifecycles);
  if (pendingIntegrationRun) {
    return [
      ...rankingLines,
      "",
      ...nowLinesForPassedRun(
      pendingIntegrationRun,
      input.lifecycles?.find((record) => record.runId === pendingIntegrationRun.runId),
      ),
    ].join("\n");
  }

  const recoverable = latestRecoverablePlan({
    actions: input.actions,
    orchestratorPlans: input.orchestratorPlans,
    minResultReportedAt: primaryWorkflowTimestamp,
  });
  if (recoverable) {
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      "실패한 오케스트레이터 계획 결과가 있습니다.",
      `실패 작업: ${recoverable.failedActions.length}/${recoverable.actions.length}`,
      recoverable.plan.synthesis?.summary ? `종합: ${telegramSafeLine(recoverable.plan.synthesis.summary)}` : "",
      "",
      "다음 액션:",
      `- 텔레그램: ${code("/recover")}`,
    ].join("\n");
  }

  if (input.ops?.failures.length || input.ops?.warnings.length) {
    const issue = input.ops.failures[0] ?? input.ops.warnings[0] ?? "operation needs attention";
    return [...rankingLines, "", "# now", "", "운영 상태 확인이 필요합니다.", oneLine(issue), "", "다음 액션:", `- 텔레그램: ${code("/problems")}`].join("\n");
  }

  const pendingTask = activeTasks.find((task) => task.status === "pending");
  if (pendingTask) {
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      "수동 pending task가 있지만 Telegram `/go`는 task를 직접 실행 큐에 등록하지 않습니다.",
      `태스크: ${code(pendingTask.id)} - ${oneLine(pendingTask.title)}`,
      "",
      "다음 액션:",
      `- 텔레그램: ${code("/problems")}`,
    ].join("\n");
  }

  const latest = input.runs.at(-1);
  if (latest?.pass && latest.commit) {
    return [
      ...rankingLines,
      "",
      ...nowLinesForPassedRun(
      latest,
      input.lifecycles?.find((record) => record.runId === latest.runId),
      ),
    ].join("\n");
  }

  if (latest && !latest.pass && timestamp(latest.finishedAt) >= primaryWorkflowTimestamp && !archivedTaskIds.has(latest.taskId)) {
    return [
      ...rankingLines,
      "",
      "# now",
      "",
      "가장 최근 run이 통과하지 못했습니다.",
      `런: ${code(latest.runId)}`,
      latest.failureReason ? `실패 이유: ${oneLine(latest.failureReason)}` : "",
      "",
      "다음 액션:",
      `- 텔레그램: ${code("/problems")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [...rankingLines, "", "# now", "", "지금 바로 필요한 원격 액션은 없습니다.", "", "다음 액션:", `- 텔레그램: ${code("/check")}`].join("\n");
}

export function failuresReport(runs: RunSummary[], limit = 10): string {
  const failures = runs.filter((run) => !run.pass);
  const lines = recent(failures, limit).map(runLine);
  return [
    "# runs:failures",
    "",
    `Total non-passing runs: ${failures.length}`,
    "",
    "Recent:",
    ...(lines.length ? lines : ["No non-passing runs recorded."]),
  ].join("\n");
}

export function tasksListReport(tasks: TaskSpec[], limit = 20): string {
  const lines = recent(tasks, limit).map(taskLine);
  return ["# tasks:list", "", `Total tasks: ${tasks.length}`, "", ...(lines.length ? lines : ["No tasks recorded."])].join("\n");
}

export function taskShowReport(taskId: string, task: TaskSpec | undefined): string {
  if (!task) {
    return ["# tasks:show", "", `Task not found: ${code(taskId)}`].join("\n");
  }

  return [
    "# tasks:show",
    "",
    `Task: ${code(task.id)}`,
    `Title: ${oneLine(task.title)}`,
    `Status: ${code(task.status)}`,
    `Agent: ${code(task.targetAgent)}`,
    task.resultMode ? `Result mode: ${code(task.resultMode)}` : "",
    task.archivedAt ? `Archived: ${code(task.archivedAt)}` : "",
    task.archiveReason ? `Archive reason: ${oneLine(task.archiveReason)}` : "",
    `Target files: ${task.targetFiles.map(code).join(", ") || "none"}`,
    `Setup commands: ${(task.setupCommands ?? []).map(code).join(", ") || "none"}`,
    `Verify commands: ${task.verifyCommands.map(code).join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function ceoNotificationReport(snapshot: CeoStatusSnapshot): string {
  const view = buildOperatingSurfaceView(snapshot);
  const decision = snapshot.needsDecision[0];
  const top = snapshot.ranking?.top;
  const nextCommand = view.primaryAction.telegramCommand ?? "/check";
  const blocker = snapshot.blocked[0];
  const recoveryBlockerWithoutDecision = Boolean(blocker && !decision);
  const primaryCommand = recoveryBlockerWithoutDecision ? "/check" : nextCommand;
  const detailCommand = recoveryBlockerWithoutDecision && nextCommand !== "/check" ? nextCommand : undefined;
  const canApproveDecision = nextCommand === "/approve";
  const isBlockerClarification = decision?.decisionKind === "blocker_clarification";
  const risks = snapshot.risks.slice(0, 3).map(remoteNotificationText);
  const lines = [
    "# ceo-notify",
    "",
    `상태: ${snapshot.overall}`,
    `핵심: ${remoteNotificationText(view.headline)}`,
    `요약: ${view.summary}`,
    top ? `추천: ${remoteActionLabelForNotification(view.primaryAction.label, blocker)}` : "",
    top ? `추천 근거: ${remoteNotificationText(view.primaryAction.reason)}` : "",
    top ? `Ranking: ${top.signal} score=${top.score}` : "",
    decision ? `결정 필요: ${remoteNotificationText(decision.title)}` : "",
    decision ? `이유: ${remoteNotificationText(decision.reason)}` : "",
    "",
    "다음 액션:",
    `- 텔레그램: ${code(primaryCommand)}`,
    detailCommand ? `- 상세 진단: ${code(detailCommand)}` : "",
    decision && canApproveDecision ? `- 수정 필요 시: ${code("/revise <피드백>")}` : "",
    decision && isBlockerClarification ? `- 계획 변경 필요 시: ${code("/revise <피드백>")}` : "",
    decision ? `- 취소: ${code("/cancel")}` : "",
    blocker ? `- 현재 블로커: ${remoteStatusItemLabel(blocker)}` : "",
    blocker?.detail ? `- 블로커 이유: ${remoteNotificationText(blocker.detail)}` : "",
    snapshot.blocked.length > 1 ? `- 추가 블로커: ${snapshot.blocked.length - 1}건` : "",
    snapshot.historicalFailures.length ? `- 히스토리 실패: ${snapshot.historicalFailures.length}건은 CLI 또는 dashboard에서 확인` : "",
    "",
    "리스크:",
    ...(risks.length ? risks.map((risk) => `- ${risk}`) : ["- 없음"]),
    "",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ];

  return lines.filter((line) => line !== "").join("\n");
}

export function proposalAddedReport(proposal: ProposalRecord): string {
  return [
    "# proposals:add",
    "",
    `Saved proposal: ${code(proposal.id)}`,
    `Status: ${code(proposal.status)}`,
    "",
    "Text:",
    oneLine(proposal.text),
    "",
    "No worker was dispatched. Review this proposal locally before creating a task.",
    ...proposalNextLines(proposal),
  ].join("\n");
}

export function proposalsListReport(proposals: ProposalRecord[], limit = 10): string {
  const lines = recent(proposals, limit).map(proposalLine);
  return [
    "# proposals:list",
    "",
    `Total proposals: ${proposals.length}`,
    "",
    ...(lines.length ? lines : ["No proposals recorded."]),
  ].join("\n");
}

export function proposalShowReport(proposalId: string, proposal: ProposalRecord | undefined): string {
  if (!proposal) {
    return ["# proposals:show", "", `Proposal not found: ${code(proposalId)}`].join("\n");
  }

  return [
    "# proposals:show",
    "",
    `Proposal: ${code(proposal.id)}`,
    `Status: ${code(proposal.status)}`,
    `Source: ${code(proposal.source)}`,
    proposal.senderId ? `Sender: ${code(proposal.senderId)}` : "",
    `Created: ${code(proposal.createdAt)}`,
    proposal.reviewedAt ? `Reviewed: ${code(proposal.reviewedAt)}` : "",
    proposal.reviewNote ? `Review note: ${oneLine(proposal.reviewNote)}` : "",
    "",
    "Text:",
    proposal.text.trim(),
    ...proposalNextLines(proposal),
  ]
    .filter(Boolean)
    .join("\n");
}

export function proposalReviewedReport(action: "accept" | "reject", proposal: ProposalRecord): string {
  return [
    `# proposals:${action}`,
    "",
    `Proposal: ${code(proposal.id)}`,
    `Status: ${code(proposal.status)}`,
    proposal.reviewedAt ? `Reviewed: ${code(proposal.reviewedAt)}` : "",
    proposal.reviewNote ? `Note: ${oneLine(proposal.reviewNote)}` : "",
    "",
    "No worker was dispatched. This only updates proposal review state.",
    ...proposalNextLines(proposal),
  ]
    .filter(Boolean)
    .join("\n");
}

export function orchestrationRequestAddedReport(request: OrchestrationRequestRecord): string {
  return [
    "# work",
    "",
    `저장된 요청: ${code(request.id)}`,
    `상태: ${code(request.status)}`,
    request.routineTriggerId ? `루틴: ${code(request.routineTriggerId)} fingerprint=${code(request.routineFingerprint ?? "unknown")}` : "",
    "",
    "요청:",
    oneLine(request.text),
    "",
    "아직 task draft나 worker action은 만들지 않았습니다.",
    "다음 단계에서 Samantha Orchestrator Agent가 계획을 작성합니다.",
    ...orchestrationRequestNextLines(request),
  ].join("\n");
}

export function orchestratorRecoveryRequestReport(input: {
  request: OrchestrationRequestRecord;
  sourcePlan: OrchestratorPlanRecord;
  failedActions: RemoteActionRecord[];
}): string {
  return [
    "# recover",
    "",
    "실패한 계획 결과를 바탕으로 복구 계획 요청을 만들었습니다.",
    input.sourcePlan.payload?.summary ? `복구 대상: ${telegramSafeLine(input.sourcePlan.payload.summary)}` : "",
    input.sourcePlan.synthesis?.summary ? `실패 요약: ${telegramSafeLine(input.sourcePlan.synthesis.summary)}` : "",
    "",
    "실패 작업:",
    ...(input.failedActions.length
      ? input.failedActions.map((action) => `- ${telegramSafeLine(action.taskTitle)}: ${telegramSafeLine(action.result?.failure ?? action.result?.outcome ?? action.status)}`)
      : ["- action 실패는 없지만 plan 종합 결과가 복구 필요 상태입니다."]),
    "",
    "아직 task/action은 만들지 않았습니다.",
    "오케스트레이터가 실패 원인을 보고 복구 계획을 다시 작성해야 합니다.",
    ...orchestrationRequestNextLines(input.request),
  ].join("\n");
}

export function orchestratorRevisionRequestReport(input: {
  request: OrchestrationRequestRecord;
  supersededPlan: OrchestratorPlanRecord;
}): string {
  return [
    "# revise",
    "",
    "현재 계획을 폐기하고 수정 요청을 만들었습니다.",
    `폐기한 계획: ${code(input.supersededPlan.id)}`,
    `새 요청: ${code(input.request.id)}`,
    "",
    "아직 task/action은 만들지 않았습니다.",
    "오케스트레이터가 이전 계획과 피드백을 함께 보고 새 계획을 작성합니다.",
    ...orchestrationRequestNextLines(input.request),
  ].join("\n");
}

export function orchestratorCancelReport(input: {
  plan?: OrchestratorPlanRecord;
  request?: OrchestrationRequestRecord;
}): string {
  return [
    "# cancel",
    "",
    input.plan ? "승인 전 계획을 취소했습니다." : "계획 대기 요청을 취소했습니다.",
    input.plan ? `계획: ${code(input.plan.id)}` : "",
    input.request ? `요청: ${code(input.request.id)}` : "",
    input.plan?.cancelReason ? `사유: ${oneLine(input.plan.cancelReason)}` : "",
    "",
    "task/action은 만들지 않았고 worker도 실행하지 않았습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
  ].join("\n");
}

export function orchestratorPlanReport(input: {
  request: OrchestrationRequestRecord;
  plan: OrchestratorPlanRecord;
  blocker?: OrchestratorPlanBlocker;
}): string {
  const { request, plan } = input;
  const blocker = input.blocker ?? payloadBlockerForPlan(plan);
  const classification = plan.classification ?? classifyRemoteRequest(request.text);
  if (plan.status === "failed") {
    return [
      "# plan",
      "",
      "오케스트레이터 계획 생성에 실패했습니다.",
      `요청: ${code(request.id)}`,
      `계획: ${code(plan.id)}`,
      requestClassificationLine(classification),
      requestClassificationReasonLine(classification),
      recoveryPlanVerdictLine(request, plan),
      plan.failure ? `실패 이유: ${oneLine(plan.failure)}` : "",
      plan.command ? `exit: ${code(String(plan.command.exitCode))}` : "",
      "",
      "다음 액션:",
      `- 요청을 보강해 다시 제출: ${code("/work <요청>")}`,
      `- 상태 확인: ${code("/now")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const payload = plan.payload;
  return [
    "# plan",
    "",
    `요청: ${code(request.id)}`,
    `계획: ${code(plan.id)}`,
    `상태: ${code(plan.status)}`,
    requestClassificationLine(classification),
    requestClassificationReasonLine(classification),
    recoveryPlanVerdictLine(request, plan),
    "",
    payload?.userMessage ? telegramSafeClipText(payload.userMessage, 1400) : "오케스트레이터가 표시할 메시지를 반환하지 않았습니다.",
    "",
    payload?.summary ? `요약: ${telegramSafeLine(payload.summary)}` : "",
    ...planAdvisoryLines(plan),
    ...planRecommendationTraceLines(plan),
    payload?.questions.length ? "" : "",
    ...(payload?.questions.length ? ["확인 질문:", ...payload.questions.map((question) => `- ${telegramSafeLine(question)}`)] : []),
    payload?.scope.length ? "" : "",
    ...(payload?.scope.length ? ["범위:", ...payload.scope.map((item) => `- ${telegramSafeLine(item)}`)] : []),
    payload?.tasks.length ? "" : "",
    ...(payload?.tasks.length
      ? [
          "작업 후보:",
          ...payload.tasks.map((task) => taskProposalLine(task)),
          ...planBatchDependencyLines(plan),
          "",
          "역할 흐름:",
          ...payload.tasks.map((task) =>
            roleOutcomeLine({
              agentId: task.targetAgent,
              title: task.title,
              mode: task.resultMode,
              outcome: task.resultMode === "report" ? "보고 산출" : "구현 산출",
            }),
          ),
        ]
      : []),
    payload?.risks.length ? "" : "",
    ...(payload?.risks.length ? ["리스크:", ...payload.risks.map((risk) => `- ${telegramSafeLine(risk)}`)] : []),
    ...(blocker ? orchestratorPlanBlockerLines(blocker) : []),
    "",
    "안전장치:",
    "- `/go` 전까지 task/action은 만들지 않습니다.",
    planHasAdvisory(plan) ? "- 대안/트레이드오프는 advisory이며 `/go` materialization 대상이 아닙니다." : undefined,
    "- merge/push/cleanup은 worker 실행 이후에도 별도 gate가 필요합니다.",
    ...orchestratorPlanNextLines(plan, blocker),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function orchestratorGoBlockedReport(input: { plan: OrchestratorPlanRecord; violations?: string[]; blocker?: OrchestratorPlanBlocker }): string {
  const { plan } = input;
  const violations = input.violations ?? [];
  const blocker = input.blocker ?? payloadBlockerForPlan(plan);
  return [
    "# go",
    "",
    "오케스트레이터 계획을 실행 큐에 등록하지 못했습니다.",
    `계획: ${code(plan.id)}`,
    `요청: ${code(plan.requestId)}`,
    `상태: ${code(plan.status)}`,
    plan.payload ? `작업 후보: ${plan.payload.tasks.length}` : "",
    "",
    "차단 사유:",
    ...(violations.length ? violations.map((violation) => `- ${violation}`) : ["- 계획에 확인 질문이 남아 있거나 실행 가능한 상태가 아닙니다."]),
    "",
    "task/action은 만들지 않았습니다.",
    "",
    "다음 액션:",
    `- ${plan.status === "questions" ? "답변/수정 요청" : blocker ? "계획 수정" : "계획 수정"}: ${code("/revise <피드백>")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function orchestratorGoMaterializedReport(input: {
  plan: OrchestratorPlanRecord;
  tasks: TaskSpec[];
  actions: RemoteActionRecord[];
}): string {
  return [
    "# go",
    "",
    "오케스트레이터 계획을 승인했고 worker 실행 큐에 등록했습니다.",
    `계획: ${code(input.plan.id)}`,
    `상태: ${code(input.plan.status)}`,
    ...(planHasAdvisory(input.plan) ? ["선택된 작업 경로만 task/action으로 등록했습니다. 대안은 advisory로 남깁니다."] : []),
    "",
    "생성된 task:",
    ...input.tasks.map((task) => `- ${code(task.id)} ${oneLine(task.title)} agent=${code(task.targetAgent)}`),
    "",
    "생성된 action:",
    ...input.actions.map((action) => {
      const waitCount = action.dependsOnActionIds?.length ?? 0;
      const dependency = waitCount > 0 ? ` prerequisites=${code(String(waitCount))}` : "";
      return `- ${code(action.id)} task=${code(action.taskId)} status=${code(action.status)}${dependency}`;
    }),
    "",
    "실행 순서:",
    ...input.actions.map((action) => actionDependencyLine(action, input.tasks)),
    "",
    "runner가 `actions:watch`에서 승인된 action을 실행합니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
  ].join("\n");
}

export function orchestratorPlanResultReport(input: {
  plan: OrchestratorPlanRecord;
  actions: RemoteActionRecord[];
  runLogs: WorkerRunLog[];
  synthesis?: OrchestratorSynthesisPayload;
  synthesisFailure?: string;
  sourcePlan?: OrchestratorPlanRecord;
  artifactPreviews?: RemoteActionArtifactPreview[];
}): string {
  const failed = input.actions.filter((action) => action.status !== "completed" || action.result?.pass === false);
  const runLogForAction = (action: RemoteActionRecord) =>
    input.runLogs.find((log) => log.runId === action.result?.runId || log.task.id === action.taskId);
  const needsRecovery = failed.length > 0 || (input.synthesis ? input.synthesis.outcome !== "pass" : false);
  const verificationFailed = input.actions.some((action) => actionVerificationFailed(action, runLogForAction(action)));
  const mergeCommands = input.actions
    .map((action) => {
      const runLog = runLogForAction(action);
      if (!runLog?.result.pass || !runLog.result.commit?.commitHash || !action.result?.runLogPath) return "";
      return code(`bun run samantha merge:check --run-log=${action.result.runLogPath} --repo-root=${runLog.input.repoRoot}`);
    })
    .filter(Boolean);
  const changedFiles = Array.from(
    new Set(input.runLogs.flatMap((runLog) => runLog.result.evaluation?.changedFiles ?? runLog.result.commit?.files ?? [])),
  );
  const reportArtifactFiles = Array.from(
    new Set([
      ...(input.artifactPreviews ?? []).map((preview) => preview.file),
      ...input.runLogs
        .filter((runLog) => runLog.task.resultMode === "report")
        .flatMap((runLog) => runLog.result.evaluation?.changedFiles ?? runLog.result.commit?.files ?? []),
    ]),
  );
  const failedVerifyDetails = input.runLogs.flatMap((runLog) =>
    runLog.result.evaluation?.verifyResults
      .filter((result) => result.exitCode !== 0)
      .map((result) =>
        `${oneLine(runLog.task.title)}: ${result.command} exited ${result.exitCode}${result.stderr ? ` stderr=${oneLine(result.stderr).slice(0, 180)}` : ""}`
      ) ?? [],
  );
  const runLogPaths = Array.from(
    new Set(input.actions.flatMap((action) => action.result?.runLogPath ? [action.result.runLogPath] : [])),
  );
  const reportOnly = input.runLogs.length > 0 && input.runLogs.every((runLog) => runLog.task.resultMode === "report");
  const outcome = planResultOutcomeLabel({
    needsRecovery,
    verificationFailed,
    reportOnly,
    synthesisOutcome: input.synthesis?.outcome,
  });
  const riskLines = [
    ...(input.synthesis?.risks ?? []),
    input.synthesis && input.synthesis.outcome !== "pass" ? `종합 결과: ${telegramSafeLine(input.synthesis.summary)}` : "",
    input.synthesisFailure ? `오케스트레이터 종합 실패: ${telegramSafeLine(input.synthesisFailure)}` : "",
    ...failed.map((action) => `${telegramSafeLine(action.taskTitle)}: ${telegramSafeLine(action.result?.failure ?? action.result?.outcome ?? action.status)}`),
  ].filter((line): line is string => Boolean(line));
  const nextCommand = needsRecovery ? "/recover" : mergeCommands.length ? "/now" : "/check";
  const repoNames = Array.from(
    new Set(input.actions.map((action) => repoName(runLogForAction(action)?.input.repoRoot ?? action.repoRoot))),
  );
  const recoveryVerdict = input.sourcePlan
    ? needsRecovery
      ? `복구 판단: 원 문제 미해결 - ${oneLine(input.sourcePlan.payload?.summary ?? input.sourcePlan.requestId)} 추가 복구 필요`
      : `복구 판단: 원 문제 해결됨 - ${oneLine(input.sourcePlan.payload?.summary ?? input.sourcePlan.requestId)}`
    : "";

  return [
    "# plan-result",
    "",
    `계획 결과: ${outcome}`,
    `대상 repo: ${repoNames.map(code).join(", ")}`,
    planWorkTypeLine({ runLogs: input.runLogs, mergeCommands, needsRecovery }),
    `완료 작업: ${input.actions.length - failed.length}/${input.actions.length}`,
    input.synthesis ? `종합 결과: ${code(input.synthesis.outcome)}` : "",
    recoveryVerdict,
    "",
    input.synthesis ? "오케스트레이터 종합:" : "",
    input.synthesis ? telegramSafeClipText(input.synthesis.userMessage, 1400) : "",
    input.synthesisFailure ? `오케스트레이터 종합 실패: ${telegramSafeLine(input.synthesisFailure)}` : "",
    input.synthesis || input.synthesisFailure ? "" : "",
    "Worker 결과:",
    ...input.actions.flatMap((action) => {
      const runLog = runLogForAction(action);
      const actionOutcome = actionNeedsRecovery(action)
        ? actionVerificationFailed(action, runLog)
          ? "검증 실패"
          : "실패"
        : runLog?.task.resultMode === "report"
          ? "보고 완료"
          : "통과";
      const specialistFailed = runLog?.task.resultMode === "report" && actionNeedsRecovery(action);
      return [
        roleOutcomeLine({
          agentId: runLog?.agent.id ?? action.targetAgent,
          title: action.taskTitle,
          mode: runLog?.task.resultMode,
          outcome: actionOutcome,
          ancestry: runLog?.task.ancestry ?? runLog?.ancestry ?? action.ancestry ?? input.plan.ancestry,
          includeContribution: true,
          includeTopology: false,
        }),
        `  대상: ${repoName(runLog?.input.repoRoot ?? action.repoRoot)} / ${resultModeLabel(runLog?.task.resultMode)}`,
        runLog ? `  보고: ${oneLine(workerFinalMessage(runLog))}` : "",
        action.result?.failure ? `  실패 이유: ${telegramSafeLine(action.result.failure)}` : "",
        specialistFailed ? `  다음: 실패한 specialist 보고를 ${code("/recover")} 복구 계획에 반영` : "",
      ].filter(Boolean);
    }),
    "",
    "산출/변경:",
    ...(changedFiles.length ? changedFiles.slice(0, 8).map((file) => `- ${code(displayFilePath(file))}`) : ["- 없음"]),
    changedFiles.length > 8 ? `- 외 ${changedFiles.length - 8}개` : "",
    "",
    "증거:",
    ...(reportArtifactFiles.length
      ? ["- 보고 산출물:", ...reportArtifactFiles.slice(0, 5).map((file) => `  - ${code(file)}`)]
      : ["- 보고 산출물: 없음"]),
    reportArtifactFiles.length > 5 ? `  - 외 ${reportArtifactFiles.length - 5}개` : "",
    ...(failedVerifyDetails.length
      ? ["- 실패 검증:", ...failedVerifyDetails.slice(0, 5).map((detail) => `  - ${telegramSafeLine(detail)}`)]
      : ["- 실패 검증: 없음"]),
    failedVerifyDetails.length > 5 ? `  - 외 ${failedVerifyDetails.length - 5}개` : "",
    ...(runLogPaths.length
      ? ["- Run log:", ...runLogPaths.slice(0, 5).map((path) => `  - ${code(path)}`)]
      : ["- Run log: 없음"]),
    runLogPaths.length > 5 ? `  - 외 ${runLogPaths.length - 5}개` : "",
    "",
    "남은 리스크:",
    ...(riskLines.length ? riskLines.slice(0, 5).map((risk) => `- ${remoteSafeSuggestion(risk)}`) : ["- 없음"]),
    "",
    "다음 액션:",
    `- 텔레그램: ${code(nextCommand)}`,
    ...(mergeCommands.length ? ["", "로컬 merge 후보:", ...mergeCommands] : []),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function taskDraftAddedReport(draft: TaskDraftRecord): string {
  return [
    "# drafts:add",
    "",
    `저장된 드래프트: ${code(draft.id)}`,
    `원본 제안: ${code(draft.sourceProposalId)}`,
    `상태: ${code(draft.status)}`,
    "",
    `제목: ${oneLine(draft.title)}`,
    "",
    "아직 worker는 실행하지 않았습니다. 승인 전 `/plan`으로 범위와 검증 계획을 확인하세요.",
    ...draftNextLines(draft),
  ].join("\n");
}

export function taskDraftPlanReport(input: {
  draft: TaskDraftRecord;
  project: ProjectProfile;
  scope: ProjectRemoteScope | undefined;
  violations: string[];
  inferredProject: boolean;
  inferredScope: boolean;
}): string {
  const scope = input.scope;
  const classification = classifyRemoteRequest(input.draft.instructions);
  const lines = [
    "# plan",
    "",
    `요청: ${oneLine(input.draft.instructions)}`,
    `드래프트: ${code(input.draft.id)}`,
    `프로젝트: ${code(input.project.id)}${input.inferredProject ? " (자동 선택)" : ""}`,
    requestClassificationLine(classification),
    `분류: ${resultModeLabel(input.draft.resultMode)}${scope ? ` (${code(scope.id)} - ${oneLine(scope.label)})` : " (프로젝트 기본값)"}`,
    scope ? `위험도: ${projectRemoteScopeRisk(input.project, scope)}${input.inferredScope ? " (자동 선택)" : ""}` : "위험도: unknown",
    `실행 모드: ${code(input.draft.resultMode ?? "write")}`,
    `준비 상태: ${input.violations.length === 0 ? "가능" : "불가"}`,
    "",
    "판단 근거:",
    `- ${requestClassificationReasonLine(classification)}`,
    `- 작업 repo는 ${code(input.project.repoRoot)}입니다.`,
    scope
      ? `- 요청 분류와 내용을 기준으로 ${code(scope.id)} 범위를 선택했습니다.`
      : "- remote scope recipe가 없어 project 기본값만 적용했습니다.",
    "- `/plan`은 worker 실행이나 승인까지 진행하지 않습니다.",
    "",
    "변경 허용 범위:",
    ...input.draft.targetFiles.map((file) => `- ${code(file)}`),
    "",
    "변경 금지 범위:",
    ...input.draft.forbiddenChanges.map((file) => `- ${code(file)}`),
    "",
    "작업 계획:",
    ...(scope?.planSteps ?? [
      "관련 파일을 먼저 읽습니다.",
      "선언된 범위 안에서 요청을 처리합니다.",
      "설정된 검증 명령을 실행합니다.",
      "변경 파일과 남은 리스크를 보고합니다.",
    ]).map((step, index) => `${index + 1}. ${step}`),
    "",
    "검증:",
    ...input.draft.verifyCommands.map((command) => `- ${code(command)}`),
    "",
    "성공 기준:",
    ...(scope?.successCriteria ?? [
      "요청한 작업이 완료됩니다.",
      "금지된 파일은 변경하지 않습니다.",
      "검증이 통과하거나 blocker가 명확히 보고됩니다.",
    ]).map((criterion) => `- ${criterion}`),
  ];
  if (input.violations.length) {
    lines.push("", "차단 이슈:", ...input.violations.map((violation) => `- ${violation}`));
  }
  lines.push(
    "",
    "다음 액션:",
    input.violations.length === 0 ? `- 실행 승인: ${code("/go")}` : `- 분류/범위 재지정: ${code("/plan <project_id> <scope_id>")}`,
    `- 상태 기준으로 다시 판단: ${code("/now")}`,
  );
  return lines.join("\n");
}

export function taskDraftPreparedReport(input: {
  draft: TaskDraftRecord;
  projectId: string;
  violations: string[];
}): string {
  return [
    "# drafts:prepare-latest",
    "",
    `준비된 드래프트: ${code(input.draft.id)}`,
    `프로젝트: ${code(input.projectId)}`,
    `준비 상태: ${input.violations.length === 0 ? "가능" : "불가"}`,
    input.violations.length ? `부족한 항목: ${input.violations.join(", ")}` : "",
    "",
    "아직 worker는 실행하지 않았고 task도 만들지 않았습니다.",
    ...draftNextLines(input.draft),
  ]
    .filter(Boolean)
    .join("\n");
}

export function taskDraftPrepareBlockedReport(input: {
  draft: TaskDraftRecord;
  projectId: string;
  violations: string[];
}): string {
  return [
    "# drafts:prepare-latest",
    "",
    "드래프트를 준비하지 못했습니다.",
    `드래프트: ${code(input.draft.id)}`,
    `프로젝트: ${code(input.projectId)}`,
    "",
    "위반 사항:",
    ...input.violations.map((violation) => `- ${violation}`),
    ...draftNextLines(input.draft),
  ].join("\n");
}

export function taskDraftApprovalBlockedReport(input: {
  draft: TaskDraftRecord;
  violations: string[];
}): string {
  return [
    "# drafts:approve-latest",
    "",
    "드래프트를 승인하지 못했습니다.",
    `드래프트: ${code(input.draft.id)}`,
    "",
    "위반 사항:",
    ...input.violations.map((violation) => `- ${violation}`),
    ...draftNextLines(input.draft),
  ].join("\n");
}

export function taskDraftApprovedReport(input: { draft: TaskDraftRecord; task: TaskSpec }): string {
  return [
    "# drafts:approve-latest",
    "",
    `승인된 드래프트: ${code(input.draft.id)}`,
    `생성된 task: ${code(input.task.id)}`,
    `제목: ${oneLine(input.task.title)}`,
    "",
    "아직 worker는 실행하지 않았습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/go")}`,
  ].join("\n");
}

export function draftProposeAddedReport(input: { proposal: ProposalRecord; draft: TaskDraftRecord }): string {
  return [
    "# drafts:add-from-proposal-text",
    "",
    `저장된 제안: ${code(input.proposal.id)}`,
    `제안 상태: ${code(input.proposal.status)}`,
    `저장된 드래프트: ${code(input.draft.id)}`,
    `드래프트 상태: ${code(input.draft.status)}`,
    "",
    `제목: ${oneLine(input.draft.title)}`,
    "",
    "아직 worker는 실행하지 않았습니다. 제안과 드래프트만 저장했습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/plan")}`,
  ].join("\n");
}

export function taskDraftsListReport(drafts: TaskDraftRecord[], limit = 10): string {
  const lines = recent(drafts, limit).map(draftLine);
  return ["# drafts:list", "", `Total drafts: ${drafts.length}`, "", ...(lines.length ? lines : ["No task drafts recorded."])].join("\n");
}

export function taskDraftShowReport(draftId: string, draft: TaskDraftRecord | undefined): string {
  if (!draft) {
    return ["# drafts:show", "", `드래프트를 찾지 못했습니다: ${code(draftId)}`].join("\n");
  }

  return [
    "# drafts:show",
    "",
    `드래프트: ${code(draft.id)}`,
    `원본 제안: ${code(draft.sourceProposalId)}`,
    `상태: ${code(draft.status)}`,
    `생성: ${code(draft.createdAt)}`,
    `제목: ${oneLine(draft.title)}`,
    `Agent: ${code(draft.targetAgent)}`,
    draft.resultMode ? `실행 모드: ${code(draft.resultMode)}` : "",
    `변경 허용 범위: ${draft.targetFiles.map(code).join(", ") || "none"}`,
    `Setup 명령: ${(draft.setupCommands ?? []).map(code).join(", ") || "none"}`,
    `검증 명령: ${draft.verifyCommands.map(code).join(", ") || "none"}`,
    "",
    "요청 내용:",
    draft.instructions.trim(),
    ...draftNextLines(draft),
  ].join("\n");
}

export function remoteActionPreparedReport(action: RemoteActionRecord): string {
  return [
    "# actions:prepare-dispatch",
    "",
    `액션: ${code(action.id)}`,
    `상태: ${code(action.status)}`,
    `태스크: ${code(action.taskId)} - ${oneLine(action.taskTitle)}`,
    `Agent: ${code(action.targetAgent)}`,
    repoSummaryLine(action.repoRoot),
    action.admission && action.admission.decision !== "accept"
      ? `Admission: decision=${code(action.admission.decision)} pressure=${code(action.admission.pressureClass)} reason=${telegramSafeLine(action.admission.reason)}`
      : "",
    "",
    "실행 예정 명령:",
    code(remoteActionCommand(action)),
    "",
    "아직 worker는 실행하지 않았습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/go")}`,
  ].join("\n");
}

export function remoteGoReport(input: {
  action: RemoteActionRecord;
  draft?: TaskDraftRecord;
  task?: TaskSpec;
}): string {
  return [
    "# go",
    "",
    input.draft ? `승인된 드래프트: ${code(input.draft.id)}` : "",
    input.task ? `태스크: ${code(input.task.id)} - ${oneLine(input.task.title)}` : `태스크: ${code(input.action.taskId)} - ${oneLine(input.action.taskTitle)}`,
    `액션: ${code(input.action.id)}`,
    `상태: ${code(input.action.status)}`,
    repoSummaryLine(input.action.repoRoot),
    input.task?.resultMode ? workTypeLine({ mode: input.task.resultMode }) : "",
    "",
    "실행을 승인했습니다.",
    "runner가 `actions:watch` 또는 `actions:run-pending`에서 실행을 이어갑니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function remoteGoNoActionablePlanReport(): string {
  return [
    "# go",
    "",
    "승인할 오케스트레이터 계획이나 진행할 통합 gate가 없습니다.",
    "오래된 pending task/action/draft는 Telegram `/go`로 승인하거나 실행 큐에 등록하지 않습니다.",
    "",
    "다음 액션:",
    `- 텔레그램: ${code("/now")}`,
  ].join("\n");
}

export function remoteIntegrationReport(input: {
  stage: "merge" | "push" | "cleanup";
  run: RunSummary;
  ok: boolean;
  details: string[];
  lifecycle?: RunLifecycleRecord;
}): string {
  const stageLabel =
    input.stage === "merge" ? "merge 적용" : input.stage === "push" ? "push" : "worktree cleanup";
  const next =
    input.ok && input.stage !== "cleanup"
      ? `- 텔레그램: ${code("/now")}`
      : input.ok
        ? `- 텔레그램: ${code("/check")}`
        : `- 텔레그램: ${code("/problems")}`;

  return [
    "# integration-result",
    "",
    `단계: ${stageLabel}`,
    `결과: ${input.ok ? "통과" : "차단"}`,
    `런: ${code(input.run.runId)}`,
    `태스크: ${code(input.run.taskId)} - ${oneLine(input.run.taskTitle)}`,
    repoSummaryLine(input.run.repoRoot),
    workTypeLine({ pass: input.run.pass, commit: input.run.commit }),
    input.lifecycle ? `lifecycle: ${lifecycleText(input.lifecycle)}` : "",
    "",
    "세부:",
    ...(input.details.length ? input.details.map((line) => `- ${oneLine(line)}`) : ["- 없음"]),
    "",
    "다음 액션:",
    next,
  ]
    .filter(Boolean)
    .join("\n");
}

export function remoteActionsListReport(actions: RemoteActionRecord[], limit = 10): string {
  const lines = recent(actions, limit).map(remoteActionLine);
  return ["# actions:list", "", `Total actions: ${actions.length}`, "", ...(lines.length ? lines : ["No actions recorded."])].join("\n");
}

export function remoteActionShowReport(actionId: string, action: RemoteActionRecord | undefined): string {
  if (!action) {
    return ["# actions:show", "", `액션을 찾지 못했습니다: ${code(actionId)}`].join("\n");
  }

  return [
    "# actions:show",
    "",
    `액션: ${code(action.id)}`,
    `종류: ${code(action.kind)}`,
    `상태: ${code(action.status)}`,
    `태스크: ${code(action.taskId)} - ${oneLine(action.taskTitle)}`,
    `Agent: ${code(action.targetAgent)}`,
    repoSummaryLine(action.repoRoot),
    `생성: ${code(action.createdAt)}`,
    action.approvedAt ? `승인: ${code(action.approvedAt)}` : "",
    action.startedAt ? `시작: ${code(action.startedAt)}` : "",
    action.completedAt ? `완료: ${code(action.completedAt)}` : "",
    "",
    "명령:",
    code(remoteActionCommand(action)),
    action.result?.runId ? `런: ${code(action.result.runId)}` : "",
    action.result?.pass !== undefined ? `통과: ${action.result.pass ? "yes" : "no"}` : "",
    action.result?.outcome ? `결과: ${code(action.result.outcome)}` : "",
    action.result?.runLogPath ? `Run log: ${code(action.result.runLogPath)}` : "",
    action.result?.liveLogPath ? `Live log: ${code(action.result.liveLogPath)}` : "",
    action.result?.tmuxSession ? `Tmux: ${code(action.result.tmuxSession)}` : "",
    action.result?.failure ? `실패 이유: ${telegramSafeLine(action.result.failure)}` : "",
    ...remoteActionNextLines(action),
  ]
    .filter(Boolean)
    .join("\n");
}

export function remoteActionApprovedReport(action: RemoteActionRecord): string {
  const result = action.result;
  return [
    "# actions:approve",
    "",
    `액션: ${code(action.id)}`,
    `상태: ${code(action.status)}`,
    `태스크: ${code(action.taskId)}`,
    repoSummaryLine(action.repoRoot),
    result?.runId ? `런: ${code(result.runId)}` : "",
    result?.outcome ? `결과: ${code(result.outcome)}` : "",
    result?.pass !== undefined ? `통과: ${result.pass ? "yes" : "no"}` : "",
    result?.runLogPath ? `Run log: ${code(result.runLogPath)}` : "",
    result?.liveLogPath ? `Live log: ${code(result.liveLogPath)}` : "",
    result?.tmuxSession ? `Tmux: ${code(result.tmuxSession)}` : "",
    result?.failure ? `실패 이유: ${telegramSafeLine(result.failure)}` : "",
    action.status === "approved" ? "runner가 `actions:watch` 또는 `actions:run-pending`에서 실행을 이어갑니다." : "",
    ...remoteActionNextLines(action),
  ]
    .filter(Boolean)
    .join("\n");
}

export function remoteActionResultReport(input: {
  action: RemoteActionRecord;
  runLog?: WorkerRunLog;
  artifactPreviews?: RemoteActionArtifactPreview[];
}): string {
  const { action, runLog } = input;
  const result = action.result;
  const commit = runLog?.result.commit?.commitHash || runLog?.result.evaluation?.harness?.commit || "";
  const pass = result?.pass ?? runLog?.result.pass;

  return [
    "# execution-result",
    "",
    `실행 결과: ${pass ? "통과" : "실패"}`,
    `액션: ${code(action.id)}`,
    `태스크: ${code(action.taskId)} - ${oneLine(action.taskTitle)}`,
    repoSummaryLine(runLog?.input.repoRoot ?? action.repoRoot),
    runLog?.task.resultMode ? `모드: ${resultModeLabel(runLog.task.resultMode)}` : "",
    workTypeLine({ mode: runLog?.task.resultMode, pass, commit }),
    result?.runId ? `런: ${code(result.runId)}` : "",
    result?.outcome ? `결과: ${code(result.outcome)}` : "",
    action.completedAt ? `완료: ${code(action.completedAt)}` : "",
    result?.failure ? `실패 이유: ${telegramSafeLine(result.failure)}` : "",
    "",
    "산출 보고:",
    workerFinalMessage(runLog),
    "",
    "변경 파일:",
    ...changedFileLines(runLog),
    ...artifactPreviewLines(runLog, input.artifactPreviews),
    "",
    `커밋: ${commit ? code(commit) : "없음"}`,
    "",
    "검증:",
    ...verificationLines(runLog),
    "",
    "기록:",
    result?.runLogPath ? `- Run log: ${code(result.runLogPath)}` : "- Run log: 없음",
    result?.liveLogPath ? `- Live log: ${code(result.liveLogPath)}` : "- Live log: 없음",
    result?.tmuxSession ? `- Tmux: ${code(result.tmuxSession)}` : "",
    ...remoteActionResultNextLines(action, runLog),
  ]
    .filter(Boolean)
    .join("\n");
}

type StatusReportMode = "compact" | "full";

function compactPrimaryAction(input: {
  view: ReturnType<typeof buildOperatingSurfaceView>;
  snapshot: CeoStatusSnapshot;
  unassignedPendingRequests: number;
  assignedPendingRequests: number;
}): { label: string; reason: string; telegram?: string; local?: string } {
  const blocker = input.snapshot.blocked[0];
  if (blocker && input.unassignedPendingRequests > 0) {
    return {
      label: "CLI/dashboard에서 recovery blocker와 project 없는 pending 요청을 먼저 정리하세요.",
      reason: `현재 블로커는 ${remoteStatusItemLabel(blocker)}이고, project 없는 pending 요청 ${input.unassignedPendingRequests}개는 Telegram에서 안전하게 선택할 수 없습니다.`,
      local: "bun run samantha ceo:status",
    };
  }
  if (input.unassignedPendingRequests > 0 && input.assignedPendingRequests === 0) {
    return {
      label: "CLI/dashboard에서 project 없는 pending 요청을 정리하세요.",
      reason: `pending 요청 ${input.unassignedPendingRequests}개 모두 project가 없어 Telegram에서 안전한 /plan 또는 /drop 대상을 만들 수 없습니다.`,
      local: "bun run samantha orchestrator:current",
    };
  }
  return {
    label: remoteActionLabelForNotification(input.view.primaryAction.label, blocker),
    reason: remoteNotificationText(input.view.primaryAction.reason),
    telegram: input.view.primaryAction.telegramCommand,
    local: input.view.primaryAction.localCommand,
  };
}

function compactStatusReport(input: {
  heartbeat?: DaemonHeartbeat;
  pendingInboxCount: number;
  ops?: OpsSnapshot;
  projectId?: string;
  runs: RunSummary[];
  requests?: OrchestrationRequestRecord[];
  actionCounts?: { pending: number; waiting: number; approved: number; running: number; failed: number };
  failureCount: number;
  projectQueues: ReturnType<typeof buildProjectQueueSnapshot>;
  ceoRankingSnapshot: CeoStatusSnapshot;
}): string {
  const view = buildOperatingSurfaceView(input.ceoRankingSnapshot);
  const pressure = input.projectQueues.pressure;
  const unassignedPendingRequests = input.projectId
    ? 0
    : (input.requests ?? []).filter((request) => request.status === "pending_plan" && !recordProjectId(request)).length;
  const assignedPendingRequests = input.projectId
    ? (input.requests ?? []).filter((request) => request.status === "pending_plan").length
    : (input.requests ?? []).filter((request) => request.status === "pending_plan" && recordProjectId(request)).length;
  const primaryAction = compactPrimaryAction({
    view,
    snapshot: input.ceoRankingSnapshot,
    unassignedPendingRequests,
    assignedPendingRequests,
  });
  const latest = input.runs.at(-1);
  const replyFailures = input.ops?.telegram.replyState?.failures?.length ?? 0;
  const pressureReasons = pressure.reasons.slice(0, 4);
  const pressureGuidance = formatQueuePressureGuidance(pressure)
    .slice(1)
    .filter(Boolean)
    .filter((line) => !(unassignedPendingRequests > 0 && line.includes("pending requests=")))
    .slice(0, 4);
  const actionSummary = input.actionCounts
    ? `pending=${input.actionCounts.pending} waiting=${input.actionCounts.waiting} approved=${input.actionCounts.approved} running=${input.actionCounts.running} failed=${input.actionCounts.failed}`
    : "unknown";

  return [
    "# status",
    "",
    input.projectId ? `Project filter: ${input.projectId}` : "",
    `상태: ${input.ceoRankingSnapshot.overall}`,
    "",
    "지금 할 일:",
    `- Primary: ${primaryAction.label}`,
    `- 이유: ${primaryAction.reason}`,
    primaryAction.telegram ? `- Telegram: ${code(primaryAction.telegram)}` : "- Telegram: 없음",
    primaryAction.local ? `- Local: ${code(primaryAction.local)}` : "",
    "",
    "막힌 이유:",
    `- pressure=${code(pressure.pressureClass)}`,
    ...(pressureReasons.length ? pressureReasons.map((reason) => `- ${telegramSafeLine(reason)}`) : ["- 없음"]),
    unassignedPendingRequests
      ? `- project 없는 pending 요청=${unassignedPendingRequests}: Telegram에서 안전한 ${code("/plan <project>")} 명령을 만들 수 없습니다.`
      : "",
    "",
    "해결:",
    ...(unassignedPendingRequests
      ? [
          "- project 없는 요청은 로컬 CLI/dashboard에서 출처를 확인하고, project가 있는 새 요청으로 다시 제출하거나 정리하세요.",
          `- Local: ${code("bun run samantha orchestrator:current")}`,
        ]
      : []),
    ...(pressureGuidance.length ? pressureGuidance : ["- 현재 queue pressure로 막힌 항목은 없습니다."]),
    "",
    "운영 신호:",
    `- daemon=${input.heartbeat?.status ?? "missing"} pending_inbox=${input.pendingInboxCount}`,
    input.ops
      ? `- telegram_reply_failures=${replyFailures} unsent_outbox=${input.ops.queues.unsentRemoteOutboxCount} ops=${input.ops.ok ? "ok" : "needs_attention"}`
      : "- telegram=unknown",
    `- actions: ${actionSummary}`,
    `- runs: total=${input.runs.length} non_passing=${input.failureCount}${latest ? ` latest=${latest.outcome}` : ""}`,
    "",
    "긴 진단:",
    `- Runtime/Telegram 문제: ${code("/problems")}`,
    "- 상세 queue/run 검토: CLI 또는 dashboard",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function statusReport(input: {
  runs: RunSummary[];
  heartbeat?: DaemonHeartbeat;
  pendingInboxCount: number;
  ops?: OpsSnapshot;
  projectId?: string;
  mode?: StatusReportMode;
  proposals?: ProposalRecord[];
  drafts?: TaskDraftRecord[];
  requests?: OrchestrationRequestRecord[];
  plans?: OrchestratorPlanRecord[];
  decisions?: DecisionItem[];
  tasks?: TaskSpec[];
  actions?: RemoteActionRecord[];
  lifecycles?: RunLifecycleRecord[];
  reports?: CeoReportRecord[];
  governanceEvents?: GovernanceEventRecord[];
  orchestratorPlanBlockers?: OrchestratorPlanBlocker[];
  budgetObservations?: CostBudgetAuditRecord[];
  budgetPolicies?: BudgetPolicyRecord[];
}): string {
  const latest = input.runs.at(-1);
  const latestLifecycle = latest ? input.lifecycles?.find((record) => record.runId === latest.runId) : undefined;
  const failureCount = input.runs.filter((run) => !run.pass).length;
  const proposalCounts = input.proposals
    ? {
        pending: input.proposals.filter((proposal) => proposal.status === "pending_review").length,
        accepted: input.proposals.filter((proposal) => proposal.status === "accepted").length,
        rejected: input.proposals.filter((proposal) => proposal.status === "rejected").length,
      }
    : undefined;
  const draftCounts = input.drafts
    ? {
        drafted: input.drafts.filter((draft) => draft.status === "drafted").length,
        approved: input.drafts.filter((draft) => draft.status === "approved").length,
        discarded: input.drafts.filter((draft) => draft.status === "discarded").length,
      }
    : undefined;
  const actionCounts = input.actions
    ? {
        pending: input.actions.filter((action) => action.status === "pending").length,
        waiting: input.actions.filter((action) => action.status === "waiting").length,
        approved: input.actions.filter((action) => action.status === "approved").length,
        running: input.actions.filter((action) => action.status === "running").length,
        failed: input.actions.filter((action) => action.status === "failed").length,
      }
    : undefined;
  const projectQueues = buildProjectQueueSnapshot({
    requests: input.requests,
    plans: input.plans,
    decisions: input.decisions,
    taskDrafts: input.drafts,
    tasks: input.tasks,
    actions: input.actions,
    runs: input.runs,
    lifecycles: input.lifecycles,
    reports: input.reports,
    governanceEvents: input.governanceEvents,
    budgetObservations: input.budgetObservations,
    budgetPolicies: input.budgetPolicies,
    orchestratorPlanBlockers: input.orchestratorPlanBlockers,
    ops: input.ops,
    globalBlockers: [...(input.ops?.failures ?? []), ...(input.ops?.warnings ?? [])],
  }, { filterProjectId: input.projectId });
  const ceoRankingSnapshot = buildCeoStatusSnapshot({
    projectId: input.projectId,
    runs: input.runs,
    tasks: input.tasks,
    taskDrafts: input.drafts,
    decisions: input.decisions,
    actions: input.actions,
    orchestrationRequests: input.requests,
    orchestratorPlans: input.plans,
    orchestratorPlanBlockers: input.orchestratorPlanBlockers,
    ops: input.ops,
    lifecycles: input.lifecycles,
    reports: input.reports,
    governanceEvents: input.governanceEvents,
    budgetObservations: input.budgetObservations,
    budgetPolicies: input.budgetPolicies,
  });
  const heartbeat = input.heartbeat
    ? `${input.heartbeat.status} pid=${input.heartbeat.pid} updated=${input.heartbeat.updatedAt} processed=${input.heartbeat.processedTotal}`
    : "missing";

  if (input.mode === "compact") {
    return compactStatusReport({
      runs: input.runs,
      heartbeat: input.heartbeat,
      pendingInboxCount: input.pendingInboxCount,
      ops: input.ops,
      projectId: input.projectId,
      requests: input.requests,
      actionCounts,
      failureCount,
      projectQueues,
      ceoRankingSnapshot,
    });
  }

  return [
    "# status",
    "",
    input.projectId ? `Project filter: ${input.projectId}` : "",
    `운영 상태: ${input.ops ? (input.ops.ok ? "정상" : "확인 필요") : "unknown"}`,
    input.ops ? `진단: failures=${input.ops.failures.length} warnings=${input.ops.warnings.length}` : "",
    "",
    "Daemon:",
    `- heartbeat: ${code(heartbeat)}`,
    "",
    "큐:",
    `- pending inbox: ${input.pendingInboxCount}`,
    input.ops ? `- remote outbox: ${input.ops.queues.remoteOutboxCount}` : "",
    input.ops ? `- unsent remote outbox: ${input.ops.queues.unsentRemoteOutboxCount}` : "",
    "",
    "원격:",
    input.ops?.queues.latestRemoteCommand
      ? `- 최근 명령: type=${code(input.ops.queues.latestRemoteCommand.type ?? "unknown")} id=${code(input.ops.queues.latestRemoteCommand.id ?? input.ops.queues.latestRemoteCommand.file)} received=${code(input.ops.queues.latestRemoteCommand.receivedAt ?? "unknown")}`
      : "- 최근 명령: 없음",
    input.ops?.queues.latestRemoteOutbox
      ? `- 최근 리포트: ${code(input.ops.queues.latestRemoteOutbox.file)} updated=${code(input.ops.queues.latestRemoteOutbox.updatedAt)}`
      : "- 최근 리포트: 없음",
    "",
    "Telegram:",
    input.ops
      ? input.ops.telegram.offset?.nextOffset !== undefined
        ? `- next offset: ${input.ops.telegram.offset.nextOffset}`
        : "- next offset: missing"
      : "",
    input.ops
      ? input.ops.telegram.replyState
        ? `- replies: sent=${input.ops.telegram.replyState.sentFiles.length} failures=${input.ops.telegram.replyState.failures?.length ?? 0} updated=${code(input.ops.telegram.replyState.updatedAt)}`
        : "- replies: missing"
      : "",
    input.ops ? `- 최근 reply 실패: ${oneLine(latestReplyFailure(input.ops))}` : "",
    "",
    "확인 필요:",
    input.ops?.failures.length ? `- 첫 failure: ${oneLine(input.ops.failures[0] ?? "")}` : "- failures: 없음",
    input.ops?.warnings.length ? `- 첫 warning: ${oneLine(input.ops.warnings[0] ?? "")}` : "- warnings: 없음",
    "",
    "제안:",
    proposalCounts
      ? `- pending_review: ${proposalCounts.pending} accepted: ${proposalCounts.accepted} rejected: ${proposalCounts.rejected}`
      : "- unknown",
    "",
    "드래프트:",
    draftCounts ? `- drafted: ${draftCounts.drafted} approved: ${draftCounts.approved} discarded: ${draftCounts.discarded}` : "- unknown",
    "",
    "액션:",
    actionCounts
      ? `- pending: ${actionCounts.pending} waiting: ${actionCounts.waiting} approved: ${actionCounts.approved} running: ${actionCounts.running} failed: ${actionCounts.failed}`
      : "- unknown",
    "",
    "Runs:",
    `- total: ${input.runs.length}`,
    `- non-passing: ${failureCount}`,
    latest ? `- latest: ${oneLine(runLine(latest).slice(2))}` : "- latest: 없음",
    latest ? `- lifecycle: ${lifecycleText(latestLifecycle)}` : "",
    "",
    ...compactRankingLines(ceoRankingSnapshot),
    ...budgetAuditLines({
      records: input.budgetObservations,
      policies: input.budgetPolicies,
      decisions: input.decisions,
      governanceEvents: input.governanceEvents,
      projectId: input.projectId,
    }),
    "",
    ...formatProjectQueueSnapshot(projectQueues),
  ]
    .filter(Boolean)
    .join("\n");
}

export function healthReport(health: DaemonHealthResult): string {
  const lines = [
    "# health:check",
    "",
    `정상: ${health.ok ? "yes" : "no"}`,
    health.ageMs !== undefined ? `Heartbeat age: ${health.ageMs}ms` : "",
    health.heartbeat
      ? `Heartbeat: ${code(`${health.heartbeat.status} pid=${health.heartbeat.pid} updated=${health.heartbeat.updatedAt}`)}`
      : "Heartbeat: missing",
    health.lock ? `Lock: ${code(`pid=${health.lock.pid} started=${health.lock.startedAt}`)}` : "Lock: missing",
    "",
    "위반 사항:",
    ...(health.violations.length ? health.violations.map((violation) => `- ${oneLine(violation)}`) : ["- 없음"]),
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export function doctorReport(snapshot: OpsSnapshot, options: { pressure?: QueuePressureSnapshot } = {}): string {
  const serviceTemplates = snapshot.serviceTemplates ?? {
    provider: "systemd" as const,
    directory: snapshot.systemd.directory,
    files: snapshot.systemd.files,
  };
  const serviceTemplateLines =
    snapshot.serviceTemplates || snapshot.systemd.checked
      ? serviceTemplates.files.map((file) => `- ${file.file}: ${file.installed ? "installed" : "missing"}`)
      : [`- skipped (${snapshot.systemd.platform} host)`];
  return [
    "# ops:doctor",
    "",
    `전체 상태: ${snapshot.ok ? "정상" : "확인 필요"}`,
    `확인 시각: ${code(snapshot.checkedAt)}`,
    "",
    "Host ownership:",
    `- state: ${snapshot.hostOwnership.state}`,
    `- automation allowed: ${snapshot.hostOwnership.automationAllowed ? "yes" : "no"}`,
    `- current host id: ${code(snapshot.hostOwnership.currentHostId)}`,
    `- record: ${code(snapshot.hostOwnership.path)}`,
    snapshot.hostOwnership.record
      ? `- owner: role=${code(snapshot.hostOwnership.record.role)} host=${code(snapshot.hostOwnership.record.hostId)} updated=${code(snapshot.hostOwnership.record.updatedAt)} expires=${code(snapshot.hostOwnership.record.expiresAt ?? "none")}`
      : "- owner: missing",
    `- reason: ${oneLine(snapshot.hostOwnership.reason)}`,
    "",
    "환경:",
    `- .env file: ${snapshot.env.envFileExists ? "있음" : "없음"} (${code(snapshot.env.envFilePath)})`,
    `- TELEGRAM_BOT_TOKEN: ${snapshot.env.hasBotToken ? "있음" : "없음"}`,
    `- poll chat id: ${snapshot.env.hasPollChatId ? "있음" : "없음"}`,
    `- reply chat id: ${snapshot.env.hasReplyChatId ? "있음" : "없음"}`,
    `- codex executable: ${snapshot.env.hasCodexExecutable ? "사용 가능" : "없음"} (${code(snapshot.env.codexCommand ?? "codex")})`,
    "",
    "Daemon:",
    `- health: ${snapshot.health.ok ? "ok" : "failed"}`,
    snapshot.health.ageMs !== undefined ? `- heartbeat age: ${snapshot.health.ageMs}ms` : "- heartbeat age: unknown",
    snapshot.health.heartbeat
      ? `- heartbeat: ${code(`${snapshot.health.heartbeat.status} pid=${snapshot.health.heartbeat.pid} updated=${snapshot.health.heartbeat.updatedAt}`)}`
      : "- heartbeat: missing",
    "",
    "Issues:",
    ...(snapshot.issues.length
      ? snapshot.issues.map(
          (issue) =>
            `- ${issue.severity} ${issue.area}: ${oneLine(redactDiagnosticValue(issue.message))} | next: ${oneLine(redactDiagnosticValue(issue.action))}`,
        )
      : ["- 없음"]),
    "",
    ...(options.pressure
      ? [
          ...formatQueuePressureSnapshot(options.pressure),
          ...formatQueuePressureGuidance(options.pressure),
        ]
      : []),
    "",
    "큐:",
    `- pending inbox: ${snapshot.queues.pendingInboxCount}`,
    snapshot.queues.oldestPendingInbox
      ? `- oldest inbox: ${code(snapshot.queues.oldestPendingInbox.file)} age=${snapshot.queues.oldestPendingInboxAgeMs ?? "unknown"}ms`
      : "- oldest inbox: 없음",
    `- outbox reports: ${snapshot.queues.outboxCount}`,
    `- remote outbox reports: ${snapshot.queues.remoteOutboxCount}`,
    `- unsent remote outbox reports: ${snapshot.queues.unsentRemoteOutboxCount}`,
    snapshot.queues.latestRemoteCommand
      ? `- 최근 원격 명령: type=${code(snapshot.queues.latestRemoteCommand.type ?? "unknown")} id=${code(snapshot.queues.latestRemoteCommand.id ?? snapshot.queues.latestRemoteCommand.file)} received=${code(snapshot.queues.latestRemoteCommand.receivedAt ?? "unknown")}`
      : "- 최근 원격 명령: 없음",
    snapshot.queues.latestRemoteOutbox
      ? `- 최근 원격 리포트: ${code(snapshot.queues.latestRemoteOutbox.file)} updated=${code(snapshot.queues.latestRemoteOutbox.updatedAt)}`
      : "- 최근 원격 리포트: 없음",
    "",
    "Telegram state:",
    snapshot.telegram.offset?.nextOffset !== undefined
      ? `- next offset: ${snapshot.telegram.offset.nextOffset}`
      : "- next offset: missing",
    snapshot.telegram.replyState
      ? `- replies: sent=${snapshot.telegram.replyState.sentFiles.length} failures=${snapshot.telegram.replyState.failures?.length ?? 0} updated=${code(snapshot.telegram.replyState.updatedAt)}`
      : "- replies: missing",
    `- 최근 reply 실패: ${oneLine(latestReplyFailure(snapshot))}`,
    "",
    "service templates:",
    `- provider: ${serviceTemplates.provider}`,
    `- directory: ${code(serviceTemplates.directory)}`,
    ...serviceTemplateLines,
    "",
    "Failures:",
    ...(snapshot.failures.length ? snapshot.failures.map((failure) => `- ${oneLine(failure)}`) : ["- 없음"]),
    "",
    "Warnings:",
    ...(snapshot.warnings.length ? snapshot.warnings.map((warning) => `- ${oneLine(warning)}`) : ["- 없음"]),
  ].join("\n");
}
