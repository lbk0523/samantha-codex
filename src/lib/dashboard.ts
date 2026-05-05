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

function badge(value: string, tone: "success" | "warn" | "fail" | "info" | "neutral"): string {
  return `<span class="badge ${tone}">${escapeHtml(value)}</span>`;
}

function runOutcomeBadge(run: RunSummary): string {
  return badge(run.outcome, run.pass ? "success" : "fail");
}

function liveStatusBadge(isCompleted: boolean): string {
  return badge(isCompleted ? "completed" : "running", isCompleted ? "neutral" : "info");
}

function attentionList(items: string[] | undefined): string {
  const values = items?.length ? items : ["none"];
  return values.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

export function renderDashboard(runs: RunSummary[], status: DashboardStatus = {}): string {
  const generatedAt = new Date().toISOString();
  const latest = runs.at(-1);
  const latestLifecycle = latest ? status.lifecycles?.find((item) => item.runId === latest.runId) : undefined;
  const failures = runs.filter((run) => !run.pass);
  const completedRunIds = new Set(runs.map((run) => run.runId));
  const liveRuns = (status.liveRuns ?? []).slice().sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const activeLiveRuns = liveRuns.filter((run) => !completedRunIds.has(run.runId));
  const ops = status.ops;
  const replyFailures = ops?.telegram.replyState?.failures ?? [];
  const latestReplyFailure = replyFailures.at(-1);
  const operationTone = ops?.ok === false ? "fail" : ops ? "success" : "warn";
  const operationText = ops ? (ops.ok ? "ok" : "needs attention") : "unknown";
  const latestFailure = failures.at(-1);
  const rows = runs
    .slice()
    .reverse()
    .map(
      (run) => `<tr>
  <td>${escapeHtml(run.startedAt)}</td>
  <td>${escapeHtml(run.taskId)}</td>
  <td>${escapeHtml(run.agentId)}</td>
  <td>${runOutcomeBadge(run)}</td>
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
  <td>${liveStatusBadge(completedRunIds.has(run.runId))}</td>
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>Samantha Dashboard</title>
  <style>
    :root {
      --bg: #f6f8fb;
      --panel: #ffffff;
      --text: #111827;
      --muted: #64748b;
      --border: #d8dee8;
      --success: #0f766e;
      --success-bg: #e6fffb;
      --warn: #b45309;
      --warn-bg: #fff7ed;
      --fail: #b91c1c;
      --fail-bg: #fef2f2;
      --info: #2563eb;
      --info-bg: #eff6ff;
      --neutral-bg: #f1f5f9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 24px;
      background: rgba(246, 248, 251, 0.94);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(8px);
    }
    .title h1 { margin: 0; font-size: 18px; font-weight: 750; letter-spacing: 0; }
    .title p { margin: 2px 0 0; color: var(--muted); }
    .toolbar { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .shell { padding: 18px 24px 28px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .kpi, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .kpi { padding: 12px; min-height: 92px; }
    .kpi .label { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .kpi .value { margin-top: 6px; font-size: 22px; font-weight: 780; }
    .kpi .detail { margin-top: 6px; color: var(--muted); overflow-wrap: anywhere; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr); gap: 14px; align-items: start; }
    .stack { display: grid; gap: 14px; }
    .panel h2 { margin: 0; padding: 12px 14px; font-size: 14px; font-weight: 760; border-bottom: 1px solid var(--border); }
    .panel .body { padding: 12px 14px; }
    .facts { display: grid; gap: 8px; }
    .fact { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid #eef2f7; }
    .fact:last-child { border-bottom: 0; padding-bottom: 0; }
    .fact span:first-child { color: var(--muted); }
    .fact span:last-child { text-align: right; overflow-wrap: anywhere; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 750;
      white-space: nowrap;
    }
    .badge.success { color: var(--success); background: var(--success-bg); border-color: #99f6e4; }
    .badge.warn { color: var(--warn); background: var(--warn-bg); border-color: #fed7aa; }
    .badge.fail { color: var(--fail); background: var(--fail-bg); border-color: #fecaca; }
    .badge.info { color: var(--info); background: var(--info-bg); border-color: #bfdbfe; }
    .badge.neutral { color: #475569; background: var(--neutral-bg); border-color: #dbe4ef; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 860px; table-layout: fixed; font-size: 12px; }
    th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th {
      position: sticky;
      top: 67px;
      z-index: 2;
      background: #eef2f7;
      color: #475569;
      font-size: 11px;
      text-transform: uppercase;
    }
    tr:hover td { background: #f8fafc; }
    code {
      background: #eef2f7;
      border: 1px solid #e2e8f0;
      padding: 2px 4px;
      border-radius: 4px;
      color: #334155;
      overflow-wrap: anywhere;
    }
    ul { margin: 0; padding-left: 18px; }
    li + li { margin-top: 6px; }
    .muted { color: var(--muted); }
    .attention { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .attention-block { border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: #fbfdff; }
    .attention-block h3 { margin: 0 0 8px; font-size: 12px; color: #334155; }
    @media (max-width: 980px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .toolbar { justify-content: flex-start; }
      .layout { grid-template-columns: 1fr; }
      th { top: 116px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="title">
      <h1>Samantha Dashboard</h1>
      <p>Read-only operations view for local workers, queues, and run history.</p>
    </div>
    <div class="toolbar">
      ${badge(`status: ${operationText}`, operationTone)}
      ${badge("auto-refresh: 5s", "neutral")}
      ${badge(`generated: ${generatedAt}`, "neutral")}
    </div>
  </header>
  <main class="shell">
    <section class="kpi-grid" aria-label="Operations summary">
      <div class="kpi">
        <div class="label">Operation</div>
        <div class="value">${badge(operationText, operationTone)}</div>
        <div class="detail">Failures ${String(ops?.failures.length ?? 0)} · Warnings ${String(ops?.warnings.length ?? 0)}</div>
      </div>
      <div class="kpi">
        <div class="label">Running Workers</div>
        <div class="value">${String(activeLiveRuns.length)}</div>
        <div class="detail">Live logs ${String(liveRuns.length)} · Latest ${escapeHtml(liveRuns[0]?.phase ?? "none")}</div>
      </div>
      <div class="kpi">
        <div class="label">Pending Inbox</div>
        <div class="value">${String(ops?.queues.pendingInboxCount ?? status.pendingInboxCount ?? 0)}</div>
        <div class="detail">Remote outbox ${String(ops?.queues.remoteOutboxCount ?? 0)} · Unsent ${String(ops?.queues.unsentRemoteOutboxCount ?? 0)}</div>
      </div>
      <div class="kpi">
        <div class="label">Recent Runs</div>
        <div class="value">${String(runs.length)}</div>
        <div class="detail">Non-passing ${String(failures.length)} · Latest ${escapeHtml(latest?.outcome ?? "none")}</div>
      </div>
      <div class="kpi">
        <div class="label">Work Intake</div>
        <div class="value">${String(status.tasks?.length ?? 0)}</div>
        <div class="detail">Tasks ${escapeHtml(countByStatus(status.tasks))}</div>
      </div>
    </section>

    <section class="layout">
      <div class="stack">
        <section class="panel">
          <h2>Live Workers</h2>
          <div class="body">
            <p class="muted">Rows are read from <code>runs/live/*.jsonl</code>. Use <code>tmux attach -t samantha</code> for the terminal observer.</p>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Updated</th><th>Task</th><th>Agent</th><th>Status</th><th>Phase</th><th>Event</th><th>Live Log</th><th>Latest Text</th></tr>
              </thead>
              <tbody>
${liveRows || '<tr><td colspan="8">No live worker logs found.</td></tr>'}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel">
          <h2>Recent Runs</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Started</th><th>Task</th><th>Agent</th><th>Outcome</th><th>Commit</th><th>Failure</th></tr>
              </thead>
              <tbody>
${rows || '<tr><td colspan="6">No run summaries found.</td></tr>'}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <aside class="stack">
        <section class="panel">
          <h2>Attention</h2>
          <div class="body attention">
            <div class="attention-block">
              <h3>Failures</h3>
              <ul>${attentionList(ops?.failures)}</ul>
            </div>
            <div class="attention-block">
              <h3>Warnings</h3>
              <ul>${attentionList(ops?.warnings)}</ul>
            </div>
            <div class="attention-block">
              <h3>Latest run failure</h3>
              <p class="muted">${escapeHtml(latestFailure?.failureReason ?? "none")}</p>
            </div>
          </div>
        </section>

        <section class="panel">
          <h2>Latest Run</h2>
          <div class="body facts">
            <div class="fact"><span>Run</span><span><code>${escapeHtml(latest?.runId ?? "none")}</code></span></div>
            <div class="fact"><span>Outcome</span><span>${latest ? runOutcomeBadge(latest) : badge("none", "neutral")}</span></div>
            <div class="fact"><span>Lifecycle</span><span><code>${escapeHtml(lifecycleText(latestLifecycle))}</code></span></div>
          </div>
        </section>

        <section class="panel">
          <h2>System</h2>
          <div class="body facts">
            <div class="fact"><span>Heartbeat</span><span><code>${escapeHtml(heartbeatText)}</code></span></div>
            <div class="fact"><span>Processed total</span><span><code>${String(status.heartbeat?.processedTotal ?? 0)}</code></span></div>
            <div class="fact"><span>Telegram offset</span><span><code>${escapeHtml(String(ops?.telegram.offset?.nextOffset ?? "missing"))}</code></span></div>
            <div class="fact"><span>Telegram replies</span><span><code>sent=${String(ops?.telegram.replyState?.sentFiles.length ?? 0)} failures=${String(replyFailures.length)}</code></span></div>
            <div class="fact"><span>Latest reply failure</span><span><code>${escapeHtml(latestReplyFailure ? `${latestReplyFailure.file} attempts=${latestReplyFailure.attempts}` : "none")}</code></span></div>
          </div>
        </section>

        <section class="panel">
          <h2>Queues</h2>
          <div class="body facts">
            <div class="fact"><span>Pending inbox commands</span><span><code>${String(ops?.queues.pendingInboxCount ?? status.pendingInboxCount ?? 0)}</code></span></div>
            <div class="fact"><span>Latest command</span><span><code>${escapeHtml(ops?.queues.latestRemoteCommand?.type ?? "none")}</code></span></div>
            <div class="fact"><span>Latest command id</span><span><code>${escapeHtml(ops?.queues.latestRemoteCommand?.id ?? "none")}</code></span></div>
            <div class="fact"><span>Latest report</span><span><code>${escapeHtml(ops?.queues.latestRemoteOutbox?.file ?? "none")}</code></span></div>
          </div>
        </section>

        <section class="panel">
          <h2>Work Intake</h2>
          <div class="body facts">
            <div class="fact"><span>Proposals</span><span><code>${escapeHtml(countByStatus(status.proposals))}</code></span></div>
            <div class="fact"><span>Drafts</span><span><code>${escapeHtml(countByStatus(status.drafts))}</code></span></div>
            <div class="fact"><span>Tasks</span><span><code>${escapeHtml(countByStatus(status.tasks))}</code></span></div>
          </div>
        </section>
      </aside>
    </div>
  </main>
</body>
</html>
`;
}

export async function writeDashboard(path: string, runs: RunSummary[], status: DashboardStatus = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderDashboard(runs, status), "utf8");
}
