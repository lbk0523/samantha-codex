import type { TaskSpec } from "./contracts";
import type { CeoStatusSnapshot } from "./ceo-status";
import type { DaemonHealthResult, DaemonHeartbeat } from "./daemon";
import type { RunSummary } from "./ledger";
import { buildOperatingSurfaceView } from "./operating-surface";
import type { OpsSnapshot } from "./ops-diagnostics";
import { blockerForPlan, payloadBlockerForPlan, type OrchestratorPlanBlocker } from "./orchestrator-blockers";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord, OrchestratorSynthesisPayload } from "./orchestrator-store";
import { classifyRemoteRequest, type ProjectProfile, type ProjectRemoteScope, type RemoteRequestClassification } from "./project-profile";
import type { ProposalRecord } from "./proposal-store";
import { remoteActionCommand, type RemoteActionRecord } from "./remote-action-store";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { WorkerRunLog } from "./run-log";
import type { TaskDraftRecord } from "./task-draft-store";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const telegramCommandReplacements: Array<[RegExp, string]> = [
  [/\/help_advanced\b/g, "/help"],
  [/\/help advanced\b/g, "/help"],
  [/\/(?:next_action|next-action|runs|run_latest|run_next|run-next|tasks|task|actions|action_current|action|proposals|proposal_next|proposal|drafts|draft_next)\b/g, "/now"],
  [/\/run\b/g, "/now"],
  [/\/(?:status|dashboard)\b/g, "/check"],
  [/\/(?:doctor|health|failures)\b/g, "/problems"],
  [/\/(?:accept|draft_approve|draft-approve|yes|prepare_dispatch|prepare-dispatch|approve_action|approve-action)\b/g, "/go"],
  [/\/reject\b/g, "/cancel"],
  [/\/(?:draft_prepare|draft-prepare)\b/g, "/plan"],
  [/\/(?:propose|draft_propose|draft-propose|draft)\b/g, "/work <요청>"],
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

function code(value: string): string {
  return `\`${oneLine(value).replace(/`/g, "'")}\``;
}

