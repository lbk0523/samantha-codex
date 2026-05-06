import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import {
  nowReport,
  orchestrationRequestAddedReport,
  orchestratorGoMaterializedReport,
  orchestratorPlanReport,
  orchestratorPlanResultReport,
  remoteActionPreparedReport,
  remoteActionResultReport,
  remoteHelpReport,
} from "../src/lib/operator-reports";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import { commandFromRemoteInput } from "../src/lib/remote-command";
import { createRemoteDispatchAction, type RemoteActionRecord } from "../src/lib/remote-action-store";
import type { WorkerRunLog } from "../src/lib/run-log";
import { compactTelegramReport, telegramReplyMessages } from "../src/lib/telegram-reply-adapter";

const visibleTelegramCommands = [
  "/start",
  "/help",
  "/now",
  "/work",
  "/plan",
  "/plan_current",
  "/revise",
  "/cancel",
  "/go",
  "/recover",
  "/check",
  "/problems",
];

const deprecatedTelegramCommands = [
  "/help_advanced",
  "/next_action",
  "/next-action",
  "/status",
  "/doctor",
  "/health",
  "/dashboard",
  "/runs",
  "/run",
  "/run_latest",
  "/failures",
  "/proposals",
  "/proposal",
  "/proposal_next",
  "/propose",
  "/accept",
  "/reject",
  "/drafts",
  "/draft",
  "/draft_next",
  "/draft_prepare",
  "/draft-prepare",
  "/draft_approve",
  "/draft-approve",
  "/draft_propose",
  "/draft-propose",
  "/tasks",
  "/task",
  "/actions",
  "/action",
  "/run_next",
  "/run-next",
  "/yes",
  "/action_current",
  "/prepare_dispatch",
  "/prepare-dispatch",
  "/approve_action",
  "/approve-action",
];

const deprecatedCommandFixtures = [
  ["/help_advanced", "/help"],
  ["/next-action", "/now"],
  ["/draft_prepare omht", "/plan"],
  ["/draft-approve", "/go"],
  ["/prepare_dispatch task-1", "/go"],
  ["/approve-action action-1", "/go"],
] as const;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertDoesNotContainAny(name: string, text: string, values: string[]): void {
  for (const value of values) {
    assert(!text.includes(value), `${name} must not contain ${value}`);
  }
}

function assertNoHyphenCommands(name: string, text: string): void {
  const match = text.match(/\/[a-z][a-z0-9_]*-[a-z0-9_-]*/i);
  assert(!match, `${name} exposes a hyphenated Telegram command: ${match?.[0]}`);
}

function assertNoInternalIds(name: string, text: string): void {
  const internalIdPattern = /\b(?:request|plan|action|draft|proposal|run|task)-[a-z0-9][a-z0-9-]{4,}\b/i;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("# ")) continue;
    const match = line.match(internalIdPattern);
    assert(!match, `${name} exposes an internal id in Telegram text: ${match?.[0]}`);
  }
}

function compactedTelegramText(name: string, report: string): string {
  const compacted = compactTelegramReport(report);
  const messages = telegramReplyMessages(`${name}.md`, report);
  assert(messages.every((message) => message.length <= 3900), `${name} exceeds Telegram hard message limit`);
  assert(compacted.length <= 1800, `${name} compacted Telegram report is too long: ${compacted.length} chars`);
  return compacted;
}

const task: TaskSpec = {
  id: "task-telegram-ux-review",
  title: "Improve Telegram UX",
  targetAgent: "codex-worker",
  projectId: "samantha",
  repoRoot: "/repo/samantha",
  targetFiles: ["src/lib/operator-reports.ts"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun test"],
  instructions: "Keep Telegram operator reports compact and action-oriented.",
  status: "pending",
};

const agent: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: { requiredBundles: [], blockedSkills: [] },
};

const request: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-20260506-090000-work-abc12345",
  source: "remote",
  senderId: "bk",
  text: "Telegram 원격 업무 흐름을 더 짧고 명확하게 정리",
  status: "pending_plan",
  createdAt: "2026-05-06T09:00:00.000Z",
};

const plan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-20260506-090100-work-def67890",
  requestId: request.id,
  status: "planned",
  createdAt: "2026-05-06T09:01:00.000Z",
  payload: {
    summary: "Telegram workflow UX cleanup",
    assumptions: ["현재 Telegram은 의사 결정 UI로만 사용한다."],
    questions: [],
    scope: ["명령어 안내", "다음 액션 메시지"],
    nonScope: ["worker 자동 실행 확대"],
    risks: ["구 명령어가 다시 노출될 수 있음"],
    tasks: [
      {
        id: "task-proposal-telegram-ux-review",
        title: task.title,
        targetAgent: task.targetAgent,
        projectId: task.projectId,
        repoRoot: task.repoRoot,
        resultMode: "write",
        targetFiles: task.targetFiles,
        forbiddenChanges: task.forbiddenChanges,
        verifyCommands: task.verifyCommands,
        instructions: task.instructions,
        dependencies: [],
      },
    ],
    batches: [["task-proposal-telegram-ux-review"]],
    userMessage: "Telegram에서 다음에 무엇을 해야 하는지만 보이도록 정리합니다.",
  },
};

