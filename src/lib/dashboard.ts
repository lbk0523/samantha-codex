import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DaemonHeartbeat } from "./daemon";
import type { RunSummary } from "./ledger";

export interface DashboardStatus {
  heartbeat?: DaemonHeartbeat;
  pendingInboxCount?: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDashboard(runs: RunSummary[], status: DashboardStatus = {}): string {
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
  const heartbeatText = status.heartbeat
    ? `${status.heartbeat.status} pid=${status.heartbeat.pid} updated=${status.heartbeat.updatedAt}`
    : "not recorded";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Samantha Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #1f2937; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    code { background: #f3f4f6; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Samantha Dashboard</h1>
  <p>Read-only run status generated from <code>state/runs.jsonl</code>.</p>
  <section>
    <h2>Daemon</h2>
    <p>Heartbeat: <code>${escapeHtml(heartbeatText)}</code></p>
    <p>Pending inbox commands: <code>${String(status.pendingInboxCount ?? 0)}</code></p>
  </section>
  <table>
    <thead>
      <tr><th>Started</th><th>Task</th><th>Agent</th><th>Outcome</th><th>Commit</th><th>Failure</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

export async function writeDashboard(path: string, runs: RunSummary[], status: DashboardStatus = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderDashboard(runs, status), "utf8");
}
