import { describe, expect, test } from "bun:test";
import type { TaskSpec } from "../src/lib/contracts";
import type { DaemonHealthResult, DaemonHeartbeat } from "../src/lib/daemon";
import type { RunSummary } from "../src/lib/ledger";
import {
  doctorReport,
  failuresReport,
  healthReport,
  remoteHelpReport,
  runsListReport,
  runShowReport,
  statusReport,
  tasksListReport,
} from "../src/lib/operator-reports";
import type { OpsSnapshot } from "../src/lib/ops-diagnostics";

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

describe("operator reports", () => {
  test("documents read-only remote commands", () => {
    const report = remoteHelpReport();

    expect(report).toContain("/status");
    expect(report).toContain("/run <run-id>");
    expect(report).toContain("cannot dispatch workers");
  });

  test("renders compact run and failure summaries", () => {
    expect(runsListReport([passRun, failRun])).toContain("Total runs: 2");
    expect(runShowReport("run-pass", passRun)).toContain("Commit: `abcdef1234567890`");

    const failures = failuresReport([passRun, failRun]);
    expect(failures).toContain("Total failures: 1");
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
      },
      telegram: {
        offset: { nextOffset: 42 },
        replyState: { schemaVersion: 1, sentFiles: ["remote-a.md"], updatedAt: "2026-05-03T10:02:00.000Z" },
      },
      systemd: { directory: "/systemd", files: [{ file: "samantha-inbox-watch.service", installed: true }] },
      warnings: [],
      failures: [],
    };
    const status = statusReport({ runs: [passRun, failRun], heartbeat, pendingInboxCount: 2, ops });
    expect(status).toContain("Pending inbox commands: 2");
    expect(status).toContain("Operation health: ok");
    expect(status).toContain("Non-passing runs: 1");
    expect(status).toContain("Telegram next offset: 42");
    expect(status).toContain("Unsent remote outbox reports: 1");

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
  });

  test("renders task summaries", () => {
    const report = tasksListReport([task]);

    expect(report).toContain("Total tasks: 1");
    expect(report).toContain("task-pass");
  });
});