const action = createRemoteDispatchAction({
  task,
  repoRoot: "/repo/samantha",
  createdAt: "2026-05-06T09:02:00.000Z",
  source: "remote",
  commandId: "remote-go",
  orchestratorPlanId: plan.id,
});

const completedAction: RemoteActionRecord = {
  ...action,
  status: "completed",
  approvedAt: "2026-05-06T09:02:10.000Z",
  startedAt: "2026-05-06T09:02:20.000Z",
  completedAt: "2026-05-06T09:03:00.000Z",
  result: {
    runId: "run-20260506-090220-telegram-ux",
    runLogPath: "/repo/samantha/runs/run-20260506-090220-telegram-ux.json",
    pass: true,
    outcome: "pass",
  },
};

const runLog: WorkerRunLog = {
  schemaVersion: 1,
  runId: completedAction.result?.runId ?? "run-telegram-ux",
  startedAt: "2026-05-06T09:02:20.000Z",
  finishedAt: "2026-05-06T09:03:00.000Z",
  task,
  agent,
  input: { repoRoot: "/repo/samantha", allocate: true, execute: true },
  result: {
    preparation: {
      taskId: task.id,
      agentId: agent.id,
      worktreePath: "/worktree",
      codex: { prompt: "prompt", command: ["codex", "exec"] },
    },
    setupResults: [],
    command: {
      command: ["codex", "exec"],
      exitCode: 0,
      stdout: `${JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Telegram 보고 메시지를 짧게 정리했습니다.\n\nHARNESS_RESULT: {\"status\":\"pass\",\"note\":\"done\",\"commit\":\"\"}",
        },
      })}\n`,
      stderr: "",
    },
    evaluation: {
      pass: true,
      harness: { status: "pass", note: "done", commit: "" },
      changedFiles: ["src/lib/operator-reports.ts"],
      scopeViolations: [],
      verifyResults: [{ command: "bun test", exitCode: 0, stdout: "", stderr: "" }],
    },
    commit: {
      subject: "fix: keep Telegram reports compact",
      files: ["src/lib/operator-reports.ts"],
      add: { command: ["git", "add", "src/lib/operator-reports.ts"], exitCode: 0, stdout: "", stderr: "" },
      commit: { command: ["git", "commit", "-m", "fix: keep Telegram reports compact"], exitCode: 0, stdout: "", stderr: "" },
      commitHash: "abc123def456",
    },
    pass: true,
  },
};

function checkCommandSurface(): void {
  const help = remoteHelpReport();
  for (const command of visibleTelegramCommands.filter((command) => command !== "/start" && command !== "/help")) {
    assert(help.includes(command), `remote help must include ${command}`);
  }
  assertDoesNotContainAny("remote help", help, deprecatedTelegramCommands);
  assertNoHyphenCommands("remote help", help);

  for (const [text, replacement] of deprecatedCommandFixtures) {
    const command = commandFromRemoteInput({ senderId: "bk", text }, "bk");
    assert(command.type === "remote:deprecated", `${text} must be deprecated`);
    assert(command.args?.replacement === replacement, `${text} replacement must be ${replacement}`);
  }
}

function checkTelegramReports(): void {
  const reports = [
    ["work request", orchestrationRequestAddedReport(request)],
    ["plan report", orchestratorPlanReport({ request: { ...request, status: "planned", plannedAt: plan.createdAt }, plan })],
    ["go materialized", orchestratorGoMaterializedReport({ plan: { ...plan, status: "materialized" }, tasks: [task], actions: [action] })],
    [
      "plan result",
      orchestratorPlanResultReport({
        plan: { ...plan, status: "materialized", actionIds: [completedAction.id] },
        actions: [completedAction],
        runLogs: [runLog],
        synthesis: {
          outcome: "pass",
          summary: "통과",
          nextActions: ["텔레그램: /run_latest"],
          risks: [],
          userMessage: "작업이 완료됐습니다.",
        },
      }),
    ],
    ["prepared action", remoteActionPreparedReport(action)],
    ["action result", remoteActionResultReport({ action: completedAction, runLog })],
    ["now", nowReport({ runs: [], tasks: [], actions: [], orchestratorPlans: [plan] })],
  ] as const;

  for (const [name, report] of reports) {
    const compacted = compactedTelegramText(name, report);
    assert(compacted.includes("다음 액션:"), `${name} must include next action guidance`);
    assertDoesNotContainAny(name, compacted, deprecatedTelegramCommands);
    assertNoHyphenCommands(name, compacted);
    assertNoInternalIds(name, compacted);
  }
}

checkCommandSurface();
checkTelegramReports();

console.log("telegram ux checks passed");