function recent<T>(items: T[], limit: number): T[] {
  return [...items].slice(-limit).reverse();
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
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

function lifecycleText(lifecycle: RunLifecycleRecord | undefined): string {
  if (!lifecycle) return "missing";
  return `merged=${lifecycle.mergedAt ? "yes" : "no"} pushed=${lifecycle.pushedAt ? "yes" : "no"} cleaned=${lifecycle.cleanedAt ? "yes" : "no"}`;
}

function resultModeLabel(mode: string | undefined): string {
  return mode === "report" ? "계획/보고" : "구현/수정";
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

function agentRoleLabel(agentId: string | undefined): string {
  if (agentId === "codex-reviewer") return "Reviewer";
  if (agentId === "codex-evaluator") return "Evaluator";
  if (agentId === "codex-spec") return "Spec";
  if (agentId === "codex-researcher") return "Researcher";
  if (agentId === "codex-content") return "Content";
  if (agentId === "codex-operations") return "Operations";
  if (agentId === "codex-worker") return "Writer";
  return "Agent";
}

function roleOutcomeLine(input: { agentId?: string; title: string; mode?: string; outcome: string }): string {
  return `- ${agentRoleLabel(input.agentId)}: ${oneLine(input.title)}: ${input.outcome} (${resultModeLabel(input.mode)})`;
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

function repoName(repoRoot: string | undefined): string {
  const normalized = oneLine(repoRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? "unknown";
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
    return "작업 유형: 계획/보고 - 커밋 없음 정상";
  }
  if (input.mergeCommands.length > 0) return "작업 유형: 구현/수정 - merge 필요";
  if (input.needsRecovery) return "작업 유형: 구현/수정 - 복구 필요";
  return "작업 유형: 구현/수정";
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
  if (request.status === "pending_plan") return ["", "다음 액션:", `- 텔레그램: ${code("/plan")}`, `- 요청 취소: ${code("/cancel")}`];
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
  return `${failure.file} attempts=${failure.attempts} error=${failure.lastError}`;
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
    "- `/go`: 계획 승인, worker 실행 큐 등록, 또는 최신 성공 run 통합 gate 진행",
    "- `/revise <피드백>`: 현재 계획을 수정 요청",
    "- `/cancel`: 승인 전 계획/요청 취소",
    "- `/recover`: 실패한 계획 결과로 복구 계획 요청 생성",
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
  proposals?: ProposalRecord[];
  drafts?: TaskDraftRecord[];
  orchestrationRequests?: OrchestrationRequestRecord[];
  orchestratorPlans?: OrchestratorPlanRecord[];
  orchestratorPlanBlockers?: OrchestratorPlanBlocker[];
  ops?: OpsSnapshot;
  lifecycles?: RunLifecycleRecord[];
}): string {
  const latestByStatus = (status: RemoteActionRecord["status"]) =>
    input.actions.slice().reverse().find((action) => action.status === status);
  const running = latestByStatus("running");
  if (running) {
    return [
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
    return nowLinesForPassedRun(
      pendingIntegrationRun,
      input.lifecycles?.find((record) => record.runId === pendingIntegrationRun.runId),
    ).join("\n");
  }

  const recoverable = latestRecoverablePlan({
    actions: input.actions,
    orchestratorPlans: input.orchestratorPlans,
    minResultReportedAt: primaryWorkflowTimestamp,
  });
  if (recoverable) {
    return [
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
    return ["# now", "", "운영 상태 확인이 필요합니다.", oneLine(issue), "", "다음 액션:", `- 텔레그램: ${code("/problems")}`].join("\n");
  }

  const pendingTask = activeTasks.find((task) => task.status === "pending");
  if (pendingTask) {
    return [
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
    return nowLinesForPassedRun(
      latest,
      input.lifecycles?.find((record) => record.runId === latest.runId),
    ).join("\n");
  }

  if (latest && !latest.pass && timestamp(latest.finishedAt) >= primaryWorkflowTimestamp && !archivedTaskIds.has(latest.taskId)) {
    return [
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

  return ["# now", "", "지금 바로 필요한 원격 액션은 없습니다.", "", "다음 액션:", `- 텔레그램: ${code("/check")}`].join("\n");
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
  const nextCommand = view.primaryAction.telegramCommand ?? "/check";
  const canApproveDecision = nextCommand === "/approve";
  const risks = snapshot.risks.slice(0, 3).map(remoteNotificationText);
  const lines = [
    "# ceo-notify",
    "",
    `상태: ${snapshot.overall}`,
    `핵심: ${remoteNotificationText(view.headline)}`,
    `요약: ${view.summary}`,
    decision ? `결정 필요: ${remoteNotificationText(decision.title)}` : "",
    decision ? `이유: ${remoteNotificationText(decision.reason)}` : "",
    "",
    "다음 액션:",
    `- 텔레그램: ${code(nextCommand)}`,
    decision && canApproveDecision ? `- 수정 필요 시: ${code("/revise <피드백>")}` : "",
    decision ? `- 취소: ${code("/cancel")}` : "",
    snapshot.blocked.length ? `- 현재 블로커: ${remoteNotificationText(snapshot.blocked[0]?.title ?? "확인 필요")}` : "",
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
  const reportOnly = input.runLogs.length > 0 && input.runLogs.every((runLog) => runLog.task.resultMode === "report");
  const outcome = needsRecovery
    ? verificationFailed
      ? "검증 실패 - 복구 필요"
      : "복구 필요"
    : reportOnly
      ? "보고 완료"
      : "구현 통과";
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
      return [
        roleOutcomeLine({
          agentId: runLog?.agent.id ?? action.targetAgent,
          title: action.taskTitle,
          mode: runLog?.task.resultMode,
          outcome: actionOutcome,
        }),
        `  대상: ${repoName(runLog?.input.repoRoot ?? action.repoRoot)} / ${resultModeLabel(runLog?.task.resultMode)}`,
        runLog ? `  보고: ${oneLine(workerFinalMessage(runLog))}` : "",
        action.result?.failure ? `  실패 이유: ${telegramSafeLine(action.result.failure)}` : "",
      ].filter(Boolean);
    }),
    "",
    "산출/변경:",
    ...(changedFiles.length ? changedFiles.slice(0, 8).map((file) => `- ${code(displayFilePath(file))}`) : ["- 없음"]),
    changedFiles.length > 8 ? `- 외 ${changedFiles.length - 8}개` : "",
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
    scope ? `위험도: ${scope.risk}${input.inferredScope ? " (자동 선택)" : ""}` : "위험도: unknown",
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

export function statusReport(input: {
  runs: RunSummary[];
  heartbeat?: DaemonHeartbeat;
  pendingInboxCount: number;
  ops?: OpsSnapshot;
  proposals?: ProposalRecord[];
  drafts?: TaskDraftRecord[];
  actions?: RemoteActionRecord[];
  lifecycles?: RunLifecycleRecord[];
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
  const heartbeat = input.heartbeat
    ? `${input.heartbeat.status} pid=${input.heartbeat.pid} updated=${input.heartbeat.updatedAt} processed=${input.heartbeat.processedTotal}`
    : "missing";

  return [
    "# status",
    "",
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

export function doctorReport(snapshot: OpsSnapshot): string {
  const systemdLines = snapshot.systemd.files.map(
    (file) => `- ${file.file}: ${file.installed ? "installed" : "missing"}`,
  );
  return [
    "# ops:doctor",
    "",
    `전체 상태: ${snapshot.ok ? "정상" : "확인 필요"}`,
    `확인 시각: ${code(snapshot.checkedAt)}`,
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
    "큐:",
    `- pending inbox: ${snapshot.queues.pendingInboxCount}`,
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
    "systemd templates:",
    ...systemdLines,
    "",
    "Failures:",
    ...(snapshot.failures.length ? snapshot.failures.map((failure) => `- ${oneLine(failure)}`) : ["- 없음"]),
    "",
    "Warnings:",
    ...(snapshot.warnings.length ? snapshot.warnings.map((warning) => `- ${oneLine(warning)}`) : ["- 없음"]),
  ].join("\n");
}
