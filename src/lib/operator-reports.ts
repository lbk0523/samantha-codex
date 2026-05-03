import type { TaskSpec } from "./contracts";
import type { DaemonHealthResult, DaemonHeartbeat } from "./daemon";
import type { RunSummary } from "./ledger";
import type { OpsSnapshot } from "./ops-diagnostics";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function code(value: string): string {
  return `\`${oneLine(value).replace(/`/g, "'")}\``;
}

function recent<T>(items: T[], limit: number): T[] {
  return [...items].slice(-limit).reverse();
}

function shortCommit(commit: string): string {
  return commit ? commit.slice(0, 12) : "";
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
  return `- ${code(task.id)} status=${code(task.status)} agent=${code(task.targetAgent)}`;
}

export function remoteHelpReport(): string {
  return [
    "# remote:help",
    "",
    "Supported Telegram commands:",
    "",
    "- `/help`: show this help",
    "- `/status`: show daemon and latest run summary",
    "- `/doctor`: show local operation diagnostics",
    "- `/health`: show daemon health check",
    "- `/runs`: show recent run summaries",
    "- `/run <run-id>`: show one run summary",
    "- `/failures`: show recent non-passing runs",
    "- `/tasks`: show known tasks",
    "- `/task <task-id>`: show one task",
    "- `/dashboard`: rebuild the read-only dashboard",
    "",
    "Remote commands are read-only. They cannot dispatch workers, merge, push, clean worktrees, or run shell commands.",
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
  ]
    .filter(Boolean)
    .join("\n");
}

export function failuresReport(runs: RunSummary[], limit = 10): string {
  const failures = runs.filter((run) => !run.pass);
  const lines = recent(failures, limit).map(runLine);
  return [
    "# runs:failures",
    "",
    `Total failures: ${failures.length}`,
    "",
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
    `Target files: ${task.targetFiles.map(code).join(", ") || "none"}`,
    `Verify commands: ${task.verifyCommands.map(code).join(", ") || "none"}`,
  ].join("\n");
}

export function statusReport(input: {
  runs: RunSummary[];
  heartbeat?: DaemonHeartbeat;
  pendingInboxCount: number;
  ops?: OpsSnapshot;
}): string {
  const latest = input.runs.at(-1);
  const failureCount = input.runs.filter((run) => !run.pass).length;
  const heartbeat = input.heartbeat
    ? `${input.heartbeat.status} pid=${input.heartbeat.pid} updated=${input.heartbeat.updatedAt} processed=${input.heartbeat.processedTotal}`
    : "missing";

  return [
    "# status",
    "",
    `Daemon heartbeat: ${code(heartbeat)}`,
    input.ops ? `Operation health: ${input.ops.ok ? "ok" : "needs attention"}` : "",
    input.ops ? `Doctor failures: ${input.ops.failures.length}` : "",
    input.ops ? `Doctor warnings: ${input.ops.warnings.length}` : "",
    `Pending inbox commands: ${input.pendingInboxCount}`,
    input.ops ? `Remote outbox reports: ${input.ops.queues.remoteOutboxCount}` : "",
    input.ops ? `Unsent remote outbox reports: ${input.ops.queues.unsentRemoteOutboxCount}` : "",
    input.ops
      ? input.ops.telegram.offset?.nextOffset !== undefined
        ? `Telegram next offset: ${input.ops.telegram.offset.nextOffset}`
        : "Telegram next offset: missing"
      : "",
    input.ops
      ? input.ops.telegram.replyState
        ? `Telegram replies: sent=${input.ops.telegram.replyState.sentFiles.length} updated=${code(input.ops.telegram.replyState.updatedAt)}`
        : "Telegram replies: missing"
      : "",
    `Total runs: ${input.runs.length}`,
    `Non-passing runs: ${failureCount}`,
    latest ? `Latest run: ${oneLine(runLine(latest).slice(2))}` : "Latest run: none",
  ]
    .filter(Boolean)
    .join("\n");
}

export function healthReport(health: DaemonHealthResult): string {
  const lines = [
    "# health:check",
    "",
    `OK: ${health.ok ? "yes" : "no"}`,
    health.ageMs !== undefined ? `Heartbeat age: ${health.ageMs}ms` : "",
    health.heartbeat
      ? `Heartbeat: ${code(`${health.heartbeat.status} pid=${health.heartbeat.pid} updated=${health.heartbeat.updatedAt}`)}`
      : "Heartbeat: missing",
    health.lock ? `Lock: ${code(`pid=${health.lock.pid} started=${health.lock.startedAt}`)}` : "Lock: missing",
    "",
    "Violations:",
    ...(health.violations.length ? health.violations.map((violation) => `- ${oneLine(violation)}`) : ["- none"]),
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
    `Overall: ${snapshot.ok ? "ok" : "needs attention"}`,
    `Checked at: ${code(snapshot.checkedAt)}`,
    "",
    "Environment:",
    `- .env file: ${snapshot.env.envFileExists ? "present" : "missing"} (${code(snapshot.env.envFilePath)})`,
    `- TELEGRAM_BOT_TOKEN: ${snapshot.env.hasBotToken ? "present" : "missing"}`,
    `- poll chat id: ${snapshot.env.hasPollChatId ? "present" : "missing"}`,
    `- reply chat id: ${snapshot.env.hasReplyChatId ? "present" : "missing"}`,
    "",
    "Daemon:",
    `- health: ${snapshot.health.ok ? "ok" : "failed"}`,
    snapshot.health.ageMs !== undefined ? `- heartbeat age: ${snapshot.health.ageMs}ms` : "- heartbeat age: unknown",
    snapshot.health.heartbeat
      ? `- heartbeat: ${code(`${snapshot.health.heartbeat.status} pid=${snapshot.health.heartbeat.pid} updated=${snapshot.health.heartbeat.updatedAt}`)}`
      : "- heartbeat: missing",
    "",
    "Queues:",
    `- pending inbox: ${snapshot.queues.pendingInboxCount}`,
    `- outbox reports: ${snapshot.queues.outboxCount}`,
    `- remote outbox reports: ${snapshot.queues.remoteOutboxCount}`,
    `- unsent remote outbox reports: ${snapshot.queues.unsentRemoteOutboxCount}`,
    "",
    "Telegram state:",
    snapshot.telegram.offset?.nextOffset !== undefined
      ? `- next offset: ${snapshot.telegram.offset.nextOffset}`
      : "- next offset: missing",
    snapshot.telegram.replyState
      ? `- replies: sent=${snapshot.telegram.replyState.sentFiles.length} updated=${code(snapshot.telegram.replyState.updatedAt)}`
      : "- replies: missing",
    "",
    "systemd templates:",
    ...systemdLines,
    "",
    "Failures:",
    ...(snapshot.failures.length ? snapshot.failures.map((failure) => `- ${oneLine(failure)}`) : ["- none"]),
    "",
    "Warnings:",
    ...(snapshot.warnings.length ? snapshot.warnings.map((warning) => `- ${oneLine(warning)}`) : ["- none"]),
  ].join("\n");
}
