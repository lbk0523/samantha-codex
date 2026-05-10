import { describe, expect, test } from "bun:test";
import { createCostBudgetAuditRecord } from "../src/lib/cost-budget-audit";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import type { DaemonHealthResult, DaemonHeartbeat } from "../src/lib/daemon";
import { createDecisionItem } from "../src/lib/decision-store";
import type { RunSummary } from "../src/lib/ledger";
import {
  ceoNotificationReport,
  doctorReport,
  draftProposeAddedReport,
  failuresReport,
  healthReport,
  nowReport,
  nextActionReport,
  orchestrationRequestAddedReport,
  orchestratorCancelReport,
  orchestratorGoBlockedReport,
  orchestratorGoMaterializedReport,
  orchestratorPlanResultReport,
  orchestratorPlanReport,
  orchestratorRecoveryRequestReport,
  orchestratorRevisionRequestReport,
  proposalAddedReport,
  proposalsListReport,
  proposalReviewedReport,
  proposalShowReport,
  remoteActionApprovedReport,
  remoteActionPreparedReport,
  remoteActionResultReport,
  remoteActionShowReport,
  remoteActionsListReport,
  remoteApprovalRedirectReport,
  remoteDeprecatedCommandReport,
  remoteDecisionApprovedReport,
  remoteDecisionRejectedReport,
  remoteGoNoActionablePlanReport,
  remoteHelpReport,
  remoteIntegrationReport,
  remoteGoReport,
  runsListReport,
  runShowReport,
  statusReport,
  taskDraftAddedReport,
  taskDraftApprovalBlockedReport,
  taskDraftApprovedReport,
  taskDraftPrepareBlockedReport,
  taskDraftPreparedReport,
  taskDraftPlanReport,
  taskDraftShowReport,
  taskDraftsListReport,
  tasksListReport,
  taskShowReport,
} from "../src/lib/operator-reports";
import type { OpsSnapshot } from "../src/lib/ops-diagnostics";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "../src/lib/orchestrator-store";
import type { ProposalRecord } from "../src/lib/proposal-store";
import { createRemoteDispatchAction } from "../src/lib/remote-action-store";
import type { RunLifecycleRecord } from "../src/lib/run-lifecycle-store";
import type { WorkerRunLog } from "../src/lib/run-log";
import type { TaskDraftRecord } from "../src/lib/task-draft-store";

const passRun: RunSummary = {
  schemaVersion: 1,
  runId: "run-pass",
  taskId: "task-pass",
  taskTitle: "Pass task",
  agentId: "codex-worker",
  repoRoot: "/repo",
  worktreePath: "/worktree",
  logPath: "/logs/pass.json",
  startedAt: "2026-05-03T10:00:00.000Z",
  finishedAt: "2026-05-03T10:01:00.000Z",
  outcome: "pass",
  pass: true,
  commit: "abcdef1234567890",
};

const failRun: RunSummary = {
  ...passRun,
  runId: "run-fail",
  taskId: "task-fail",
  taskTitle: "Fail task",
  logPath: "/logs/fail.json",
  outcome: "verify_failed",
  pass: false,
  commit: "",
  failureReason: "verify command failed",
};

const lifecycle: RunLifecycleRecord = {
  schemaVersion: 1,
  runId: "run-pass",
  taskId: "task-pass",
  repoRoot: "/repo",
  runLogPath: "/logs/pass.json",
  commit: "abcdef1234567890",
  updatedAt: "2026-05-03T10:02:00.000Z",
};

const heartbeat: DaemonHeartbeat = {
  schemaVersion: 1,
  pid: 123,
  command: "inbox:watch",
  status: "running",
  lockPath: "/state/daemon.lock",
  inboxDir: "/inbox",
  outboxDir: "/outbox",
  archiveDir: "/archive",
  processedTotal: 4,
  updatedAt: "2026-05-03T10:02:00.000Z",
};

