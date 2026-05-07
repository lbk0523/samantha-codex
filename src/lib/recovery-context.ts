import type { RemoteActionArtifactPreview } from "./operator-reports";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "./orchestrator-store";
import type { RemoteActionRecord } from "./remote-action-store";
import type { WorkerRunLog } from "./run-log";

export interface RecoveryContextInput {
  plan: OrchestratorPlanRecord;
  actions: RemoteActionRecord[];
  failedActions: RemoteActionRecord[];
  request?: OrchestrationRequestRecord;
  runLogs: WorkerRunLog[];
  artifactPreviews: RemoteActionArtifactPreview[];
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(text: string, maxLength = 4000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}\n\n...[truncated]`;
}

function bulletLines(title: string, values: string[], empty: string): string[] {
  return [title, ...(values.length ? values.map((value) => `- ${value}`) : [`- ${empty}`])];
}

export function buildRecoveryRequestText(input: RecoveryContextInput): string {
  const plan = input.plan;
  const failedActions = input.failedActions.length ? input.failedActions : input.actions.filter((action) => action.status === "failed" || action.result?.pass === false);
  const runLogForAction = (action: RemoteActionRecord) =>
    input.runLogs.find((log) => log.runId === action.result?.runId || log.task.id === action.taskId);
  const changedFiles = Array.from(
    new Set(
      failedActions.flatMap((action) => {
        const runLog = runLogForAction(action);
        return runLog?.result.evaluation?.changedFiles ?? runLog?.result.commit?.files ?? [];
      }),
    ),
  );
  const runLogPaths = Array.from(new Set(failedActions.flatMap((action) => action.result?.runLogPath ? [action.result.runLogPath] : [])));
  const verifyFailures = failedActions.flatMap((action) => {
    const runLog = runLogForAction(action);
    return runLog?.result.evaluation?.verifyResults
      .filter((result) => result.exitCode !== 0)
      .map((result) => `${action.taskTitle}: ${result.command} exited ${result.exitCode}${result.stderr ? ` stderr=${compactLine(result.stderr)}` : ""}`) ?? [];
  });
  const planTasks = plan.payload?.tasks ?? [];

  const lines = [
    "복구 계획 요청입니다.",
    "",
    `실패한 계획: ${plan.id}`,
    `원 요청 ID: ${plan.requestId}`,
    input.request?.text ? `원 요청: ${compactLine(input.request.text)}` : "",
    plan.payload?.summary ? `원 계획 요약: ${compactLine(plan.payload.summary)}` : "",
    plan.synthesis?.summary ? `결과 종합: ${compactLine(plan.synthesis.summary)}` : "",
    plan.synthesis?.userMessage ? `결과 메시지: ${compactLine(plan.synthesis.userMessage)}` : "",
    "",
    ...bulletLines("원 계획 범위:", plan.payload?.scope ?? [], "없음"),
    ...bulletLines("원 계획 제외 범위:", plan.payload?.nonScope ?? [], "없음"),
    ...bulletLines("원 계획 리스크:", plan.payload?.risks ?? [], "없음"),
    "",
    "원 계획 작업:",
    ...(planTasks.length
      ? planTasks.map((task) =>
          `- ${task.title}: agent=${task.targetAgent} mode=${task.resultMode ?? "write"} project=${task.projectId ?? "unknown"} repoRoot=${task.repoRoot || "(project profile canonical root)"}`
        )
      : ["- 원 계획 task payload 없음"]),
    "",
    "실패 action:",
    ...(failedActions.length
      ? failedActions.flatMap((action) => {
          const runLog = runLogForAction(action);
          const actionFiles = runLog?.result.evaluation?.changedFiles ?? runLog?.result.commit?.files ?? [];
          return [
            `- ${action.taskTitle}: status=${action.status} outcome=${action.result?.outcome ?? "unknown"} agent=${action.targetAgent}`,
            `  canonical action repoRoot: ${action.repoRoot}`,
            runLog?.input.repoRoot ? `  run input repoRoot: ${runLog.input.repoRoot}` : "",
            runLog?.result.preparation.worktreePath ? `  worker worktree evidence path: ${runLog.result.preparation.worktreePath}` : "",
            action.result?.failure ? `  실패 이유: ${compactLine(action.result.failure)}` : "",
            runLog?.result.evaluation?.harness?.note ? `  harness note: ${compactLine(runLog.result.evaluation.harness.note)}` : "",
            actionFiles.length ? `  관련 변경/산출: ${actionFiles.map(compactLine).join(", ")}` : "",
            action.result?.runLogPath ? `  run log: ${action.result.runLogPath}` : "",
          ].filter(Boolean);
        })
      : ["- action 자체 실패는 없지만 오케스트레이터 종합 결과가 복구 필요 상태입니다."]),
    "",
    ...bulletLines("검증 실패:", verifyFailures, "실패 action에서 실패한 verify command를 찾지 못했습니다."),
    "",
    "관련 변경/산출:",
    ...(changedFiles.length ? changedFiles.slice(0, 12).map((file) => `- ${file}`) : ["- 실패 action에서 변경 파일을 찾지 못했습니다. run log를 참고하세요."]),
    changedFiles.length > 12 ? `- 외 ${changedFiles.length - 12}개` : "",
    "",
    "Run log 참고:",
    ...(runLogPaths.length ? runLogPaths.map((path) => `- ${path}`) : ["- 없음"]),
    input.artifactPreviews.length ? "" : "",
    ...(input.artifactPreviews.length
      ? [
          "산출물 미리보기:",
          ...input.artifactPreviews.slice(0, 2).flatMap((preview) => [
            `파일: ${preview.file}`,
            clipText(preview.text, 800),
          ]),
        ]
      : []),
    "",
    "복구 판단 기준:",
    "- 새 복구 계획 결과 보고서는 원래 실패 원인이 해결됐는지 명시해야 합니다.",
    "- 원래 실패 verify command나 실패 이유가 남아 있으면 fixed라고 보고하지 마세요.",
    "",
    "요청:",
    "위 실패 원인을 먼저 재검토하고, 무작정 retry하지 말고 복구 계획을 제안하세요.",
    "복구 task는 project profile의 canonical repoRoot에서 시작해야 합니다.",
    "실패 run log나 worker worktree path를 repoRoot로 복사하지 마세요.",
    "repoRoot가 불확실하면 비워 두고 projectId를 맞춰 materializer가 profile 기본값을 쓰게 하세요.",
    "필요하면 원인 확인용 report task를 먼저 두고, 수정/검증 task는 의존 관계로 분리하세요.",
  ];

  return clipText(lines.filter((line) => line !== "").join("\n"), 4000);
}
