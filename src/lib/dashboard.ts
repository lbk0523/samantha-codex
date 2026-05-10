import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CeoStatusSnapshot } from "./ceo-status";
import type { TaskSpec } from "./contracts";
import type { DaemonHeartbeat } from "./daemon";
import type { RunSummary } from "./ledger";
import { buildOperatingSurfaceView, type OperatingSurfaceItem } from "./operating-surface";
import type { OpsSnapshot } from "./ops-diagnostics";
import { formatProjectQueueSnapshot } from "./project-queues";
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
  ceoStatus?: CeoStatusSnapshot;
}

export interface LiveRunEvent {
  at: string;
  type: string;
  phase?: string;
  text?: string;
  command?: string;
  exitCode?: number;
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
  events: LiveRunEvent[];
}

type BadgeTone = "success" | "warn" | "fail" | "info" | "neutral";
type Page = "overview" | "lane-view";

interface LiveRunView {
  label: "running" | "stale" | "failed" | "completed";
  tone: BadgeTone;
  className: string;
}

interface DashboardView {
  generatedAt: string;
  nowMs: number;
  latest?: RunSummary;
  latestLifecycle?: RunLifecycleRecord;
  failures: RunSummary[];
  completedRunIds: Set<string>;
  failedRunIds: Set<string>;
  liveRuns: LiveRunStatus[];
  activeLiveRuns: LiveRunStatus[];
  ops?: OpsSnapshot;
  operationText: string;
  operationTone: BadgeTone;
  currentProblemItems: string[];
  liveProblemItems: string[];
  runFailureItems: string[];
  nextAction: string;
  latestTimeline?: TimelineEvent;
  timelineEvents: TimelineEvent[];
}

interface TimelineEvent {
  run: LiveRunStatus;
  event: LiveRunEvent;
}