const task: TaskSpec = {
  id: "task-pass",
  title: "Pass task",
  targetAgent: "codex-worker",
  targetFiles: ["allowed.txt"],
  forbiddenChanges: ["state/**"],
  verifyCommands: ["bun test"],
  instructions: "Fixture.",
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

const proposal: ProposalRecord = {
  schemaVersion: 1,
  id: "proposal-1",
  text: "Improve status reports",
  source: "remote",
  senderId: "bk",
  status: "pending_review",
  createdAt: "2026-05-03T10:00:00.000Z",
};

const draft: TaskDraftRecord = {
  schemaVersion: 1,
  id: "draft-1",
  sourceProposalId: "proposal-1",
  status: "drafted",
  title: "Improve status reports",
  targetAgent: "codex-worker",
  targetFiles: [],
  forbiddenChanges: [],
  verifyCommands: [],
  instructions: "Improve status reports",
  createdAt: "2026-05-03T10:04:00.000Z",
};

const orchestrationRequest: OrchestrationRequestRecord = {
  schemaVersion: 1,
  id: "request-1",
  source: "remote",
  senderId: "bk",
  text: "사만다 Telegram 작업 흐름 개선",
  status: "pending_plan",
  createdAt: "2026-05-05T10:00:00.000Z",
};

const orchestratorPlan: OrchestratorPlanRecord = {
  schemaVersion: 1,
  id: "plan-1",
  requestId: "request-1",
  status: "planned",
  createdAt: "2026-05-05T10:01:00.000Z",
  payload: {
    summary: "Telegram orchestration flow",
    assumptions: [],
    questions: [],
    scope: ["계획 생성"],
    nonScope: ["worker 배정"],
    risks: ["materialization 미구현"],
    tasks: [
      {
        id: "task-proposal-1",
        title: "Implement planning flow",
        targetAgent: "codex-worker",
        projectId: "samantha",
        repoRoot: "/repo/samantha",
        resultMode: "write",
        targetFiles: ["src/samantha.ts"],
        forbiddenChanges: ["state/**"],
        setupCommands: [],
        verifyCommands: ["bun test"],
        instructions: "Implement planning flow.",
        dependencies: [],
      },
    ],
    batches: [["task-proposal-1"]],
    userMessage: "오케스트레이터 계획을 만들었습니다.",
  },
};

describe("operator reports", () => {
  test("documents safe-gated remote commands", () => {
    const report = remoteHelpReport();

    expect(report).toContain("/now");
    expect(report).toContain("/work <요청>");
    expect(report).toContain("/plan");
    expect(report).toContain("/approve");
    expect(report).toContain("/go");
    expect(report).not.toContain("/help_advanced");
    expect(report).not.toContain("/action_current");
    expect(report).not.toContain("/draft_prepare <project_id>");
    expect(report).not.toContain("/run-next");
    expect(report).not.toContain("/prepare-dispatch <task_id>");

    const advanced = remoteHelpReport("advanced");
    expect(advanced).toContain("고급 명령 목록은 Telegram에서 제거했습니다.");
    expect(advanced).toContain("/help");
    expect(advanced).not.toContain("/run <run_id>");
    expect(advanced).not.toContain("/approve_action <action_id>");

    const deprecated = remoteDeprecatedCommandReport({ command: "/action_current", replacement: "/now" });
    expect(deprecated).toContain("명령은 제거됐습니다");
    expect(deprecated).toContain("텔레그램: `/now`");
    expect(deprecated).not.toContain("/action_current");
    expect(remoteDecisionApprovedReport()).toContain("텔레그램: `/go`");
    expect(remoteDecisionApprovedReport()).not.toContain("decision-");
    expect(remoteDecisionRejectedReport()).toContain("텔레그램: `/now`");
    expect(remoteDecisionRejectedReport()).not.toContain("decision-");
    expect(remoteApprovalRedirectReport({ reason: "Telegram approval needs CLI review for decision-abc123" })).toContain("해당 항목");
  });

  test("normalizes deprecated command names from free-text report payloads", () => {
    const planWithDeprecatedText = {
      ...orchestratorPlan,
      payload: {
        ...orchestratorPlan.payload!,
        summary: "Use /status only in local notes",
        userMessage: "Do not ask for /run_latest or /next-action in Telegram.",
        risks: ["Old /doctor and /health guidance can leak."],
      },
    };
    const planReport = orchestratorPlanReport({ request: orchestrationRequest, plan: planWithDeprecatedText });
    expect(planReport).toContain("/now");
    expect(planReport).toContain("/check");
    expect(planReport).toContain("/problems");
    expect(planReport).not.toContain("/run_latest");
    expect(planReport).not.toContain("/next-action");
    expect(planReport).not.toContain("/status");
    expect(planReport).not.toContain("/doctor");
    expect(planReport).not.toContain("/health");

    const runLog: WorkerRunLog = {
      schemaVersion: 1,
      runId: "run-command-normalize",
      startedAt: "2026-05-05T10:02:00.000Z",
      finishedAt: "2026-05-05T10:03:00.000Z",
      task,
      agent,
      input: { repoRoot: "/repo", allocate: true, execute: true },
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
              text: "Worker says /action_current and /failures are stale.\n\nHARNESS_RESULT: {\"status\":\"pass\",\"note\":\"done\",\"commit\":\"\"}",
            },
          })}\n`,
          stderr: "",
        },
        evaluation: {
          pass: true,
          harness: { status: "pass", note: "done", commit: "" },
          changedFiles: [],
          scopeViolations: [],
          verifyResults: [],
        },
        pass: true,
      },
    };
    const action = {
      ...createRemoteDispatchAction({
        task,
        repoRoot: "/repo",
        createdAt: "2026-05-05T10:02:00.000Z",
        source: "remote",
        commandId: "remote-go",
      }),
      status: "completed" as const,
      result: { pass: true, outcome: "pass" },
    };
    const actionReport = remoteActionResultReport({ action, runLog });
    expect(actionReport).toContain("/now");
    expect(actionReport).toContain("/problems");
    expect(actionReport).not.toContain("/action_current");
    expect(actionReport).not.toContain("/failures");
  });

  test("renders compact CEO notification without internal ids or shell commands", () => {
    const report = ceoNotificationReport({
      generatedAt: "2026-05-07T11:00:00.000Z",
      overall: "needs_decision",
      completed: [],
      active: [],
      blocked: [],
      historicalFailures: [],
      needsDecision: [
        {
          kind: "decision",
          id: "decision-20260507-plan-abc12345",
          title: "Review plan: Ship mobile approval",
          status: "pending",
          reason: "Approve, request revision, or cancel before Samantha materializes worker tasks.",
          subject: "orchestrator_plan:plan-20260507-work-def67890",
          options: ["approve", "revise", "cancel"],
        },
      ],
      risks: ["Plan needs review before dispatching action-12345"],
      nextAction: {
        kind: "resolve_decision",
        label: "Resolve decision",
        command: "bun run samantha decisions:resolve decision-20260507-plan-abc12345 --resolution=approved",
        reason: "BK input required.",
      },
    });

    expect(report).toContain("# ceo-notify");
    expect(report).toContain("결정 필요: Review plan: Ship mobile approval");
    expect(report).toContain("텔레그램: `/approve`");
    expect(report).toContain("CLI 또는 dashboard");
    expect(report).not.toContain("decision-20260507");
    expect(report).not.toContain("plan-20260507");
    expect(report).not.toContain("action-12345");
    expect(report).not.toContain("bun run");
  });

  test("renders compact CEO notification with historical failures after next action", () => {
    const report = ceoNotificationReport({
      generatedAt: "2026-05-07T11:00:00.000Z",
      overall: "needs_recovery",
      completed: [],
      active: [],
      blocked: [],
      historicalFailures: [
        {
          kind: "run",
          id: "run-old",
          title: "Old failed task",
          status: "verify_failed",
          detail: "typecheck failed",
        },
      ],
      needsDecision: [],
      risks: ["Historical failed run run-old: typecheck failed"],
      nextAction: {
        kind: "recover",
        label: "Review unresolved historical failure",
        command: "/problems",
        targetId: "run-old",
        reason: "typecheck failed",
      },
    });

    expect(report).toContain("텔레그램: `/problems`");
    expect(report).toContain("히스토리 실패: 1건");
    expect(report.indexOf("다음 액션:")).toBeLessThan(report.indexOf("리스크:"));
  });

  test("renders compact run and failure summaries", () => {
    expect(runsListReport([passRun, failRun])).toContain("Total runs: 2");
    expect(runShowReport("run-pass", passRun)).toContain("Commit: `abcdef1234567890`");
    expect(runShowReport("run-pass", passRun)).toContain("merge:apply");
    expect(runShowReport("run-fail", failRun)).toContain("tasks:retry task-fail");

    const failures = failuresReport([passRun, failRun]);
    expect(failures).toContain("Total non-passing runs: 1");
    expect(failures).toContain("run-fail");
    expect(failures).not.toContain("run-pass");
  });

  test("renders daemon status and health reports", () => {
    const ops: OpsSnapshot = {
      ok: true,
      checkedAt: "2026-05-03T10:03:00.000Z",
      hostOwnership: {
        path: "/repo/state/host-ownership.json",
        currentHostId: "host-a",
        state: "active",
        automationAllowed: true,
        reason: "current machine is the active automation host",
        record: {
          schemaVersion: 1,
          role: "active_automation_host",
          hostId: "host-a",
          updatedAt: "2026-05-03T10:00:00.000Z",
        },
      },
      env: {
        envFilePath: "/repo/.env",
        envFileExists: true,
        hasBotToken: true,
        hasPollChatId: true,
        hasReplyChatId: true,
        codexCommand: "codex",
        hasCodexExecutable: true,
      },
      health: { ok: true, heartbeat, ageMs: 1000, violations: [] },
      queues: {
        pendingInboxCount: 2,
        outboxCount: 5,
        remoteOutboxCount: 4,
        unsentRemoteOutboxCount: 1,
        latestRemoteCommand: {
          file: "remote-2026-05-03t10-00-00.000z-status.json",
          updatedAt: "2026-05-03T10:00:01.000Z",
          id: "remote-2026-05-03t10-00-00.000z-status",
          type: "status:show",
          receivedAt: "2026-05-03T10:00:00.000Z",
        },
        latestRemoteOutbox: {
          file: "remote-2026-05-03t10-00-00.000z-status.md",
          updatedAt: "2026-05-03T10:00:02.000Z",
        },
      },
      telegram: {
        offset: { nextOffset: 42 },
        replyState: {
          schemaVersion: 1,
          sentFiles: ["remote-a.md"],
          failures: [
            {
              file: "remote-b.md",
              attempts: 2,
              lastError: "Telegram error",
              updatedAt: "2026-05-03T10:02:00.000Z",
            },
          ],
          updatedAt: "2026-05-03T10:02:00.000Z",
        },
      },
      systemd: {
        directory: "/systemd",
        checked: true,
        platform: "linux",
        files: [{ file: "samantha-inbox-watch.service", installed: true }],
      },
      issues: [],
      warnings: [],
      failures: [],
    };
    const status = statusReport({
      runs: [passRun, failRun],
      heartbeat,
      pendingInboxCount: 2,
      ops,
      proposals: [proposal],
      drafts: [draft],
      actions: [
        createRemoteDispatchAction({
          task,
          repoRoot: "/repo",
          createdAt: "2026-05-03T10:07:00.000Z",
          source: "remote",
          commandId: "remote-prepare",
        }),
      ],
      lifecycles: [{ ...lifecycle, cleanedAt: "2026-05-03T10:03:00.000Z" }],
    });
    expect(status).toContain("- pending inbox: 2");
    expect(status).toContain("운영 상태: 정상");
    expect(status).toContain("- non-passing: 1");
    expect(status).toContain("- next offset: 42");
    expect(status).toContain("- unsent remote outbox: 1");
    expect(status).toContain("최근 명령: type=`status:show`");
    expect(status).toContain("최근 리포트: `remote-2026-05-03t10-00-00.000z-status.md`");
    expect(status).toContain("최근 reply 실패: remote-b.md attempts=2 error=Telegram error");
    expect(status).toContain("- lifecycle: missing");
    expect(status).toContain("- pending_review: 1 accepted: 0 rejected: 0");
    expect(status).toContain("- drafted: 1 approved: 0 discarded: 0");
    expect(status).toContain("- pending: 1 waiting: 0 approved: 0 running: 0 failed: 0");
    expect(
      statusReport({
        runs: [passRun],
        heartbeat,
        pendingInboxCount: 0,
        lifecycles: [{ ...lifecycle, cleanedAt: "2026-05-03T10:03:00.000Z" }],
      }),
    ).toContain("- lifecycle: merged=no pushed=no cleaned=yes");

    const health: DaemonHealthResult = {
      ok: false,
      heartbeat,
      ageMs: 30_000,
      violations: ["heartbeat is stale: 30000ms"],
    };
    expect(healthReport(health)).toContain("정상: no");
    expect(healthReport(health)).toContain("heartbeat is stale");
    expect(doctorReport(ops)).toContain("전체 상태: 정상");
    expect(doctorReport(ops)).toContain("automation allowed: yes");
    expect(doctorReport(ops)).toContain("TELEGRAM_BOT_TOKEN: 있음");
    expect(doctorReport(ops)).toContain("최근 원격 명령: type=`status:show`");
    expect(doctorReport(ops)).toContain("최근 reply 실패: remote-b.md attempts=2 error=Telegram error");
    const secretReport = doctorReport({
      ...ops,
      ok: false,
      issues: [
        {
          severity: "needs_bk",
          area: "telegram",
          message: "Telegram reply failed with TELEGRAM_BOT_TOKEN=123456:ABCDEFGHIJKLMNOPQRSTUVWX",
          action: "Inspect Telegram env and rerun doctor",
        },
      ],
      telegram: {
        ...ops.telegram,
        replyState: {
          schemaVersion: 1,
          sentFiles: [],
          failures: [
            {
              file: "remote-secret.md",
              attempts: 1,
              lastError: "token=123456:ABCDEFGHIJKLMNOPQRSTUVWX",
              updatedAt: "2026-05-03T10:02:00.000Z",
            },
          ],
          updatedAt: "2026-05-03T10:02:00.000Z",
        },
      },
    });
    expect(secretReport).toContain("needs_bk telegram");
    expect(secretReport).toContain("TELEGRAM_BOT_TOKEN=[redacted]");
    expect(secretReport).toContain("token=[redacted]");
    expect(secretReport).not.toContain("123456:ABCDEFGHIJKLMNOPQRSTUVWX");
  });

  test("renders budget audit observations without implying enforcement or zero cost", () => {
    const ancestry = {
      mode: "assigned" as const,
      projectId: "samantha",
      goalId: "goal-budget",
      workItemId: "work-budget",
    };
    const status = statusReport({
      runs: [passRun],
      pendingInboxCount: 0,
      budgetObservations: [
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-09T01:00:00.000Z",
          actor: "samantha",
          subject: { type: "run", id: "run-pass" },
          cost: {
            kind: "unknown",
            reason: "worker run did not report measured or estimated cost",
          },
          context: {
            runId: "run-pass",
            projectId: "samantha",
            goalId: "goal-budget",
            workItemId: "work-budget",
            model: "gpt-5.5",
            command: { executable: "codex", args: ["exec", "--model", "gpt-5.5"] },
          },
        }),
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-09T01:01:00.000Z",
          actor: "operator",
          subject: { type: "action", id: "action-zero" },
          cost: {
            kind: "measured",
            amount: 0,
            currency: "USD",
            source: "provider receipt",
          },
          context: {
            actionId: "action-zero",
            runId: "run-pass",
            projectId: "samantha",
            goalId: "goal-budget",
            workItemId: "work-budget",
            model: "gpt-5.5",
            command: { executable: "codex", args: ["exec", "--model", "gpt-5.5"] },
          },
        }),
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-09T01:02:00.000Z",
          actor: "operator",
          subject: { type: "project", id: "samantha" },
          cost: {
            kind: "estimated",
            amount: 0.125,
            currency: "USD",
            basis: "manual token estimate",
          },
          context: {
            projectId: "samantha",
            goalId: "goal-budget",
            workItemId: "work-budget",
            model: "gpt-5.5",
          },
        }),
      ],
    });

    expect(status).toContain("Budget audit:");
    expect(status).toContain("observations: total=3 measured=1 estimated=1 unknown=1");
    expect(status).toContain("known measured total: USD 0");
    expect(status).toContain("known estimated total: USD 0.125");
    expect(status).toContain("unknown observations are missing cost data, not zero cost");
    expect(status).toContain("budget audit gaps: 1 records unknown_cost=1");
    expect(status).toContain("project rollup: samantha observations=3 measured=1 estimated=1 unknown=1 known_measured=USD 0 known_estimated=USD 0.125 audit_gaps=1");
    expect(status).toContain("goal rollup: goal-budget observations=3 measured=1 estimated=1 unknown=1 known_measured=USD 0 known_estimated=USD 0.125 audit_gaps=1");
    expect(status).toContain("action rollup: action-zero observations=1 measured=1 estimated=0 unknown=0 known_measured=USD 0 known_estimated=unavailable audit_gaps=0");
    expect(status).toContain("run rollup: run-pass observations=2 measured=1 estimated=0 unknown=1 known_measured=USD 0 known_estimated=unavailable audit_gaps=1");
    expect(status).toContain("model rollup: gpt-5.5 observations=3 measured=1 estimated=1 unknown=1 known_measured=USD 0 known_estimated=USD 0.125 audit_gaps=1");
    expect(status).toContain("command rollup: codex exec --model gpt-5.5 observations=2 measured=1 estimated=0 unknown=1 known_measured=USD 0 known_estimated=unavailable audit_gaps=1");
    expect(status).toContain("cost=`estimated USD 0.125`");
    expect(status).not.toContain("budget stop");

    const empty = statusReport({ runs: [], pendingInboxCount: 0, budgetObservations: [] });
    expect(empty).toContain("cost total: unavailable (missing cost data is unknown, not zero)");
  });

  test("renders project queue counts in the operator status report", () => {
    const ancestry = {
      mode: "assigned" as const,
      projectId: "samantha",
      goalId: "goal-status",
      workItemId: "work-status",
    };
    const status = statusReport({
      runs: [{ ...failRun, ancestry }],
      pendingInboxCount: 0,
      projectId: "samantha",
      tasks: [{ ...task, ancestry, status: "pending" }],
      actions: [
        createRemoteDispatchAction({
          task: { ...task, ancestry },
          repoRoot: "/repo",
          createdAt: "2026-05-03T10:07:00.000Z",
          source: "remote",
          commandId: "remote-prepare",
        }),
      ],
      decisions: [
        createDecisionItem({
          ancestry,
          title: "Approve status plan",
          prompt: "Approve before materialization.",
          kind: "orchestrator_plan_approval",
          source: "system",
          subject: { type: "orchestrator_plan", id: "plan-status" },
          options: ["approve", "revise", "cancel"],
          createdAt: "2026-05-03T10:08:00.000Z",
        }),
      ],
      budgetObservations: [
        createCostBudgetAuditRecord({
          ancestry,
          observedAt: "2026-05-09T01:00:00.000Z",
          actor: "samantha",
          subject: { type: "run", id: "run-fail" },
        }),
      ],
    });

    expect(status).toContain("Project filter: samantha");
    expect(status).toContain("Project queues:");
    expect(status).toContain("- selected samantha:");
    expect(status).toContain("pending_bk=1");
    expect(status).toContain("active_actions=1");
    expect(status).toContain("failed_runs=1");
    expect(status).toContain("audit_gaps=1");
    expect(status).toContain("- global blockers: 0");
  });

  test("renders task summaries", () => {
    const report = tasksListReport([task]);

    expect(report).toContain("Total tasks: 1");
    expect(report).toContain("task-pass");
    expect(taskShowReport("task-pass", { ...task, status: "archived", archiveReason: "stale", archivedAt: "2026-05-04T10:00:00.000Z" })).toContain(
      "Archive reason: stale",
    );
  });

  test("renders remote action reports", () => {
    const action = createRemoteDispatchAction({
      task,
      repoRoot: "/repo",
      createdAt: "2026-05-03T10:07:00.000Z",
      source: "remote",
      commandId: "remote-prepare",
    });
    const completed = {
      ...action,
      status: "completed" as const,
      approvedAt: "2026-05-03T10:08:00.000Z",
      startedAt: "2026-05-03T10:08:30.000Z",
      completedAt: "2026-05-03T10:09:00.000Z",
      result: {
        runId: "run-pass",
        runLogPath: "/runs/run-pass.json",
        liveLogPath: "/runs/live/run-pass.jsonl",
        tmuxSession: "samantha",
        pass: true,
        outcome: "pass",
      },
    };

    expect(remoteActionPreparedReport(action)).toContain("텔레그램: `/go`");
    expect(remoteActionPreparedReport(action)).not.toContain("/approve_action");
    expect(remoteActionPreparedReport(action)).toContain("아직 worker는 실행하지 않았습니다.");
    expect(remoteActionPreparedReport(action)).toContain("대상 repo: `repo`");
    expect(remoteActionsListReport([action])).toContain("dispatch_task");
    expect(remoteActionShowReport(action.id, action)).toContain("tasks:dispatch task-pass");
    expect(remoteActionShowReport(action.id, action)).toContain("텔레그램: `/go`");
    const runningAction = {
      ...action,
      status: "running" as const,
      startedAt: "2026-05-03T10:08:30.000Z",
      result: { runId: "run-live", liveLogPath: "/runs/live/run-live.jsonl", tmuxSession: "samantha" },
    };
    expect(remoteActionShowReport(runningAction.id, runningAction)).toContain("Live log: `/runs/live/run-live.jsonl`");
    expect(remoteActionShowReport(runningAction.id, runningAction)).toContain("Tmux: `samantha`");
    expect(remoteGoReport({ action: { ...action, status: "approved" } })).toContain("텔레그램: `/now`");
    expect(remoteActionApprovedReport({ ...action, status: "approved" })).toContain("actions:watch");
    expect(remoteActionApprovedReport({ ...action, status: "approved" })).toContain("텔레그램: `/now`");
    expect(remoteActionApprovedReport(completed)).toContain("통과: yes");
    expect(remoteActionApprovedReport(completed)).toContain("Tmux: `samantha`");
    expect(remoteActionApprovedReport(completed)).toContain("텔레그램: `/now`");

    const runLog: WorkerRunLog = {
      schemaVersion: 1,
      runId: "run-pass",
      startedAt: "2026-05-03T10:08:30.000Z",
      finishedAt: "2026-05-03T10:09:00.000Z",
      task: { ...task, resultMode: "write" },
      agent,
      input: {
        repoRoot: "/repo",
        allocate: true,
        execute: true,
      },
      result: {
        preparation: {
          taskId: "task-pass",
          agentId: "codex-worker",
          worktreePath: "/worktree",
          codex: { prompt: "prompt", command: ["codex", "exec"] },
        },
        setupResults: [],
        command: {
          command: ["codex", "exec"],
          exitCode: 0,
          stdout:
            `${JSON.stringify({
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "작업 완료 보고\n\n- 변경: README.md\n\nHARNESS_RESULT: {\"status\":\"pass\",\"note\":\"done\",\"commit\":\"\"}",
              },
            })}\n`,
          stderr: "",
        },
        evaluation: {
          pass: true,
          harness: { status: "pass", note: "done", commit: "" },
          changedFiles: ["README.md"],
          scopeViolations: [],
          verifyResults: [{ command: "bun test", exitCode: 0, stdout: "", stderr: "" }],
        },
        commit: {
          subject: "feat: fixture",
          files: ["README.md"],
          add: { command: ["git", "add", "README.md"], exitCode: 0, stdout: "", stderr: "" },
          commit: { command: ["git", "commit", "-m", "feat: fixture"], exitCode: 0, stdout: "", stderr: "" },
          commitHash: "abc123",
        },
        pass: true,
      },
    };
    const resultReport = remoteActionResultReport({ action: completed, runLog });
    expect(resultReport).toContain("# execution-result");
    expect(resultReport).toContain("실행 결과: 통과");
    expect(resultReport).toContain("대상 repo: `repo`");
    expect(resultReport).toContain("작업 유형: 구현/수정 - 커밋 생성, merge 필요");
    expect(resultReport).toContain("작업 완료 보고");
    expect(resultReport).not.toContain("HARNESS_RESULT");
    expect(resultReport).toContain("`README.md`");
    expect(resultReport).toContain("커밋: `abc123`");
    expect(resultReport).toContain("텔레그램: `/now`");
    const reportModeResult = remoteActionResultReport({
      action: completed,
      runLog: { ...runLog, task: { ...runLog.task, resultMode: "report" } },
      artifactPreviews: [{ file: "01 Design/(C) 2026-05-05 fixture-report.md", text: "# 원격 보고서\n\n핵심 내용입니다." }],
    });
    expect(reportModeResult).toContain("산출물 미리보기");
    expect(reportModeResult).toContain("작업 유형: 계획/보고 - 커밋 없음 정상");
    expect(reportModeResult).toContain("파일: `01 Design/(C) 2026-05-05 fixture-report.md`");
    expect(reportModeResult).toContain("# 원격 보고서");
    expect(
      remoteIntegrationReport({
        stage: "merge",
        run: passRun,
        ok: true,
        details: ["fast-forward merge를 적용했습니다.", "post-merge 검증을 통과했습니다."],
        lifecycle: { ...lifecycle, mergedAt: "2026-05-03T10:11:00.000Z" },
      }),
    ).toContain("단계: merge 적용");
    expect(
      remoteIntegrationReport({
        stage: "merge",
        run: passRun,
        ok: true,
        details: ["fast-forward merge를 적용했습니다.", "post-merge 검증을 통과했습니다."],
        lifecycle: { ...lifecycle, mergedAt: "2026-05-03T10:11:00.000Z" },
      }),
    ).toContain("텔레그램: `/now`");

    const failedPlanAction = {
      ...action,
      status: "failed" as const,
      orchestratorPlanId: "plan-1",
      completedAt: "2026-05-03T10:10:00.000Z",
      result: { pass: false, outcome: "fail", failure: "verify failed" },
    };
    const failedActionReport = remoteActionResultReport({ action: failedPlanAction });
    expect(failedActionReport).toContain("계획 결과 보고가 끝난 뒤 복구 가능 여부를 판단합니다.");
    expect(failedActionReport).toContain("텔레그램: `/now`");
    expect(failedActionReport).not.toContain("`/recover`");
  });

  test("renders a one-command Telegram now report", () => {
    const pendingAction = createRemoteDispatchAction({
      task,
      repoRoot: "/repo",
      createdAt: "2026-05-03T10:07:00.000Z",
      source: "remote",
      commandId: "remote-prepare",
    });
    const blockerClarification = createDecisionItem({
      title: "Clarify recovery blocker",
      prompt: "Should Samantha recover the failed run or wait?",
      kind: "blocker_clarification",
      source: "system",
      subject: { type: "run", id: "run-fail" },
      options: ["recover", "wait", "cancel"],
      risk: "Wrong recovery path can waste a worker run.",
      createdAt: "2026-05-03T10:08:00.000Z",
    });

    const blockerNow = nowReport({
      runs: [],
      tasks: [],
      actions: [{ ...pendingAction, status: "running" }],
      decisions: [blockerClarification],
      orchestratorPlans: [orchestratorPlan],
    });
    expect(blockerNow).toContain("BK 확인이 필요한 blocker clarification이 있습니다.");
    expect(blockerNow).toContain("질문: Should Samantha recover the failed run or wait?");
    expect(blockerNow).toContain("답변: `/answer <답변>`");
    expect(blockerNow).toContain("수정 요청: `/revise <피드백>`");
    expect(blockerNow).toContain("취소: `/cancel`");
    expect(blockerNow).not.toContain(blockerClarification.id);
    expect(blockerNow).not.toContain("worker가 실행 중입니다.");
    expect(blockerNow).not.toContain("계획 승인 및 worker 실행 큐 등록: `/go`");

    expect(nowReport({ runs: [], tasks: [], actions: [pendingAction] })).toContain("텔레그램: `/problems`");
    expect(nowReport({ runs: [], tasks: [], actions: [pendingAction] })).not.toContain("텔레그램: `/go`");
    expect(nowReport({ runs: [], tasks: [], actions: [{ ...pendingAction, status: "approved" }] })).toContain(
      "텔레그램: `/now`",
    );
    expect(nowReport({ runs: [], tasks: [], actions: [], orchestrationRequests: [orchestrationRequest] })).toContain(
      "작업 요청이 오케스트레이터 계획 생성을 기다리고 있습니다.",
    );
    expect(nowReport({ runs: [], tasks: [], actions: [], orchestrationRequests: [orchestrationRequest] })).toContain(
      "요청 취소: `/cancel`",
    );
    expect(nowReport({ runs: [], tasks: [], actions: [], orchestratorPlans: [orchestratorPlan] })).toContain(
      "오케스트레이터 계획이 생성되어 검토를 기다리고 있습니다.",
    );
    expect(nowReport({ runs: [], tasks: [], actions: [], orchestratorPlans: [orchestratorPlan] })).toContain(
      "계획 다시 보기: `/plan_current`",
    );
    const blockedNow = nowReport({
      runs: [],
      tasks: [],
      actions: [],
      orchestratorPlans: [orchestratorPlan],
      orchestratorPlanBlockers: [
        {
          planId: orchestratorPlan.id,
          requestId: orchestratorPlan.requestId,
          violations: ["task proposal task-proposal-1: verifyCommands must not be empty"],
          nextAction: {
            label: "Revise the current orchestrator plan before materialization",
            command: "/revise <피드백>",
            reason: "task proposal task-proposal-1: verifyCommands must not be empty",
          },
        },
      ],
    });
    expect(blockedNow).toContain("진행 차단:");
    expect(blockedNow).toContain("계획 수정: `/revise <피드백>`");
    expect(blockedNow).not.toContain("계획 승인 및 worker 실행 큐 등록: `/go`");
    expect(nowReport({ runs: [], tasks: [task], actions: [] })).toContain("텔레그램: `/problems`");
    expect(nowReport({ runs: [], tasks: [task], actions: [] })).not.toContain("텔레그램: `/go`");
    expect(nowReport({ runs: [], tasks: [], actions: [], drafts: [draft] })).toContain("지금 바로 필요한 원격 액션은 없습니다.");
    expect(nowReport({ runs: [], tasks: [], actions: [], proposals: [proposal] })).toContain("지금 바로 필요한 원격 액션은 없습니다.");
    expect(nowReport({ runs: [failRun], tasks: [], actions: [] })).toContain("텔레그램: `/problems`");
    expect(nowReport({ runs: [passRun, failRun], tasks: [], actions: [] })).toContain("merge:check --run-log=/logs/pass.json");
    expect(nowReport({ runs: [passRun, failRun], tasks: [], actions: [] })).toContain("텔레그램: `/go`");
    expect(nowReport({ runs: [passRun], tasks: [], actions: [], drafts: [draft] })).toContain("merge:check --run-log=/logs/pass.json");
    expect(nowReport({ runs: [passRun], tasks: [], actions: [] })).toContain("merge:check --run-log=/logs/pass.json");
    expect(nowReport({ runs: [passRun], tasks: [], actions: [] })).toContain("텔레그램: `/go`");
    expect(nowReport({ runs: [passRun], tasks: [], actions: [], lifecycles: [{ ...lifecycle, mergedAt: "now" }] })).toContain(
      "merge:push --run-log=/logs/pass.json",
    );
    expect(nowReport({ runs: [passRun], tasks: [], actions: [], lifecycles: [{ ...lifecycle, mergedAt: "now" }] })).toContain(
      "텔레그램: `/go`",
    );
    expect(nowReport({ runs: [passRun], tasks: [], actions: [], lifecycles: [{ ...lifecycle, mergedAt: "now", pushedAt: "now" }] })).toContain(
      "worktree:cleanup --run-log=/logs/pass.json",
    );
    expect(nowReport({ runs: [passRun], tasks: [], actions: [], lifecycles: [{ ...lifecycle, mergedAt: "now", pushedAt: "now" }] })).toContain(
      "텔레그램: `/go`",
    );
    expect(nowReport({ runs: [passRun], tasks: [], actions: [], lifecycles: [{ ...lifecycle, cleanedAt: "now" }] })).toContain(
      "merge:check --run-log=/logs/pass.json",
    );
    expect(
      nowReport({
        runs: [passRun],
        tasks: [],
        actions: [],
        lifecycles: [{ ...lifecycle, mergedAt: "now", pushedAt: "now", cleanedAt: "now" }],
      }),
    ).toContain(
      "merge/push/cleanup까지 완료",
    );

    const failedPlanAction = {
      ...pendingAction,
      id: "action-failed-plan",
      status: "failed" as const,
      completedAt: "2026-05-05T10:10:00.000Z",
      result: { pass: false, outcome: "fail", failure: "verify failed" },
    };
    expect(
      nowReport({
        runs: [],
        tasks: [],
        actions: [failedPlanAction],
        orchestratorPlans: [
          {
            ...orchestratorPlan,
            status: "materialized",
            resultReportedAt: "2026-05-05T10:11:00.000Z",
            actionIds: [failedPlanAction.id],
            synthesis: {
              outcome: "failed",
              summary: "verify failed",
              nextActions: [],
              risks: [],
              userMessage: "복구 필요",
            },
          },
        ],
      }),
    ).toContain("텔레그램: `/recover`");
    expect(
      nowReport({
        runs: [],
        tasks: [],
        actions: [failedPlanAction],
        orchestratorPlans: [
          {
            ...orchestratorPlan,
            status: "materialized",
            actionIds: [failedPlanAction.id],
            synthesis: {
              outcome: "failed",
              summary: "verify failed",
              nextActions: [],
              risks: [],
              userMessage: "복구 필요",
            },
          },
        ],
      }),
    ).not.toContain("텔레그램: `/recover`");
    expect(
      nowReport({
        runs: [],
        tasks: [],
        actions: [failedPlanAction],
        lifecycles: [{ ...lifecycle, updatedAt: "2026-05-05T10:12:00.000Z", cleanedAt: "2026-05-05T10:12:00.000Z" }],
        orchestratorPlans: [
          {
            ...orchestratorPlan,
            status: "materialized",
            resultReportedAt: "2026-05-05T10:11:00.000Z",
            actionIds: [failedPlanAction.id],
            synthesis: {
              outcome: "failed",
              summary: "verify failed",
              nextActions: [],
              risks: [],
              userMessage: "복구 필요",
            },
          },
        ],
      }),
    ).not.toContain("텔레그램: `/recover`");
    const staleArchivedFailure = nowReport({
      runs: [failRun],
      tasks: [{ ...task, id: failRun.taskId, status: "archived", archivedAt: "2026-05-05T10:12:00.000Z", archiveReason: "superseded by recovery" }],
      actions: [],
    });
    expect(staleArchivedFailure).toContain("텔레그램: `/check`");
    expect(staleArchivedFailure).not.toContain("가장 최근 run이 통과하지 못했습니다.");
  });

  test("renders next action reports", () => {
    expect(nextActionReport({ runs: [passRun], tasks: [task] })).toContain("tasks:dispatch task-pass");
    expect(nextActionReport({ runs: [passRun], tasks: [{ ...task, status: "archived" }] })).toContain("merge:check");
    expect(nextActionReport({ runs: [passRun], tasks: [], lifecycles: [{ ...lifecycle, mergedAt: "now" }] })).toContain(
      "merge:push --run-log=/logs/pass.json",
    );
    expect(nextActionReport({ runs: [passRun], tasks: [], lifecycles: [{ ...lifecycle, mergedAt: "now", pushedAt: "now" }] })).toContain(
      "worktree:cleanup --run-log=/logs/pass.json",
    );
    expect(nextActionReport({ runs: [passRun], tasks: [], lifecycles: [{ ...lifecycle, cleanedAt: "now" }] })).toContain(
      "merge:check",
    );
    expect(nextActionReport({ runs: [passRun], tasks: [], lifecycles: [{ ...lifecycle, mergedAt: "now", pushedAt: "now", cleanedAt: "now" }] })).toContain(
      "No immediate action.",
    );
    expect(nextActionReport({ runs: [passRun], tasks: [] })).toContain("merge:check");
    expect(nextActionReport({ runs: [failRun], tasks: [] })).toContain("tasks:retry task-fail");
    const archivedFailedTask = { ...task, id: failRun.taskId, status: "archived" as const, archivedAt: "2026-05-04T10:00:00.000Z", archiveReason: "stale failed recovery" };
    const archivedFailureReport = nextActionReport({ runs: [failRun], tasks: [archivedFailedTask] });
    expect(archivedFailureReport).toContain("No immediate action.");
    expect(archivedFailureReport).toContain("stale failure will not be retried");
    expect(archivedFailureReport).not.toContain("tasks:retry");
  });

  test("renders proposal reports without implying execution", () => {
    expect(proposalAddedReport(proposal)).toContain("No worker was dispatched");
    expect(proposalAddedReport(proposal)).toContain("새 흐름으로 다시 요청: `/work <요청>`");
    expect(proposalsListReport([proposal])).toContain("Total proposals: 1");
    expect(proposalShowReport("proposal-1", proposal)).toContain("Improve status reports");
    expect(proposalShowReport("proposal-1", proposal)).toContain("새 흐름으로 다시 요청: `/work <요청>`");
    expect(proposalReviewedReport("accept", { ...proposal, status: "accepted" })).toContain("only updates proposal review state");
    expect(proposalReviewedReport("accept", { ...proposal, status: "accepted" })).toContain("새 흐름으로 다시 요청: `/work <요청>`");
  });

  test("renders orchestrator planning and materialization reports", () => {
    expect(orchestrationRequestAddedReport(orchestrationRequest)).toContain("저장된 요청: `request-1`");
    expect(orchestrationRequestAddedReport(orchestrationRequest)).toContain("텔레그램: `/plan`");

    const planReport = orchestratorPlanReport({
      request: { ...orchestrationRequest, status: "planned", plannedAt: "2026-05-05T10:01:00.000Z" },
      plan: orchestratorPlan,
    });
    expect(planReport).toContain("오케스트레이터 계획을 만들었습니다.");
    expect(planReport).toContain("요청 분류: `implementation`");
    expect(planReport).toContain("handling=`implementation plan`");
    expect(planReport).toContain("profile=`codex-worker`");
    expect(planReport).toContain("작업 후보:");
    expect(planReport).toContain("`task-proposal-1`");
    expect(planReport).toContain("files=`1` setup=`0` verify=`1`");
    expect(planReport).toContain("Batch/dependency 흐름:");
    expect(planReport).toContain("batch 1: Implement planning flow (Writer, 구현/수정) - 즉시 후보");
    expect(planReport).toContain("역할 흐름:");
    expect(planReport).toContain("Writer: Implement planning flow: 구현 산출 (구현/수정)");
    expect(planReport).toContain("advisory topology:");
    expect(planReport).toContain("reviewed by Reviewer");
    expect(planReport).toContain("계획 다시 보기: `/plan_current`");
    expect(planReport).toContain("계획 승인 및 worker 실행 큐 등록: `/go`");
    expect(planReport).toContain("계획 수정: `/revise <피드백>`");
    expect(planReport).toContain("계획 취소: `/cancel`");

    const advisoryPlan = {
      ...orchestratorPlan,
      payload: {
        ...orchestratorPlan.payload!,
        selectedApproach: "한 writer task에서 구현과 검증을 함께 처리합니다.",
        rejectedAlternatives: [
          {
            title: "대안 task set을 병렬 실행",
            reason: "writer cap 1을 넘길 수 있고 선택 경로가 아닙니다.",
            tradeoffs: ["빠를 수 있지만 안전 gate가 약해집니다."],
          },
        ],
        tradeoffs: ["더 느리지만 deterministic materialization을 유지합니다."],
        recommendationTrace: [
          {
            recommendation: "한 writer task 유지",
            reason: "이전 BK 결정과 Phase 7 writer-cap gate가 같은 결론을 지지합니다.",
            citations: [
              { kind: "decision" as const, id: "decision-writer-cap-1" },
              { kind: "project_brief" as const, id: "brief-samantha-active" },
            ],
          },
        ],
      },
    };
    const advisoryReport = orchestratorPlanReport({
      request: { ...orchestrationRequest, status: "planned", plannedAt: "2026-05-05T10:01:00.000Z" },
      plan: advisoryPlan,
    });
    expect(advisoryReport).toContain("선택/대안 (advisory, /go 제외):");
    expect(advisoryReport).toContain("선택 접근: 한 writer task에서 구현과 검증을 함께 처리합니다.");
    expect(advisoryReport).toContain("거절한 대안: 대안 task set을 병렬 실행 - writer cap 1을 넘길 수 있고 선택 경로가 아닙니다.");
    expect(advisoryReport).toContain("추천 근거 trace:");
    expect(advisoryReport).toContain("한 writer task 유지: 이전 BK 결정과 Phase 7 writer-cap gate가 같은 결론을 지지합니다.");
    expect(advisoryReport).toContain("citations=`decision:decision-writer-cap-1, project_brief:brief-samantha-active`");
    expect(advisoryReport).toContain("대안/트레이드오프는 advisory이며 `/go` materialization 대상이 아닙니다.");

    const recoveryQuestions = orchestratorPlanReport({
      request: { ...orchestrationRequest, id: "request-recovery", recoveryOfPlanId: "plan-original-failed", status: "planned" },
      plan: {
        ...orchestratorPlan,
        id: "plan-recovery-questions",
        status: "questions",
        payload: {
          ...orchestratorPlan.payload!,
          summary: "Recovery needs BK context",
          questions: ["Which failure should be treated as fixed?"],
          tasks: [],
          batches: [],
          userMessage: "복구 판단에 BK 확인이 필요합니다.",
        },
      },
    });
    expect(recoveryQuestions).toContain("복구 판단: 원 문제는 BK 확인 필요 - Recovery needs BK context");
    expect(recoveryQuestions).toContain("답변/수정 요청: `/revise <피드백>`");

    const ambiguousQuestions = orchestratorPlanReport({
      request: { ...orchestrationRequest, id: "request-ambiguous", text: "대충 알아서 수정해줘", status: "planned" },
      plan: {
        ...orchestratorPlan,
        id: "plan-ambiguous",
        status: "questions",
        payload: {
          ...orchestratorPlan.payload!,
          summary: "Ambiguous implementation request",
          questions: ["어떤 프로젝트와 파일 범위를 대상으로 할까요?"],
          tasks: [],
          batches: [],
          userMessage: "범위 확인이 필요합니다.",
        },
      },
    });
    expect(ambiguousQuestions).toContain("요청 분류: `ambiguity-heavy`");
    expect(ambiguousQuestions).toContain("handling=`questions-first`");
    expect(ambiguousQuestions).toContain("답변/수정 요청: `/revise <피드백>`");
    expect(ambiguousQuestions).not.toContain("계획 승인 및 worker 실행 큐 등록: `/go`");

    const prerequisiteBlocked = orchestratorPlanReport({
      request: { ...orchestrationRequest, id: "request-prerequisite", status: "planned" },
      plan: {
        ...orchestratorPlan,
        id: "plan-prerequisite",
        payload: {
          ...orchestratorPlan.payload!,
          summary: "Host verification prerequisite",
          prerequisites: ["Ubuntu host must run verify:host"],
          tasks: [],
          batches: [],
          userMessage: "로컬 prerequisite 때문에 실행할 수 없습니다.",
        },
      },
    });
    expect(prerequisiteBlocked).toContain("진행 차단:");
    expect(prerequisiteBlocked).toContain("prerequisite: Ubuntu host must run verify:host");
    expect(prerequisiteBlocked).toContain("계획 수정: `/revise <피드백>`");
    expect(prerequisiteBlocked).not.toContain("계획 승인 및 worker 실행 큐 등록: `/go`");

    const recoveryReady = orchestratorPlanReport({
      request: { ...orchestrationRequest, id: "request-recovery-ready", recoveryOfPlanId: "plan-original-failed", status: "planned" },
      plan: { ...orchestratorPlan, id: "plan-recovery-ready" },
    });
    expect(recoveryReady).toContain("복구 판단: 원 문제는 BK 승인 필요 - Telegram orchestration flow");
    expect(recoveryReady).toContain("계획 승인 및 worker 실행 큐 등록: `/go`");

    const blocked = orchestratorGoBlockedReport({
      plan: { ...orchestratorPlan, status: "questions" },
      violations: ["orchestrator plan still has open questions"],
    });
    expect(blocked).toContain("오케스트레이터 계획을 실행 큐에 등록하지 못했습니다.");
    expect(blocked).toContain("orchestrator plan still has open questions");
    expect(blocked).toContain("답변/수정 요청: `/revise <피드백>`");
    expect(blocked).not.toContain("상태 확인: `/now`");

    const projectPolicyBlocked = orchestratorGoBlockedReport({
      plan: orchestratorPlan,
      violations: [
        "task proposal write-source: project policy samantha blocked: targetFiles entry src/lib/policy.ts is outside allowed remote scopes planning_report. Next safe action: revise targetFiles to the allowed project scope or request governed project policy approval.",
      ],
    });
    expect(projectPolicyBlocked).toContain("project policy samantha blocked");
    expect(projectPolicyBlocked).toContain("Next safe action: revise targetFiles to the allowed project scope");
    expect(projectPolicyBlocked).toContain("계획 수정: `/revise <피드백>`");

    const materialized = orchestratorGoMaterializedReport({
      plan: { ...advisoryPlan, status: "materialized" },
      tasks: [task],
      actions: [
        createRemoteDispatchAction({
          task,
          repoRoot: "/repo",
          createdAt: "2026-05-05T10:02:00.000Z",
          source: "remote",
          commandId: "remote-go",
        }),
      ],
    });
    expect(materialized).toContain("오케스트레이터 계획을 승인했고 worker 실행 큐에 등록했습니다.");
    expect(materialized).toContain("선택된 작업 경로만 task/action으로 등록했습니다. 대안은 advisory로 남깁니다.");
    expect(materialized).toContain("실행 순서:");
    expect(materialized).toContain("Pass task status=`pending` (즉시 승인 후보)");
    expect(materialized).toContain("텔레그램: `/now`");

    const prerequisiteTask = { ...task, id: "task-review-risk", title: "Review risk", resultMode: "report" as const };
    const dependentTask = { ...task, id: "task-apply-change", title: "Apply change" };
    const prerequisiteAction = createRemoteDispatchAction({
      task: prerequisiteTask,
      repoRoot: "/repo",
      createdAt: "2026-05-05T10:01:00.000Z",
      source: "remote",
      commandId: "review-risk",
    });
    const dependentAction = createRemoteDispatchAction({
      task: dependentTask,
      repoRoot: "/repo",
      createdAt: "2026-05-05T10:01:00.000Z",
      source: "remote",
      commandId: "apply-change",
      status: "waiting",
      dependsOnActionIds: [prerequisiteAction.id],
    });
    const dependentMaterialized = orchestratorGoMaterializedReport({
      plan: { ...orchestratorPlan, status: "materialized" },
      tasks: [prerequisiteTask, dependentTask],
      actions: [prerequisiteAction, dependentAction],
    });
    expect(dependentMaterialized).toContain("status=`waiting` prerequisites=`1`");
    expect(dependentMaterialized).toContain("Apply change status=`waiting` (prerequisites=1 통과 후 자동 승인)");
    expect(remoteGoNoActionablePlanReport()).toContain("통합 gate가 없습니다.");
    expect(remoteGoNoActionablePlanReport()).toContain("텔레그램: `/now`");

    const passedPlanAction = {
      ...createRemoteDispatchAction({
        task,
        repoRoot: "/repo",
        createdAt: "2026-05-05T10:02:00.000Z",
        source: "remote",
        commandId: "remote-go-pass",
      }),
      status: "completed" as const,
      result: {
        runId: "run-pass",
        runLogPath: "/runs/run-pass.json",
        pass: true,
        outcome: "pass",
      },
    };
    const passedPlanResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, status: "materialized", actionIds: [passedPlanAction.id] },
      actions: [passedPlanAction],
      runLogs: [
        {
          schemaVersion: 1,
          runId: "run-pass",
          startedAt: "2026-05-05T10:02:00.000Z",
          finishedAt: "2026-05-05T10:03:00.000Z",
          task,
          agent,
          input: { repoRoot: "/repo", allocate: true, execute: true },
          result: {
            preparation: {
              taskId: task.id,
              agentId: agent.id,
              worktreePath: "/worktree",
              codex: { prompt: "prompt", command: ["codex", "exec"] },
            },
            setupResults: [],
            command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
            evaluation: {
              pass: true,
              harness: { status: "pass", note: "done", commit: "" },
              changedFiles: ["README.md"],
              scopeViolations: [],
              verifyResults: [],
            },
            commit: {
              subject: "feat: fixture",
              files: ["README.md"],
              add: { command: ["git", "add", "README.md"], exitCode: 0, stdout: "", stderr: "" },
              commit: { command: ["git", "commit", "-m", "feat: fixture"], exitCode: 0, stdout: "", stderr: "" },
              commitHash: "abc123",
            },
            pass: true,
          },
        },
      ],
      synthesis: {
        outcome: "pass",
        summary: "통과",
        nextActions: ["텔레그램: /run_latest"],
        risks: ["/status 대신 현재 명령을 안내해야 합니다."],
        userMessage: "완료했습니다. /run_latest는 Telegram에 노출되면 안 됩니다.",
      },
    });
    expect(passedPlanResult).toContain("계획 결과: 구현 통과");
    expect(passedPlanResult).toContain("대상 repo: `repo`");
    expect(passedPlanResult).toContain("작업 유형: 구현/수정 - merge 필요");
    expect(passedPlanResult).toContain("완료 작업: 1/1");
    expect(passedPlanResult).toContain("Writer: Pass task: 통과 (구현/수정)");
    expect(passedPlanResult).toContain("대상: repo / 구현/수정");
    expect(passedPlanResult).toContain("`README.md`");
    expect(passedPlanResult).toContain("텔레그램: `/now`");
    expect(passedPlanResult).not.toContain("/run_latest");
    expect(passedPlanResult).not.toContain("/status");
    expect(passedPlanResult).not.toContain("plan-1");
    expect(passedPlanResult).not.toContain("task-pass status=");

    const reportOnlyPlanResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, status: "materialized", actionIds: [passedPlanAction.id] },
      actions: [passedPlanAction],
      runLogs: [
        {
          schemaVersion: 1,
          runId: "run-pass",
          startedAt: "2026-05-05T10:02:00.000Z",
          finishedAt: "2026-05-05T10:03:00.000Z",
          task: { ...task, resultMode: "report" },
          agent,
          input: { repoRoot: "/repo/oh-my-health-trainer", allocate: true, execute: true },
          result: {
            preparation: {
              taskId: task.id,
              agentId: agent.id,
              worktreePath: "/worktree",
              codex: { prompt: "prompt", command: ["codex", "exec"] },
            },
            setupResults: [],
            command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
            evaluation: {
              pass: true,
              harness: { status: "pass", note: "report-only", commit: "" },
              changedFiles: [],
              scopeViolations: [],
              verifyResults: [],
            },
            pass: true,
          },
        },
      ],
    });
    expect(reportOnlyPlanResult).toContain("계획 결과: 보고 완료");
    expect(reportOnlyPlanResult).toContain("대상 repo: `oh-my-health-trainer`");
    expect(reportOnlyPlanResult).toContain("작업 유형: 계획/보고 - 커밋 없음 정상");
    expect(reportOnlyPlanResult).not.toContain("로컬 merge 후보");

    const specialistAncestry = {
      mode: "assigned" as const,
      projectId: "samantha",
      goalId: "goal-parallelism",
      workItemId: "work-parallelism",
    };
    const reviewerAgent: AgentProfile = {
      ...agent,
      id: "codex-reviewer",
      role: "reviewer",
      writerClass: "non-writer",
      worktreePolicy: "none",
      mergePolicy: "none",
    };
    const reviewerTask: TaskSpec = {
      ...task,
      id: "task-review-parallel",
      ancestry: specialistAncestry,
      title: "Review parallel summary",
      targetAgent: "codex-reviewer",
      resultMode: "report",
      targetFiles: [],
    };
    const reviewerAction = {
      ...createRemoteDispatchAction({
        task: reviewerTask,
        repoRoot: "/repo/samantha-codex",
        createdAt: "2026-05-05T10:04:00.000Z",
        source: "remote",
        commandId: "review-parallel",
        ancestry: specialistAncestry,
      }),
      status: "completed" as const,
      result: { runId: "run-review-parallel", runLogPath: "/runs/run-review-parallel.json", pass: true, outcome: "pass" },
    };
    const specialistResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, ancestry: specialistAncestry, status: "materialized", actionIds: [reviewerAction.id] },
      actions: [reviewerAction],
      runLogs: [
        {
          schemaVersion: 1,
          ancestry: specialistAncestry,
          runId: "run-review-parallel",
          startedAt: "2026-05-05T10:04:00.000Z",
          finishedAt: "2026-05-05T10:05:00.000Z",
          task: reviewerTask,
          agent: reviewerAgent,
          input: { repoRoot: "/repo/samantha-codex", allocate: true, execute: true },
          result: {
            preparation: {
              taskId: reviewerTask.id,
              agentId: reviewerAgent.id,
              worktreePath: "/worktree",
              codex: { prompt: "prompt", command: ["codex", "exec"] },
            },
            setupResults: [],
            command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
            evaluation: {
              pass: true,
              harness: { status: "pass", note: "checked role presentation risk", commit: "" },
              changedFiles: [],
              scopeViolations: [],
              verifyResults: [],
            },
            pass: true,
          },
        },
      ],
    });
    expect(specialistResult).toContain("Reviewer [project=samantha goal=goal-parallelism]: Review parallel summary: 보고 완료 (계획/보고)");
    expect(specialistResult).toContain("checked quality and regressions; reduced bad change approval risk");
    expect(specialistResult).not.toContain("action-");

    const failedPlanResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, status: "materialized", actionIds: ["action-failed"] },
      actions: [
        {
          ...createRemoteDispatchAction({
            task,
            repoRoot: "/repo",
            createdAt: "2026-05-05T10:02:00.000Z",
            source: "remote",
            commandId: "remote-go",
          }),
          id: "action-failed",
          status: "failed",
          result: { runId: "run-failed", runLogPath: "/runs/run-failed.json", pass: false, outcome: "fail", failure: "verify failed" },
        },
      ],
      runLogs: [
        {
          schemaVersion: 1,
          runId: "run-failed",
          startedAt: "2026-05-05T10:02:00.000Z",
          finishedAt: "2026-05-05T10:03:00.000Z",
          task,
          agent,
          input: { repoRoot: "/repo", allocate: true, execute: true },
          result: {
            preparation: {
              taskId: task.id,
              agentId: agent.id,
              worktreePath: "/worktree",
              codex: { prompt: "prompt", command: ["codex", "exec"] },
            },
            setupResults: [],
            command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
            evaluation: {
              pass: false,
              harness: { status: "rework", note: "verify failed", commit: "" },
              changedFiles: ["src/lib/failure.ts"],
              scopeViolations: [],
              verifyResults: [{ command: "bun typecheck", exitCode: 1, stdout: "", stderr: "TS2322" }],
            },
            pass: false,
          },
        },
      ],
      synthesisFailure: "invalid synthesis JSON",
      artifactPreviews: [{ file: "docs/failure-report.md", text: "# Failure report" }],
    });
    expect(failedPlanResult).toContain("계획 결과: 검증 실패 - 복구 필요");
    expect(failedPlanResult).toContain("작업 유형: 구현/수정 - 복구 필요");
    expect(failedPlanResult).toContain("텔레그램: `/recover`");
    expect(failedPlanResult).toContain("verify failed");
    expect(failedPlanResult).toContain("오케스트레이터 종합 실패: invalid synthesis JSON");
    expect(failedPlanResult).toContain("`src > lib > failure.ts`");
    expect(failedPlanResult).toContain("보고 산출물:");
    expect(failedPlanResult).toContain("`docs/failure-report.md`");
    expect(failedPlanResult).toContain("bun typecheck exited 1");
    expect(failedPlanResult).toContain("`/runs/run-failed.json`");

    const failedSpecialistAction = {
      ...reviewerAction,
      id: "action-specialist-failed",
      status: "failed" as const,
      result: {
        runId: "run-specialist-failed",
        runLogPath: "/runs/run-specialist-failed.json",
        pass: false,
        outcome: "failed",
        failure: "review verification failed",
      },
    };
    const failedSpecialistResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, ancestry: specialistAncestry, status: "materialized", actionIds: [failedSpecialistAction.id] },
      actions: [failedSpecialistAction],
      runLogs: [
        {
          schemaVersion: 1,
          ancestry: specialistAncestry,
          runId: "run-specialist-failed",
          startedAt: "2026-05-05T10:06:00.000Z",
          finishedAt: "2026-05-05T10:07:00.000Z",
          task: reviewerTask,
          agent: reviewerAgent,
          input: { repoRoot: "/repo/samantha-codex", allocate: true, execute: true },
          result: {
            preparation: {
              taskId: reviewerTask.id,
              agentId: reviewerAgent.id,
              worktreePath: "/worktree",
              codex: { prompt: "prompt", command: ["codex", "exec"] },
            },
            setupResults: [],
            command: { command: ["codex", "exec"], exitCode: 1, stdout: "", stderr: "" },
            evaluation: {
              pass: false,
              harness: { status: "rework", note: "review verification failed", commit: "" },
              changedFiles: [],
              scopeViolations: [],
              verifyResults: [{ command: "bun typecheck", exitCode: 1, stdout: "", stderr: "TS2322" }],
            },
            pass: false,
          },
        },
      ],
    });
    expect(failedSpecialistResult).toContain("Reviewer [project=samantha goal=goal-parallelism]: Review parallel summary: 검증 실패 (계획/보고)");
    expect(failedSpecialistResult).toContain("다음: 실패한 specialist 보고를 `/recover` 복구 계획에 반영");
    expect(failedSpecialistResult).toContain("텔레그램: `/recover`");

    const blockedPlanResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, status: "materialized", actionIds: [passedPlanAction.id] },
      actions: [passedPlanAction],
      runLogs: [],
      synthesis: {
        outcome: "blocked",
        summary: "host-only verification blocked",
        nextActions: ["텔레그램: /recover"],
        risks: ["host-only verification remains"],
        userMessage: "검증이 host-only 조건에 막혔습니다.",
      },
    });
    expect(blockedPlanResult).toContain("계획 결과: 차단됨 - 복구 필요");
    expect(blockedPlanResult).toContain("종합 결과: `blocked`");
    expect(blockedPlanResult).toContain("텔레그램: `/recover`");

    const needsBkPlanResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, status: "materialized", actionIds: [passedPlanAction.id] },
      actions: [passedPlanAction],
      runLogs: [],
      synthesis: {
        outcome: "needs-BK",
        summary: "BK decision still needed",
        nextActions: ["텔레그램: /now"],
        risks: ["BK must choose the next scope"],
        userMessage: "BK 결정이 남았습니다.",
      },
    });
    expect(needsBkPlanResult).toContain("계획 결과: BK 확인 필요 - 복구 필요");
    expect(needsBkPlanResult).toContain("종합 결과: `needs-BK`");

    const fixedRecoveryResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, id: "plan-recovery", requestId: "request-recovery", status: "materialized", actionIds: [passedPlanAction.id] },
      sourcePlan: { ...orchestratorPlan, id: "plan-original-failed", payload: { ...orchestratorPlan.payload!, summary: "Original failed workflow" } },
      actions: [passedPlanAction],
      runLogs: [
        {
          schemaVersion: 1,
          runId: "run-pass",
          startedAt: "2026-05-05T10:02:00.000Z",
          finishedAt: "2026-05-05T10:03:00.000Z",
          task,
          agent,
          input: { repoRoot: "/repo", allocate: true, execute: true },
          result: {
            preparation: {
              taskId: task.id,
              agentId: agent.id,
              worktreePath: "/worktree",
              codex: { prompt: "prompt", command: ["codex", "exec"] },
            },
            setupResults: [],
            command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
            evaluation: {
              pass: true,
              harness: { status: "pass", note: "fixed original failure", commit: "" },
              changedFiles: ["README.md"],
              scopeViolations: [],
              verifyResults: [],
            },
            commit: {
              subject: "fix: recovery",
              files: ["README.md"],
              add: { command: ["git", "add", "README.md"], exitCode: 0, stdout: "", stderr: "" },
              commit: { command: ["git", "commit", "-m", "fix: recovery"], exitCode: 0, stdout: "", stderr: "" },
              commitHash: "abc123",
            },
            pass: true,
          },
        },
      ],
      synthesis: {
        outcome: "pass",
        summary: "recovery fixed the source failure",
        nextActions: [],
        risks: [],
        userMessage: "Recovery fixed the original failure.",
      },
    });
    expect(fixedRecoveryResult).toContain("복구 판단: 원 문제 해결됨 - Original failed workflow");

    const unresolvedRecoveryResult = orchestratorPlanResultReport({
      plan: { ...orchestratorPlan, id: "plan-recovery-failed", requestId: "request-recovery", status: "materialized", actionIds: ["action-failed"] },
      sourcePlan: { ...orchestratorPlan, id: "plan-original-failed", payload: { ...orchestratorPlan.payload!, summary: "Original failed workflow" } },
      actions: [
        {
          ...createRemoteDispatchAction({
            task,
            repoRoot: "/repo",
            createdAt: "2026-05-05T10:04:00.000Z",
            source: "remote",
            commandId: "remote-go-recovery-failed",
          }),
          id: "action-failed",
          status: "failed",
          result: { pass: false, outcome: "fail", failure: "verify failed" },
        },
      ],
      runLogs: [],
      synthesis: {
        outcome: "failed",
        summary: "recovery did not fix the source failure",
        nextActions: [],
        risks: [],
        userMessage: "Original failure remains.",
      },
    });
    expect(unresolvedRecoveryResult).toContain("복구 판단: 원 문제 미해결 - Original failed workflow 추가 복구 필요");

    const recovery = orchestratorRecoveryRequestReport({
      request: { ...orchestrationRequest, id: "request-recover", status: "pending_plan" },
      sourcePlan: { ...orchestratorPlan, id: "plan-failed", status: "materialized" },
      failedActions: [
        {
          ...createRemoteDispatchAction({
            task,
            repoRoot: "/repo",
            createdAt: "2026-05-05T10:03:00.000Z",
            source: "remote",
            commandId: "remote-go",
          }),
          status: "failed",
          result: { pass: false, outcome: "fail", failure: "verify failed" },
        },
      ],
    });
    expect(recovery).toContain("복구 계획 요청을 만들었습니다.");
    expect(recovery).toContain("복구 대상: Telegram orchestration flow");
    expect(recovery).toContain("Pass task: verify failed");
    expect(recovery).toContain("텔레그램: `/plan`");
    expect(recovery).not.toContain("plan-failed");
    expect(recovery).not.toContain("action-");

    const revision = orchestratorRevisionRequestReport({
      request: { ...orchestrationRequest, id: "request-revision", status: "pending_plan" },
      supersededPlan: { ...orchestratorPlan, id: "plan-old", status: "superseded" },
    });
    expect(revision).toContain("현재 계획을 폐기하고 수정 요청을 만들었습니다.");
    expect(revision).toContain("텔레그램: `/plan`");

    const canceled = orchestratorCancelReport({
      plan: {
        ...orchestratorPlan,
        status: "canceled",
        canceledAt: "2026-05-05T10:04:00.000Z",
        cancelReason: "stale",
      },
    });
    expect(canceled).toContain("승인 전 계획을 취소했습니다.");
    expect(canceled).toContain("텔레그램: `/now`");
  });

  test("renders task draft reports without implying execution", () => {
    expect(taskDraftAddedReport(draft)).toContain("아직 worker는 실행하지 않았습니다.");
    expect(taskDraftAddedReport(draft)).toContain("텔레그램: `/plan`");
    expect(draftProposeAddedReport({ proposal: { ...proposal, status: "accepted" }, draft })).toContain(
      "제안과 드래프트만 저장했습니다.",
    );
    expect(draftProposeAddedReport({ proposal: { ...proposal, status: "accepted" }, draft })).toContain("텔레그램: `/plan`");
    expect(taskDraftsListReport([draft])).toContain("Total drafts: 1");
    expect(taskDraftShowReport("draft-1", draft)).toContain("Improve status reports");
    expect(taskDraftShowReport("draft-1", draft)).toContain("텔레그램: `/plan`");
    expect(taskDraftShowReport("draft-1", { ...draft, targetFiles: ["src/app.ts"], verifyCommands: ["bun test"] })).toContain(
      "텔레그램: `/go`",
    );
    expect(
      taskDraftPlanReport({
        draft: {
          ...draft,
          targetFiles: ["docs/report.md"],
          forbiddenChanges: ["state/**"],
          verifyCommands: ["bun typecheck"],
          resultMode: "report",
        },
        project: {
          schemaVersion: 1,
          id: "omht",
          repoRoot: "/repo/omht",
          setupCommands: ["bun install"],
          verifyCommands: ["bun typecheck"],
          forbiddenChanges: ["state/**"],
        },
        scope: {
          id: "planning_report",
          label: "Planning report",
          description: "Document work.",
          risk: "low",
          resultMode: "report",
          targetFiles: ["docs/**"],
          planSteps: ["Read context.", "Write report."],
          successCriteria: ["Report is actionable."],
        },
        violations: [],
        inferredProject: true,
        inferredScope: true,
      }),
    ).toContain("요청 분류: `planning/report`");
    expect(
      taskDraftPlanReport({
        draft: {
          ...draft,
          instructions: "대충 알아서 수정해줘",
          targetFiles: ["docs/report.md"],
          forbiddenChanges: ["state/**"],
          verifyCommands: ["bun typecheck"],
          resultMode: "report",
        },
        project: {
          schemaVersion: 1,
          id: "omht",
          repoRoot: "/repo/omht",
          setupCommands: ["bun install"],
          verifyCommands: ["bun typecheck"],
          forbiddenChanges: ["state/**"],
        },
        scope: {
          id: "planning_report",
          label: "Planning report",
          description: "Document work.",
          risk: "low",
          resultMode: "report",
          targetFiles: ["docs/**"],
          planSteps: ["Read context.", "Write report."],
          successCriteria: ["Report is actionable."],
        },
        violations: [],
        inferredProject: true,
        inferredScope: true,
      }),
    ).toContain("handling=`questions-first`");
    expect(taskDraftPreparedReport({ draft, projectId: "omht", violations: ["targetFiles must not be empty"] })).toContain(
      "준비된 드래프트: `draft-1`",
    );
    expect(taskDraftPrepareBlockedReport({ draft, projectId: "omht", violations: ["targetFiles entry looks like an id"] })).toContain(
      "드래프트를 준비하지 못했습니다.",
    );
    expect(taskDraftApprovalBlockedReport({ draft, violations: ["targetFiles must not be empty"] })).toContain(
      "드래프트를 승인하지 못했습니다.",
    );
    expect(taskDraftApprovedReport({ draft: { ...draft, status: "approved" }, task })).toContain("텔레그램: `/go`");
  });
});
