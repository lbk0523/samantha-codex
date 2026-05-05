import { describe, expect, test } from "bun:test";
import type { TaskSpec } from "../src/lib/contracts";
import type { DaemonHealthResult, DaemonHeartbeat } from "../src/lib/daemon";
import type { RunSummary } from "../src/lib/ledger";
import {
  doctorReport,
  draftProposeAddedReport,
  failuresReport,
  healthReport,
  nextActionReport,
  proposalAddedReport,
  proposalsListReport,
  proposalReviewedReport,
  proposalShowReport,
  remoteActionApprovedReport,
  remoteActionPreparedReport,
  remoteActionShowReport,
  remoteActionsListReport,
  remoteHelpReport,
  runsListReport,
  runShowReport,
  statusReport,
  taskDraftAddedReport,
  taskDraftShowReport,
  taskDraftsListReport,
  tasksListReport,
  taskShowReport,
} from "../src/lib/operator-reports";
import type { OpsSnapshot } from "../src/lib/ops-diagnostics";
import type { ProposalRecord } from "../src/lib/proposal-store";
import { createRemoteDispatchAction } from "../src/lib/remote-action-store";
import type { RunLifecycleRecord } from "../src/lib/run-lifecycle-store";
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

describe("operator reports", () => {
  test("documents safe-gated remote commands", () => {
    const report = remoteHelpReport();

    expect(report).toContain("/status");
    expect(report).toContain("/propose <text>");
    expect(report).toContain("/draft-propose <text>");
    expect(report).toContain("/draft <proposal-id>");
    expect(report).toContain("/run <run-id>");
    expect(report).toContain("/next-action");
    expect(report).toContain("/prepare-dispatch <task-id>");
    expect(report).toContain("/approve-action <action-id>");
    expect(report).toContain("cannot dispatch workers directly");
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
      env: {
        envFilePath: "/repo/.env",
        envFileExists: true,
        hasBotToken: true,
        hasPollChatId: true,
        hasReplyChatId: true,
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
      systemd: { directory: "/systemd", files: [{ file: "samantha-inbox-watch.service", installed: true }] },
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
      lifecycles: [{ ...lifecycle, cleanedAt: "2026-05-03T10:03:00.000Z" }],
    });
    expect(status).toContain("- pending inbox: 2");
    expect(status).toContain("Operation: ok");
    expect(status).toContain("- non-passing: 1");
    expect(status).toContain("- next offset: 42");
    expect(status).toContain("- unsent remote outbox: 1");
    expect(status).toContain("latest command: type=`status:show`");
    expect(status).toContain("latest report: `remote-2026-05-03t10-00-00.000z-status.md`");
    expect(status).toContain("latest reply failure: remote-b.md attempts=2 error=Telegram error");
    expect(status).toContain("- lifecycle: missing");
    expect(status).toContain("- pending_review: 1 accepted: 0 rejected: 0");
    expect(status).toContain("- drafted: 1 approved: 0 discarded: 0");
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
    expect(healthReport(health)).toContain("OK: no");
    expect(healthReport(health)).toContain("heartbeat is stale");
    expect(doctorReport(ops)).toContain("Overall: ok");
    expect(doctorReport(ops)).toContain("TELEGRAM_BOT_TOKEN: present");
    expect(doctorReport(ops)).toContain("latest remote command: type=`status:show`");
    expect(doctorReport(ops)).toContain("latest reply failure: remote-b.md attempts=2 error=Telegram error");
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

    expect(remoteActionPreparedReport(action)).toContain("/approve-action");
    expect(remoteActionPreparedReport(action)).toContain("No worker was dispatched yet.");
    expect(remoteActionsListReport([action])).toContain("dispatch_task");
    expect(remoteActionShowReport(action.id, action)).toContain("tasks:dispatch task-pass");
    expect(remoteActionApprovedReport(completed)).toContain("Pass: yes");
    expect(remoteActionApprovedReport(completed)).toContain("Tmux: `samantha`");
  });

  test("renders next action reports", () => {
    expect(nextActionReport({ runs: [passRun], tasks: [task] })).toContain("tasks:dispatch task-pass");
    expect(nextActionReport({ runs: [passRun], tasks: [{ ...task, status: "archived" }] })).toContain("merge:check");
    expect(nextActionReport({ runs: [passRun], tasks: [], lifecycles: [{ ...lifecycle, mergedAt: "now" }] })).toContain(
      "merge:push --run-log=/logs/pass.json",
    );
    expect(nextActionReport({ runs: [passRun], tasks: [], lifecycles: [{ ...lifecycle, pushedAt: "now" }] })).toContain(
      "worktree:cleanup --run-log=/logs/pass.json",
    );
    expect(nextActionReport({ runs: [passRun], tasks: [], lifecycles: [{ ...lifecycle, cleanedAt: "now" }] })).toContain(
      "No immediate action.",
    );
    expect(nextActionReport({ runs: [passRun], tasks: [] })).toContain("merge:check");
    expect(nextActionReport({ runs: [failRun], tasks: [] })).toContain("tasks:retry task-fail");
  });

  test("renders proposal reports without implying execution", () => {
    expect(proposalAddedReport(proposal)).toContain("No worker was dispatched");
    expect(proposalsListReport([proposal])).toContain("Total proposals: 1");
    expect(proposalShowReport("proposal-1", proposal)).toContain("Improve status reports");
    expect(proposalReviewedReport("accept", { ...proposal, status: "accepted" })).toContain("only updates proposal review state");
  });

  test("renders task draft reports without implying execution", () => {
    expect(taskDraftAddedReport(draft)).toContain("No worker was dispatched");
    expect(draftProposeAddedReport({ proposal: { ...proposal, status: "accepted" }, draft })).toContain(
      "only creates an accepted proposal and a task draft",
    );
    expect(taskDraftsListReport([draft])).toContain("Total drafts: 1");
    expect(taskDraftShowReport("draft-1", draft)).toContain("Improve status reports");
  });
});