interface DashboardDisplayEvent {
  timeLabel: string;
  kindLabel: string;
  importance: "high" | "normal" | "low";
  phaseLabel: string;
  primaryText: string;
  secondaryText?: string;
  meta: string[];
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

function countStatus<T extends { status: string }>(items: T[] | undefined, status: string): number {
  return items?.filter((item) => item.status === status).length ?? 0;
}

function badge(value: string, tone: BadgeTone): string {
  return `<span class="badge ${tone}">${escapeHtml(value)}</span>`;
}

function runOutcomeBadge(run: RunSummary): string {
  return badge(run.outcome, run.pass ? "success" : "fail");
}

function ceoOverallTone(status: CeoStatusSnapshot["overall"]): BadgeTone {
  if (status === "idle") return "success";
  if (status === "active") return "info";
  if (status === "needs_decision" || status === "blocked") return "warn";
  return "fail";
}

function attentionList(items: string[]): string {
  const values = items.length ? items : ["none"];
  return values.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function surfaceItemText(item: OperatingSurfaceItem): string {
  return item.text;
}

function ceoList<T>(items: T[], render: (item: T) => string, empty = "none", limit = 6): string {
  const shown = items.slice(0, limit);
  const values = shown.length ? shown.map((item) => `<li>${escapeHtml(render(item))}</li>`) : [`<li>${escapeHtml(empty)}</li>`];
  if (items.length > shown.length) values.push(`<li>${String(items.length - shown.length)} more</li>`);
  return values.join("");
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTimestamp(value: string, nowMs: number): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "-";
  const date = new Date(ms);
  const now = new Date(nowMs);
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  const monthDay = `${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
  if (date.getFullYear() === now.getFullYear()) return `${monthDay} ${time.slice(0, 5)}`;
  return `${date.getFullYear()}-${monthDay} ${time.slice(0, 5)}`;
}

function compactPath(path: string): string {
  if (path.length <= 84) return path;
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : path.slice(-84);
}

function trimLines(value: string, limit: number): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
    .join("\n");
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function itemRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function commandDisplay(command: unknown): string {
  const value = Array.isArray(command) ? command.map(String).join(" ") : typeof command === "string" ? command : "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 150 ? `${oneLine.slice(0, 147)}...` : oneLine;
}

function harnessResultText(text: string): { primaryText: string; secondaryText?: string } | undefined {
  const match = text.match(/HARNESS_RESULT:\s*(\{.*\})/s);
  if (!match?.[1]) return undefined;
  const parsed = parseJsonObject(match[1]);
  const status = typeof parsed?.status === "string" ? parsed.status : "unknown";
  const note = typeof parsed?.note === "string" && parsed.note.trim() ? parsed.note.trim() : undefined;
  return {
    primaryText: `Result: ${status}`,
    ...(note ? { secondaryText: note } : {}),
  };
}

function structuredTextDisplay(text: string): Partial<DashboardDisplayEvent> | undefined {
  const lines = text.split(/\r?\n/);
  const exitLineIndex = lines.findIndex((line) => line.startsWith("[cmd:exit"));
  if (exitLineIndex !== -1) {
    const commandExit = lines[exitLineIndex]?.match(/^\[cmd:exit\s+([^\]]+)\]\s*([^\n]*)$/);
    if (commandExit) {
      const exitCode = commandExit[1] ?? "?";
      const command = commandDisplay(commandExit[2] ?? "");
      const failed = exitCode !== "0";
      return {
        kindLabel: failed ? "Command failed" : "Command passed",
        importance: failed ? "high" : "normal",
        primaryText: `${failed ? `Failed exit ${exitCode}` : "Passed"}${command ? `: ${command}` : ""}`,
        secondaryText: trimLines(lines.slice(exitLineIndex + 1).join("\n"), 3) || undefined,
        meta: [`exit ${exitCode}`],
      };
    }
  }

  const commandStart = text.match(/^\[cmd:start\]\s*(.+)$/s);
  if (commandStart?.[1]) {
    return {
      kindLabel: "Command started",
      primaryText: `Started: ${commandDisplay(commandStart[1])}`,
    };
  }

  const commandExit = text.match(/^\[cmd:exit\s+([^\]]+)\]\s*([^\n]*)(?:\n([\s\S]*))?$/);
  if (commandExit) {
    const exitCode = commandExit[1] ?? "?";
    const command = commandDisplay(commandExit[2] ?? "");
    const failed = exitCode !== "0";
    return {
      kindLabel: failed ? "Command failed" : "Command passed",
      importance: failed ? "high" : "normal",
      primaryText: `${failed ? `Failed exit ${exitCode}` : "Passed"}${command ? `: ${command}` : ""}`,
      secondaryText: commandExit[3] ? trimLines(commandExit[3], 3) : undefined,
      meta: [`exit ${exitCode}`],
    };
  }

  const harness = harnessResultText(text);
  if (harness) {
    return {
      kindLabel: "Worker result",
      primaryText: harness.primaryText,
      secondaryText: harness.secondaryText,
      importance: harness.primaryText.includes("pass") ? "normal" : "high",
    };
  }

  const parsed = parseJsonObject(text);
  if (!parsed) return undefined;
  const type = typeof parsed.type === "string" ? parsed.type : "event";
  const item = itemRecord(parsed.item);
  const itemType = typeof item?.type === "string" ? item.type : "";

  if (type === "thread.started") return { kindLabel: "Thread", primaryText: "Thread started", importance: "low" };
  if (type === "turn.started") return { kindLabel: "Turn", primaryText: "Turn started", importance: "low" };
  if (type === "turn.completed") return undefined;

  if (type === "item.started" && itemType === "command_execution") {
    const command = commandDisplay(item?.command);
    return {
      kindLabel: "Command started",
      primaryText: command ? `Started: ${command}` : "Command started",
    };
  }

  if (type === "item.completed" && itemType === "command_execution") {
    const command = commandDisplay(item?.command);
    const exitCode = typeof item?.exit_code === "number" ? item.exit_code : undefined;
    const failed = exitCode !== undefined && exitCode !== 0;
    return {
      kindLabel: failed ? "Command failed" : "Command passed",
      importance: failed ? "high" : "normal",
      primaryText: `${failed ? `Failed exit ${exitCode}` : "Passed"}${command ? `: ${command}` : ""}`,
      secondaryText: typeof item?.aggregated_output === "string" ? trimLines(item.aggregated_output, 3) : undefined,
      meta: exitCode === undefined ? [] : [`exit ${exitCode}`],
    };
  }

  if (type === "item.completed" && itemType === "file_change") {
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    const paths = changes
      .map((change) => itemRecord(change)?.path)
      .filter((path): path is string => typeof path === "string");
    const shown = paths.slice(0, 3).map(compactPath);
    return {
      kindLabel: "File changes",
      primaryText: `Changed ${String(paths.length)} file${paths.length === 1 ? "" : "s"}`,
      secondaryText: shown.length ? `${shown.join("\n")}${paths.length > shown.length ? `\n+${paths.length - shown.length} more` : ""}` : undefined,
    };
  }

  if (type === "item.started" && itemType === "file_change") {
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    const paths = changes
      .map((change) => itemRecord(change)?.path)
      .filter((path): path is string => typeof path === "string");
    const shown = paths.slice(0, 3).map(compactPath);
    return {
      kindLabel: "File changes",
      primaryText: `Changing ${String(paths.length)} file${paths.length === 1 ? "" : "s"}`,
      secondaryText: shown.length ? `${shown.join("\n")}${paths.length > shown.length ? `\n+${paths.length - shown.length} more` : ""}` : undefined,
    };
  }

  if (type === "item.completed" && itemType === "agent_message") {
    const message = typeof item?.text === "string" ? item.text : "";
    const harnessMessage = harnessResultText(message);
    if (harnessMessage) {
      return {
        kindLabel: "Worker result",
        primaryText: harnessMessage.primaryText,
        secondaryText: harnessMessage.secondaryText,
        importance: harnessMessage.primaryText.includes("pass") ? "normal" : "high",
      };
    }
    return {
      kindLabel: "Agent update",
      primaryText: trimLines(message, 1) || "Agent update",
      secondaryText: trimLines(message.split(/\r?\n/).slice(1).join("\n"), 2) || undefined,
    };
  }

  return {
    kindLabel: "Structured event",
    primaryText: [type, itemType].filter(Boolean).join(" / "),
    importance: "low",
  };
}

function displayEventFor(run: LiveRunStatus, event: LiveRunEvent, view: DashboardView): DashboardDisplayEvent {
  const base: DashboardDisplayEvent = {
    timeLabel: formatTimestamp(event.at, view.nowMs),
    kindLabel: event.type === "stderr" ? "Worker error" : event.type === "stdout" ? "Worker output" : event.type,
    importance: event.type === "stderr" ? "high" : "normal",
    phaseLabel: event.phase ?? "-",
    primaryText: "-",
    meta: [],
  };

  if (event.type === "command_start") {
    return {
      ...base,
      kindLabel: "Command started",
      primaryText: event.command ? `Started: ${commandDisplay(event.command)}` : "Command started",
    };
  }
  if (event.type === "command_exit") {
    const failed = typeof event.exitCode === "number" && event.exitCode !== 0;
    return {
      ...base,
      kindLabel: failed ? "Command failed" : "Command passed",
      importance: failed ? "high" : "normal",
      primaryText: `${failed ? `Failed exit ${String(event.exitCode)}` : "Passed"}${event.command ? `: ${commandDisplay(event.command)}` : ""}`,
      meta: typeof event.exitCode === "number" ? [`exit ${event.exitCode}`] : [],
    };
  }
  if (event.type === "meta") {
    return {
      ...base,
      kindLabel: "Run metadata",
      importance: "low",
      primaryText: `Run started for ${run.taskId}`,
    };
  }

  const structured = event.text ? structuredTextDisplay(event.text) : undefined;
  if (structured) {
    return {
      ...base,
      ...structured,
      phaseLabel: event.phase ?? base.phaseLabel,
      meta: [...(structured.meta ?? []), ...(typeof event.exitCode === "number" ? [`exit ${event.exitCode}`] : [])],
    };
  }

  const rawText = event.text ? trimLines(event.text, 3) : "";
  return {
    ...base,
    kindLabel: event.type === "stderr" ? "Worker error" : "Worker output",
    primaryText: rawText || "-",
    meta: typeof event.exitCode === "number" ? [`exit ${event.exitCode}`] : [],
  };
}

function liveRunView(input: {
  run: LiveRunStatus;
  completedRunIds: Set<string>;
  failedRunIds: Set<string>;
  nowMs: number;
}): LiveRunView {
  if (input.failedRunIds.has(input.run.runId)) {
    return { label: "failed", tone: "fail", className: "failed" };
  }
  if (input.completedRunIds.has(input.run.runId)) {
    return { label: "completed", tone: "neutral", className: "completed" };
  }
  if ((input.run.events ?? []).some((event) => typeof event.exitCode === "number" && event.exitCode !== 0)) {
    return { label: "failed", tone: "fail", className: "failed" };
  }

  const lastAtMs = Date.parse(input.run.lastAt);
  if (Number.isFinite(lastAtMs) && input.nowMs - lastAtMs > 15 * 60 * 1000) {
    return { label: "stale", tone: "warn", className: "stale" };
  }
  return { label: "running", tone: "info", className: "running" };
}

function timelineEvents(liveRuns: LiveRunStatus[]): TimelineEvent[] {
  return liveRuns
    .flatMap((run) => (run.events ?? []).map((event) => ({ run, event })))
    .sort((a, b) => b.event.at.localeCompare(a.event.at));
}

function nextActionText(input: {
  ops?: OpsSnapshot;
  activeLiveRuns: LiveRunStatus[];
  failures: RunSummary[];
  currentProblemItems: string[];
  tasks?: TaskSpec[];
}): string {
  if (input.ops?.ok === false) return "Clear operation failures";
  if (input.currentProblemItems.length > 0) return "Inspect current attention";
  if (input.activeLiveRuns.length > 0) return "Watch active worker timeline";
  const pendingTask = input.tasks?.find((task) => task.status === "pending");
  if (pendingTask) return `Dispatch pending task: ${pendingTask.id}`;
  if (input.failures.length > 0) return `Review latest historical run failure: ${input.failures.at(-1)?.runId ?? "unknown"}`;
  return "None";
}

function buildView(runs: RunSummary[], status: DashboardStatus): DashboardView {
  const generatedAt = new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const latest = runs.at(-1);
  const latestLifecycle = latest ? status.lifecycles?.find((item) => item.runId === latest.runId) : undefined;
  const failures = runs.filter((run) => !run.pass);
  const completedRunIds = new Set(runs.map((run) => run.runId));
  const failedRunIds = new Set(failures.map((run) => run.runId));
  const liveRuns = (status.liveRuns ?? []).slice().sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const activeLiveRuns = liveRuns.filter((run) => !completedRunIds.has(run.runId));
  const ops = status.ops;
  const operationTone = ops?.ok === false ? "fail" : ops ? "success" : "warn";
  const operationText = ops ? (ops.ok ? "ok" : "needs attention") : "unknown";
  const liveProblemItems = activeLiveRuns
    .map((run) => ({ run, state: liveRunView({
      run,
      nowMs,
      completedRunIds,
      failedRunIds,
    }) }))
    .filter(({ state }) => state.label === "failed" || state.label === "stale")
    .map(({ run, state }) => `${run.taskId} is ${state.label}`);
  const replyFailures = ops?.telegram.replyState?.failures ?? [];
  const currentProblemItems = [
    ...(ops?.failures ?? []),
    ...(ops?.warnings ?? []),
    ...replyFailures.map((failure) => `telegram reply failed: ${failure.file}`),
    ...liveProblemItems,
  ];
  const runFailureItems = failures.map((run) => `run failed: ${run.taskId}${run.failureReason ? ` - ${run.failureReason}` : ""}`);
  const allTimelineEvents = timelineEvents(liveRuns);
  return {
    generatedAt,
    nowMs,
    latest,
    latestLifecycle,
    failures,
    completedRunIds,
    failedRunIds,
    liveRuns,
    activeLiveRuns,
    ops,
    operationText,
    operationTone,
    currentProblemItems,
    liveProblemItems,
    runFailureItems,
    nextAction: nextActionText({ ops, activeLiveRuns, failures, currentProblemItems, tasks: status.tasks }),
    latestTimeline: allTimelineEvents[0],
    timelineEvents: allTimelineEvents,
  };
}

function navLink(page: Page, active: Page, href: string, label: string): string {
  return `<a class="nav-link${page === active ? " active" : ""}" href="${href}">${escapeHtml(label)}</a>`;
}

function renderShell(input: {
  page: Page;
  title: string;
  subtitle: string;
  view: DashboardView;
  content: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>Samantha Dashboard - ${escapeHtml(input.title)}</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --text: #111827;
      --muted: #64748b;
      --border: #d8dee8;
      --strong-border: #aab6c5;
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
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 22px;
      background: rgba(245, 247, 250, 0.96);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(8px);
    }
    .title h1 { margin: 0; font-size: 18px; font-weight: 760; letter-spacing: 0; }
    .title p { margin: 2px 0 0; color: var(--muted); }
    .toolbar { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .app-shell { display: grid; grid-template-columns: 180px minmax(0, 1fr); min-height: calc(100vh - 66px); }
    .lnb {
      position: sticky;
      top: 66px;
      height: calc(100vh - 66px);
      padding: 16px 12px;
      border-right: 1px solid var(--border);
      background: #eef2f7;
    }
    .nav-link {
      display: flex;
      align-items: center;
      min-height: 34px;
      margin-bottom: 6px;
      padding: 7px 10px;
      border: 1px solid transparent;
      border-radius: 6px;
      color: #334155;
      font-weight: 700;
      text-decoration: none;
    }
    .nav-link.active {
      background: var(--panel);
      border-color: var(--strong-border);
      color: var(--text);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .content-shell { min-width: 0; padding: 18px 22px 28px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .kpi, .panel, .lane-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .kpi { padding: 12px; min-height: 92px; }
    .kpi .label { color: var(--muted); font-size: 11px; font-weight: 720; text-transform: uppercase; }
    .kpi .value { margin-top: 6px; font-size: 22px; font-weight: 780; overflow-wrap: anywhere; }
    .kpi .detail { margin-top: 6px; color: var(--muted); overflow-wrap: anywhere; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr); gap: 14px; align-items: start; min-width: 0; }
    .layout > .stack, .panel, .lane-card { min-width: 0; }
    .stack { display: grid; gap: 14px; min-width: 0; }
    .panel h2, .lane-card h2 { margin: 0; padding: 12px 14px; font-size: 14px; font-weight: 760; border-bottom: 1px solid var(--border); }
    .panel .body { padding: 12px 14px; }
    .facts { display: grid; gap: 8px; }
    .fact { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid #eef2f7; }
    .fact:last-child { border-bottom: 0; padding-bottom: 0; }
    .fact span:first-child { color: var(--muted); }
    .fact span:last-child { text-align: right; overflow-wrap: anywhere; }
    .ceo-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
    .ceo-block { display: grid; gap: 8px; align-content: start; min-width: 0; }
    .ceo-block h3 { margin: 0; font-size: 12px; color: #334155; }
    .ceo-list { margin: 0; padding-left: 18px; color: #334155; }
    .ceo-list li { overflow-wrap: anywhere; }
    .ceo-next { display: grid; gap: 6px; min-width: 0; }
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
    table { border-collapse: collapse; width: 100%; min-width: 760px; table-layout: fixed; font-size: 12px; }
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
    .timeline { display: grid; gap: 8px; min-width: 0; }
    .timeline-item {
      display: grid;
      gap: 6px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fbfdff;
      min-width: 0;
    }
    .timeline-item.high { border-color: #fecaca; background: #fffafa; }
    .timeline-item.low { opacity: 0.72; }
    .event-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; min-width: 0; }
    .event-kind { font-weight: 780; color: #334155; }
    .event-title { min-width: 0; font-weight: 760; overflow-wrap: anywhere; }
    .event-text { min-width: 0; color: #334155; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .event-secondary { min-width: 0; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .lane-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 12px; }
    .lane-card { border-top: 4px solid var(--info); }
    .lane-card.completed { opacity: 0.68; border-top-color: #94a3b8; }
    .lane-card.stale { border-top-color: var(--warn); }
    .lane-card.failed { border-top-color: var(--fail); }
    .lane-card.running { border-top-color: var(--info); }
    .lane-head { display: grid; gap: 7px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
    .lane-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .lane-title h2 { padding: 0; border: 0; overflow-wrap: anywhere; }
    .lane-events { display: grid; gap: 0; padding: 4px 0; }
    .lane-event { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 10px; padding: 10px 14px; border-top: 1px solid #eef2f7; }
    .lane-event:first-child { border-top: 0; }
    .lane-phase { color: #334155; font-size: 11px; font-weight: 780; text-transform: uppercase; }
    .empty-state { padding: 22px; border: 1px dashed var(--strong-border); border-radius: 6px; color: var(--muted); background: #fbfdff; }
    @media (max-width: 1120px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .toolbar { justify-content: flex-start; }
      .app-shell { grid-template-columns: 1fr; }
      .lnb {
        position: static;
        display: flex;
        gap: 8px;
        height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }
      .nav-link { margin-bottom: 0; }
      .layout { grid-template-columns: 1fr; }
      .ceo-grid { grid-template-columns: 1fr; }
      th { top: 116px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="title">
      <h1>Samantha Dashboard</h1>
      <p>${escapeHtml(input.subtitle)}</p>
    </div>
    <div class="toolbar">
      ${badge(`status: ${input.view.operationText}`, input.view.operationTone)}
      ${badge("read-only", "neutral")}
      ${badge("auto-refresh: 5s", "neutral")}
      ${badge(`generated: ${formatTimestamp(input.view.generatedAt, input.view.nowMs)}`, "neutral")}
    </div>
  </header>
  <div class="app-shell">
    <nav class="lnb" aria-label="Dashboard pages">
      ${navLink("overview", input.page, "index.html", "Overview")}
      ${navLink("lane-view", input.page, "lane-view.html", "Lane View")}
    </nav>
    <main class="content-shell">
      ${input.content}
    </main>
  </div>
</body>
</html>
`;
}

function renderTimeline(view: DashboardView): string {
  if (!view.timelineEvents.length) {
    return `<div class="empty-state">No live worker logs found.</div>`;
  }

  return `<div class="timeline">
${view.timelineEvents
  .map(({ run, event }) => {
    const state = liveRunView({
      run,
      nowMs: view.nowMs,
      completedRunIds: view.completedRunIds,
      failedRunIds: view.failedRunIds,
    });
    const display = displayEventFor(run, event, view);
    return `<article class="timeline-item ${display.importance}">
  <div class="event-meta">
    <span>${escapeHtml(display.timeLabel)}</span>
    ${badge(state.label, state.tone)}
    <span class="event-kind">${escapeHtml(display.kindLabel)}</span>
    <code>${escapeHtml(display.phaseLabel)}</code>
    ${display.meta.map((item) => `<code>${escapeHtml(item)}</code>`).join("")}
  </div>
  <div class="event-title">${escapeHtml(run.taskId)} <span class="muted">${escapeHtml(run.agentId ?? "-")}</span></div>
  <div class="event-text">${escapeHtml(display.primaryText)}</div>
  ${display.secondaryText ? `<div class="event-secondary">${escapeHtml(display.secondaryText)}</div>` : ""}
</article>`;
  })
  .join("\n")}
</div>`;
}

function renderRecentRuns(runs: RunSummary[], view: DashboardView): string {
  const rows = runs
    .slice()
    .reverse()
    .map(
      (run) => `<tr>
  <td>${escapeHtml(formatTimestamp(run.startedAt, view.nowMs))}</td>
  <td>${escapeHtml(run.taskId)}</td>
  <td>${escapeHtml(run.agentId)}</td>
  <td>${runOutcomeBadge(run)}</td>
  <td>${escapeHtml(run.commit || "-")}</td>
  <td>${escapeHtml(run.failureReason ?? "")}</td>
</tr>`,
    )
    .join("\n");

  return `<section class="panel">
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
</section>`;
}

function renderCeoStatus(status: CeoStatusSnapshot | undefined): string {
  if (!status) {
    return `<section class="panel">
  <h2>Daily Review</h2>
  <div class="body facts">
    <div class="fact"><span>Overall</span><span>${badge("unknown", "neutral")}</span></div>
    <div class="fact"><span>Next safe action</span><span><code>unknown</code></span></div>
  </div>
</section>`;
  }

  const operating = buildOperatingSurfaceView(status);
  const telegram = operating.primaryAction.telegramCommand ? `Telegram: ${operating.primaryAction.telegramCommand}` : "";
  const local = operating.primaryAction.localCommand ? `Local fallback: ${operating.primaryAction.localCommand}` : "";
  const projectQueueLines = status.projectQueues ? formatProjectQueueSnapshot(status.projectQueues) : [];
  const ranking = status.ranking;
  const rankedItems = ranking?.candidates.slice(0, 5).map((item) =>
    `#${item.rank} ${item.action.label} [${item.signal}, score=${item.score}]`,
  ) ?? [];

  return `<section class="panel" aria-label="CEO status review">
  <h2>Daily Review</h2>
  <div class="body">
    <div class="ceo-next">
      <div><strong>${escapeHtml(operating.headline)}</strong></div>
      <div class="muted">${escapeHtml(operating.summary)}</div>
    </div>
    <div class="facts">
      <div class="fact"><span>Overall</span><span>${badge(status.overall, ceoOverallTone(status.overall))}</span></div>
      ${status.projectFilterId ? `<div class="fact"><span>Project filter</span><span><code>${escapeHtml(status.projectFilterId)}</code></span></div>` : ""}
      <div class="fact"><span>BK decisions</span><span><code>${String(status.needsDecision.length)}</code></span></div>
      <div class="fact"><span>Active work</span><span><code>${String(status.active.length)}</code></span></div>
      <div class="fact"><span>Blocked / recovery</span><span><code>${String(status.blocked.length)}</code></span></div>
      <div class="fact"><span>Historical failures</span><span><code>${String(status.historicalFailures.length)}</code></span></div>
      <div class="fact"><span>Risks</span><span><code>${String(status.risks.length)}</code></span></div>
    </div>
    <div class="ceo-grid">
      <div class="ceo-block">
        <h3>BK Decisions</h3>
        <ul class="ceo-list">${ceoList(operating.sections.needsDecision, surfaceItemText)}</ul>
      </div>
      <div class="ceo-block">
        <h3>Active Work</h3>
        <ul class="ceo-list">${ceoList(operating.sections.active, surfaceItemText)}</ul>
      </div>
      <div class="ceo-block">
        <h3>Blockers</h3>
        <ul class="ceo-list">${ceoList(operating.sections.blocked, surfaceItemText)}</ul>
      </div>
      <div class="ceo-block">
        <h3>Historical Failures</h3>
        <ul class="ceo-list">${ceoList(operating.sections.historicalFailures, surfaceItemText)}</ul>
      </div>
      <div class="ceo-block">
        <h3>Completed Work</h3>
        <ul class="ceo-list">${ceoList(operating.sections.completed, surfaceItemText)}</ul>
      </div>
      <div class="ceo-block">
        <h3>Risks</h3>
        <ul class="ceo-list">${ceoList(operating.sections.risks, (risk) => risk)}</ul>
      </div>
      <div class="ceo-block">
        <h3>Top Recommendation / Next Safe Action</h3>
        <div class="ceo-next">
          <div>${escapeHtml(operating.primaryAction.label)}</div>
          ${telegram ? `<div><code>${escapeHtml(telegram)}</code></div>` : ""}
          ${local ? `<div><code>${escapeHtml(local)}</code></div>` : ""}
          <div class="muted">${escapeHtml(operating.primaryAction.reason)}</div>
          ${ranking?.top ? `<div class="muted">${escapeHtml(ranking.top.explanation)}</div>` : ""}
        </div>
      </div>
      <div class="ceo-block">
        <h3>CEO Ranking</h3>
        <ul class="ceo-list">${ceoList(rankedItems, (line) => line, "none", 5)}</ul>
        ${ranking?.tieBreaker ? `<div class="muted">${escapeHtml(`Tie-breaker: ${ranking.tieBreaker}`)}</div>` : ""}
      </div>
      ${
        projectQueueLines.length
          ? `<div class="ceo-block">
        <h3>Project Queues</h3>
        <ul class="ceo-list">${ceoList(projectQueueLines, (line) => line, "none", 12)}</ul>
      </div>`
          : ""
      }
    </div>
  </div>
</section>`;
}

function renderOverviewContent(runs: RunSummary[], status: DashboardStatus, view: DashboardView): string {
  const replyFailures = view.ops?.telegram.replyState?.failures ?? [];
  const latestReplyFailure = replyFailures.at(-1);
  const liveRunStates = view.liveRuns.map((run) => ({
    run,
    state: liveRunView({
      run,
      nowMs: view.nowMs,
      completedRunIds: view.completedRunIds,
      failedRunIds: view.failedRunIds,
    }),
  }));
  const runningLiveRuns = liveRunStates.filter(({ state }) => state.label === "running");
  const staleLiveRuns = liveRunStates.filter(({ state }) => state.label === "stale");
  const completedLiveRuns = liveRunStates.filter(({ state }) => state.label === "completed");
  const heartbeatText = status.heartbeat
    ? `${status.heartbeat.status} pid=${status.heartbeat.pid} updated=${formatTimestamp(status.heartbeat.updatedAt, view.nowMs)}`
    : "not recorded";
  const latestFailure = view.failures.at(-1);
  const pendingTasks = countStatus(status.tasks, "pending");

  return `<section class="kpi-grid" aria-label="Operations summary">
  <div class="kpi">
    <div class="label">Running Workers</div>
    <div class="value">${String(runningLiveRuns.length)}</div>
    <div class="detail">Stale ${String(staleLiveRuns.length)} · Live logs ${String(view.liveRuns.length)} · Completed logs ${String(completedLiveRuns.length)}</div>
  </div>
  <div class="kpi">
    <div class="label">Current Problems</div>
    <div class="value">${String(view.currentProblemItems.length)}</div>
    <div class="detail">Ops failures ${String(view.ops?.failures.length ?? 0)} · Warnings ${String(view.ops?.warnings.length ?? 0)} · Live issues ${String(view.liveProblemItems.length)}</div>
  </div>
  <div class="kpi">
    <div class="label">Recent Run Failures</div>
    <div class="value">${String(view.failures.length)}</div>
    <div class="detail">${escapeHtml(latestFailure ? `Latest ${latestFailure.taskId}` : "History clear")}</div>
  </div>
  <div class="kpi">
    <div class="label">Next Action</div>
    <div class="value">${escapeHtml(view.nextAction)}</div>
    <div class="detail">Pending queue ${String(view.ops?.queues.pendingInboxCount ?? status.pendingInboxCount ?? 0)} · Pending tasks ${String(pendingTasks)}</div>
  </div>
</section>

${renderCeoStatus(status.ceoStatus)}

<section class="layout">
  <div class="stack">
    <section class="panel">
      <h2>Live Timeline</h2>
      <div class="body">
        <p class="muted">Events are read from <code>runs/live/*.jsonl</code> and shown newest first.</p>
        ${renderTimeline(view)}
      </div>
    </section>
    ${renderRecentRuns(runs, view)}
  </div>

  <aside class="stack">
    <section class="panel">
      <h2>Current Attention</h2>
      <div class="body attention">
        <div class="attention-block">
          <h3>Next Action</h3>
          <p>${escapeHtml(view.nextAction)}</p>
        </div>
        <div class="attention-block">
          <h3>Current Problems</h3>
          <ul>${attentionList(view.currentProblemItems)}</ul>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Run History Attention</h2>
      <div class="body attention">
        <div class="attention-block">
          <h3>Recent failed runs</h3>
          <ul>${attentionList(view.runFailureItems)}</ul>
        </div>
        <div class="attention-block">
          <h3>Latest failure reason</h3>
          <p class="muted">${escapeHtml(latestFailure?.failureReason ?? "none")}</p>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Latest Run</h2>
      <div class="body facts">
        <div class="fact"><span>Run</span><span><code>${escapeHtml(view.latest?.runId ?? "none")}</code></span></div>
        <div class="fact"><span>Outcome</span><span>${view.latest ? runOutcomeBadge(view.latest) : badge("none", "neutral")}</span></div>
        <div class="fact"><span>Lifecycle</span><span><code>${escapeHtml(lifecycleText(view.latestLifecycle))}</code></span></div>
      </div>
    </section>

    <section class="panel">
      <h2>Runtime</h2>
      <div class="body facts">
        <div class="fact"><span>Heartbeat</span><span><code>${escapeHtml(heartbeatText)}</code></span></div>
        <div class="fact"><span>Processed total</span><span><code>${String(status.heartbeat?.processedTotal ?? 0)}</code></span></div>
        <div class="fact"><span>Telegram offset</span><span><code>${escapeHtml(String(view.ops?.telegram.offset?.nextOffset ?? "missing"))}</code></span></div>
        <div class="fact"><span>Telegram replies</span><span><code>sent=${String(view.ops?.telegram.replyState?.sentFiles.length ?? 0)} failures=${String(replyFailures.length)}</code></span></div>
        <div class="fact"><span>Latest reply failure</span><span><code>${escapeHtml(latestReplyFailure ? `${latestReplyFailure.file} attempts=${latestReplyFailure.attempts}` : "none")}</code></span></div>
      </div>
    </section>

    <section class="panel">
      <h2>Queue</h2>
      <div class="body facts">
        <div class="fact"><span>Pending inbox commands</span><span><code>${String(view.ops?.queues.pendingInboxCount ?? status.pendingInboxCount ?? 0)}</code></span></div>
        <div class="fact"><span>Last remote command</span><span><code>${escapeHtml(view.ops?.queues.latestRemoteCommand?.type ?? "none")}</code></span></div>
        <div class="fact"><span>Last remote command id</span><span><code>${escapeHtml(view.ops?.queues.latestRemoteCommand?.id ?? "none")}</code></span></div>
        <div class="fact"><span>Last remote report</span><span><code>${escapeHtml(view.ops?.queues.latestRemoteOutbox?.file ?? "none")}</code></span></div>
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
</section>`;
}

export function renderDashboard(runs: RunSummary[], status: DashboardStatus = {}): string {
  const view = buildView(runs, status);
  return renderShell({
    page: "overview",
    title: "Overview",
    subtitle: "Command-center timeline for worker state, problems, and the next action.",
    view,
    content: renderOverviewContent(runs, status, view),
  });
}

function flowLabel(event: LiveRunEvent): string {
  if (event.phase?.startsWith("setup")) return "setup";
  if (event.type === "command_exit") return "result";
  if (event.phase === "worker") return "worker";
  return event.phase ?? event.type;
}

function renderLaneEvent(run: LiveRunStatus, event: LiveRunEvent, view: DashboardView): string {
  const display = displayEventFor(run, event, view);
  const exit = typeof event.exitCode === "number" ? badge(`exit ${event.exitCode}`, event.exitCode === 0 ? "success" : "fail") : "";
  return `<div class="lane-event">
  <div class="lane-phase">${escapeHtml(flowLabel(event))}</div>
  <div>
    <div class="event-meta">
      <span>${escapeHtml(display.timeLabel)}</span>
      <span class="event-kind">${escapeHtml(display.kindLabel)}</span>
      <code>${escapeHtml(display.phaseLabel)}</code>
      ${exit}
    </div>
    <div class="event-text">${escapeHtml(display.primaryText)}</div>
    ${display.secondaryText ? `<div class="event-secondary">${escapeHtml(display.secondaryText)}</div>` : ""}
  </div>
</div>`;
}

function renderLane(run: LiveRunStatus, view: DashboardView): string {
  const state = liveRunView({
    run,
    nowMs: view.nowMs,
    completedRunIds: view.completedRunIds,
    failedRunIds: view.failedRunIds,
  });
  const events = (run.events ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));
  return `<article class="lane-card ${state.className}">
  <div class="lane-head">
    <div class="lane-title">
      <h2>${escapeHtml(run.taskId)}</h2>
      ${badge(state.label, state.tone)}
    </div>
    <div class="event-meta">
      <span>${escapeHtml(run.agentId ?? "-")}</span>
      <code>${escapeHtml(run.runId)}</code>
      <code>${escapeHtml(run.liveLogPath)}</code>
    </div>
  </div>
  <div class="lane-events">
${events.length ? events.map((event) => renderLaneEvent(run, event, view)).join("\n") : '<div class="empty-state">No events found in this live log.</div>'}
  </div>
</article>`;
}

function laneRank(run: LiveRunStatus, view: DashboardView): number {
  const state = liveRunView({
    run,
    nowMs: view.nowMs,
    completedRunIds: view.completedRunIds,
    failedRunIds: view.failedRunIds,
  });
  if (state.label === "failed") return 0;
  if (state.label === "stale") return 1;
  if (state.label === "running") return 2;
  return 3;
}

export function renderLaneViewDashboard(runs: RunSummary[], status: DashboardStatus = {}): string {
  const view = buildView(runs, status);
  const laneRuns = view.liveRuns
    .slice()
    .sort((a, b) => laneRank(a, view) - laneRank(b, view) || b.lastAt.localeCompare(a.lastAt));
  const content = view.liveRuns.length
    ? `<section class="lane-grid" aria-label="Worker lanes">
${laneRuns.map((run) => renderLane(run, view)).join("\n")}
</section>`
    : `<div class="empty-state">No live worker logs found.</div>`;
  return renderShell({
    page: "lane-view",
    title: "Lane View",
    subtitle: "Worker and run lanes reconstructed from existing live log data.",
    view,
    content,
  });
}

export async function writeDashboard(outputPath: string, runs: RunSummary[], status: DashboardStatus = {}): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([
    writeFile(outputPath, renderDashboard(runs, status), "utf8"),
    writeFile(join(dirname(outputPath), "lane-view.html"), renderLaneViewDashboard(runs, status), "utf8"),
  ]);
}
