import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskSpec } from "./contracts";
import type { DaemonHeartbeat } from "./daemon";
import type { RunSummary } from "./ledger";
import type { OpsSnapshot } from "./ops-diagnostics";
import type { ProposalRecord } from "./proposal-store";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { TaskDraftRecord } from "./task-draft-store";

export interface DashboardStatus {
  heartbeat?: DaemonHeartbeat;
  pendingInboxCount?: number;
  ops?: OpsSnapshot;
  proposals?: ProposalRecord[];
  drafts?: TaskDraftRecord[];
  tasks?: TaskSpec[];
  lifecycles?: RunLifecycleRecord[];
  liveRuns?: LiveRunStatus[];
}

export interface LiveRunStatus {
  runId: string;
  taskId: string;
  agentId?: string;
  phase?: string;
  lastEventType?: string;
  lastAt: string;
  liveLogPath: string;
  latestText?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function lifecycleText(lifecycle: RunLifecycleRecord | undefined): string {
  if (!lifecycle) return "missing";
  return `merged=${lifecycle.mergedAt ? "yes" : "no"} pushed=${lifecycle.pushedAt ? "yes" : "no"} cleaned=${lifecycle.cleanedAt ? "yes" : "no"}`;
}

function countByStatus<T extends { status: string }>(items: T[] | undefined): string {
  if (!items) return "unknown";
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ") || "none";
}

export function renderDashboard(runs: RunSummary[], status: DashboardStatus = {}): string {
  const latest = runs.at(-1);
  const latestLifecycle = latest ? status.lifecycles?.find((item) => item.runId === latest.runId) : undefined;
  const failures = runs.filter((run) => !run.pass);
  const completedRunIds = new Set(runs.map((run) => run.runId));
  const liveRuns = (status.liveRuns ?? []).slice().sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const activeLiveRuns = liveRuns.filter((run) => !completedRunIds.has(run.runId));
  const rows = runs
    .slice()
    .reverse()
    .map(
      (run) => `<tr>
  <td>${escapeHtml(run.startedAt)}</td>
  <td>${escapeHtml(run.taskId)}</td>
  <td>${escapeHtml(run.agentId)}</td>
  <td>${escapeHtml(run.outcome)}</td>
  <td>${escapeHtml(run.commit || "-")}</td>
  <td>${escapeHtml(run.failureReason ?? "")}</td>
</tr>`,
    )
    .join("\n");
  const liveRows = liveRuns
    .map(
      (run) => `<tr>
  <td>${escapeHtml(run.lastAt)}</td>
  <td>${escapeHtml(run.taskId)}</td>
  <td>${escapeHtml(run.agentId ?? "-")}</td>
  <td>${completedRunIds.has(run.runId) ? "completed" : "running"}</td>
  <td>${escapeHtml(run.phase ?? "-")}</td>
  <td>${escapeHtml(run.lastEventType ?? "-")}</td>
  <td><code>${escapeHtml(run.liveLogPath)}</code></td>
  <td>${escapeHtml((run.latestText ?? "").slice(0, 240))}</td>
</tr>`,
    )
    .join("\n");
  const heartbeatText = status.heartbeat
    ? `${status.heartbeat.status} pid=${status.heartbeat.pid} updated=${status.heartbeat.updatedAt}`
    : "not recorded";
  const ops = status.ops;
  const replyFailures = ops?.telegram.replyState?.failures ?? [];
  const latestReplyFailure = replyFailures.at(-1);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Samantha Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #1f2937; line-height: 1.4; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 20px 0; }
    .panel { border: 1px solid #d1d5db; border-radius: 6px; padding: 12px; background: #fff; }
    .panel h2 { font-size: 16px; margin: 0 0 8px; }
    .panel p { margin: 6px 0; }
    .ok { color: #166534; font-weight: 600; }
    .warn { color: #92400e; font-weight: 600; }
    .fail { color: #991b1b; font-weight: 600; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    code { background: #f3f4f6; padding: 2px 4px; border-radius: 4px; }
    ul { padding-left: 20px; }
  </style>
</head>
<body>
  <h1>Samantha Dashboard</h1>
  <p>Read-only operating status generated from local Samantha state.</p>
  <section class="summary">
    <div class="panel">
      <h2>Operation</h2>
      <p>Status: <span class="${ops?.ok === false ? "fail" : "ok"}">${escapeHtml(ops ? (ops.ok ? "ok" : "needs attention") : "unknown")}</span></p>
      <p>Failures: <code>${String(ops?.failures.length ?? 0)}</code></p>
      <p>Warnings: <code>${String(ops?.warnings.length ?? 0)}</code></p>
    </div>
    <div class="panel">
      <h2>Queues</h2>
      <p>Pending inbox commands: <code>${String(ops?.queues.pendingInboxCount ?? status.pendingInboxCount ?? 0)}</code></p>
      <p>Remote outbox: <code>${String(ops?.queues.remoteOutboxCount ?? 0)}</code></p>
      <p>Unsent remote outbox: <code>${String(ops?.queues.unsentRemoteOutboxCount ?? 0)}</code></p>
    </div>
    <div class="panel">
      <h2>Telegram</h2>
      <p>Next offset: <code>${escapeHtml(String(ops?.telegram.offset?.nextOffset ?? "missing"))}</code></p>
      <p>Replies: <code>sent=${String(ops?.telegram.replyState?.sentFiles.length ?? 0)} failures=${String(replyFailures.length)}</code></p>
      <p>Latest reply failure: <code>${escapeHtml(latestReplyFailure ? `${latestReplyFailure.file} attempts=${latestReplyFailure.attempts}` : "none")}</code></p>
    </div>
    <div class="panel">
      <h2>Latest Run</h2>
      <p>Run: <code>${escapeHtml(latest?.runId ?? "none")}</code></p>
      <p>Outcome: <code>${escapeHtml(latest?.outcome ?? "none")}</code></p>
      <p>Lifecycle: <code>${escapeHtml(lifecycleText(latestLifecycle))}</code></p>
    </div>
    <div class="panel">
      <h2>Live Workers</h2>
      <p>Live logs: <code>${String(liveRuns.length)}</code></p>
      <p>Running: <code>${String(activeLiveRuns.length)}</code></p>
      <p>Latest task: <code>${escapeHtml(liveRuns[0]?.taskId ?? "none")}</code></p>
      <p>Latest phase: <code>${escapeHtml(liveRuns[0]?.phase ?? "none")}</code></p>
    </div>
  </section>
  <section class="summary">
    <div class="panel">
      <h2>Daemon</h2>
      <p>Heartbeat: <code>${escapeHtml(heartbeatText)}</code></p>
      <p>Processed total: <code>${String(status.heartbeat?.processedTotal ?? 0)}</code></p>
    </div>
    <div class="panel">
      <h2>Remote</h2>
      <p>Latest command: <code>${escapeHtml(ops?.queues.latestRemoteCommand?.type ?? "none")}</code></p>
      <p>Latest command id: <code>${escapeHtml(ops?.queues.latestRemoteCommand?.id ?? "none")}</code></p>
      <p>Latest report: <code>${escapeHtml(ops?.queues.latestRemoteOutbox?.file ?? "none")}</code></p>
    </div>
    <div class="panel">
      <h2>Work Intake</h2>
      <p>Proposals: <code>${escapeHtml(countByStatus(status.proposals))}</code></p>
      <p>Drafts: <code>${escapeHtml(countByStatus(status.drafts))}</code></p>
      <p>Tasks: <code>${escapeHtml(countByStatus(status.tasks))}</code></p>
    </div>
    <div class="panel">
      <h2>Runs</h2>
      <p>Total: <code>${String(runs.length)}</code></p>
      <p>Non-passing: <code>${String(failures.length)}</code></p>
      <p>Latest failure: <code>${escapeHtml(failures.at(-1)?.failureReason ?? "none")}</code></p>
    </div>
  </section>
  <section>
    <h2>Attention</h2>
    <p>Failures</p>
    <ul>${(ops?.failures.length ? ops.failures : ["none"]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    <p>Warnings</p>
    <ul>${(ops?.warnings.length ? ops.warnings : ["none"]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
  </section>
  <section>
    <h2>Live Workers</h2>
    <p>These rows are read from <code>runs/live/*.jsonl</code>. Use <code>tmux attach -t samantha</code> for the live terminal observer.</p>
    <table>
      <thead>
        <tr><th>Updated</th><th>Task</th><th>Agent</th><th>Status</th><th>Phase</th><th>Event</th><th>Live Log</th><th>Latest Text</th></tr>
      </thead>
      <tbody>
${liveRows || '<tr><td colspan="8">No live worker logs found.</td></tr>'}
      </tbody>
    </table>
  </section>
  <section>
    <h2>Recent Runs</h2>
  <table>
    <thead>
      <tr><th>Started</th><th>Task</th><th>Agent</th><th>Outcome</th><th>Commit</th><th>Failure</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </section>
</body>
</html>
`;
}

export async function writeDashboard(path: string, runs: RunSummary[], status: DashboardStatus = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderDashboard(runs, status), "utf8");
}
