import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunSummary } from "./ledger";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDashboard(runs: RunSummary[]): string {
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

export async function writeDashboard(path: string, runs: RunSummary[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderDashboard(runs), "utf8");
}
