import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeTaskId } from "./worktree";

export type WorkerLiveEventType =
  | "meta"
  | "command_start"
  | "stdout"
  | "stderr"
  | "command_exit";

export interface WorkerLiveEvent {
  schemaVersion: 1;
  type: WorkerLiveEventType;
  at: string;
  runId: string;
  taskId: string;
  agentId?: string;
  phase?: string;
  command?: string[];
  cwd?: string;
  text?: string;
  exitCode?: number;
  worktreePath?: string;
  repoRoot?: string;
}

export interface WorkerLiveLogMeta {
  runId: string;
  taskId: string;
  agentId: string;
  repoRoot: string;
  worktreePath: string;
}

export interface TmuxObserverResult {
  enabled: boolean;
  started: boolean;
  sessionName: string;
  windowName: string;
  windowId?: string;
  liveLogPath: string;
  attachCommand: string;
  warning?: string;
}

export function buildWorkerLiveLogPath(logDir: string, runId: string): string {
  return join(logDir, "live", `${runId}.jsonl`);
}

function liveEvent(input: Omit<WorkerLiveEvent, "schemaVersion" | "at">): WorkerLiveEvent {
  return {
    schemaVersion: 1,
    at: new Date().toISOString(),
    ...input,
  };
}

export async function initializeWorkerLiveLog(path: string, meta: WorkerLiveLogMeta): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      liveEvent({
        type: "meta",
        runId: meta.runId,
        taskId: meta.taskId,
        agentId: meta.agentId,
        repoRoot: meta.repoRoot,
        worktreePath: meta.worktreePath,
      }),
    )}\n`,
    "utf8",
  );
}

export async function appendWorkerLiveEvent(
  path: string | undefined,
  event: Omit<WorkerLiveEvent, "schemaVersion" | "at">,
): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(liveEvent(event))}\n`, "utf8");
}

function timestamp(value: string): string {
  return value.slice(11, 19) || value;
}

function formatNestedCodexLine(line: string): string {
  if (!line.trim()) return "";
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      item?: {
        type?: string;
        text?: string;
        command?: string;
        aggregated_output?: string;
        exit_code?: number | null;
        status?: string;
      };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (parsed.type === "thread.started") return "[thread] started";
    if (parsed.type === "turn.started") return "[turn] started";
    if (parsed.type === "turn.completed") return "[turn] completed";
    if (parsed.type === "item.started" && parsed.item?.type === "command_execution") {
      return `[cmd:start] ${parsed.item.command ?? ""}`.trim();
    }
    if (parsed.type === "item.completed" && parsed.item?.type === "agent_message") {
      return `[agent]\n${parsed.item.text ?? ""}`.trimEnd();
    }
    if (parsed.type === "item.completed" && parsed.item?.type === "command_execution") {
      const output = parsed.item.aggregated_output ? `\n${parsed.item.aggregated_output}` : "";
      return `[cmd:exit ${String(parsed.item.exit_code ?? "?")}] ${parsed.item.command ?? ""}${output}`.trimEnd();
    }
  } catch {
    // Not a complete nested JSONL line. Fall through to raw display.
  }

  return line;
}

function formatChunk(text: string): string {
  return text
    .split(/\r?\n/)
    .map(formatNestedCodexLine)
    .filter(Boolean)
    .join("\n");
}

export function formatWorkerLiveLogLine(line: string): string | undefined {
  if (!line.trim()) return undefined;
  let event: WorkerLiveEvent;
  try {
    event = JSON.parse(line) as WorkerLiveEvent;
  } catch {
    return line;
  }

  const prefix = `[${timestamp(event.at)}]`;
  if (event.type === "meta") {
    return [
      `${prefix} run ${event.runId}`,
      `task: ${event.taskId}`,
      `agent: ${event.agentId ?? "unknown"}`,
      `repo: ${event.repoRoot ?? "unknown"}`,
      `worktree: ${event.worktreePath ?? "unknown"}`,
    ].join("\n");
  }
  if (event.type === "command_start") {
    return `${prefix} ${event.phase ?? "command"} start: ${(event.command ?? []).join(" ")}`;
  }
  if (event.type === "command_exit") {
    return `${prefix} ${event.phase ?? "command"} exit: ${String(event.exitCode ?? "?")}`;
  }
  if (event.type === "stdout" || event.type === "stderr") {
    const formatted = formatChunk(event.text ?? "");
    if (!formatted) return undefined;
    return `${prefix} ${event.phase ?? "command"} ${event.type}\n${formatted}`;
  }

  return `${prefix} ${event.type}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runTmux(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function startTmuxObserver(input: {
  sessionName: string;
  taskId: string;
  runId: string;
  liveLogPath: string;
  cwd: string;
  formatterCommand: string;
}): Promise<TmuxObserverResult> {
  const windowName = `worker-${sanitizeTaskId(input.taskId)}`.slice(0, 80);
  const attachCommand = `tmux attach -t ${input.sessionName}`;
  const version = await runTmux(["-V"]);
  if (version.exitCode !== 0) {
    return {
      enabled: true,
      started: false,
      sessionName: input.sessionName,
      windowName,
      liveLogPath: input.liveLogPath,
      attachCommand,
      warning: `tmux unavailable: ${version.stderr.trim() || "tmux -V failed"}`,
    };
  }

  const command = [
    `printf ${shellQuote(`Samantha worker observer\nRun: ${input.runId}\nTask: ${input.taskId}\nLive log: ${input.liveLogPath}\n\n`)}`,
    `while [ ! -f ${shellQuote(input.liveLogPath)} ]; do sleep 0.2; done`,
    `tail -n +1 -F ${shellQuote(input.liveLogPath)} | ${input.formatterCommand}`,
  ].join("; ");
  const hasSession = await runTmux(["has-session", "-t", input.sessionName]);
  const start =
    hasSession.exitCode === 0
      ? await runTmux(["new-window", "-P", "-F", "#{window_id}", "-t", input.sessionName, "-n", windowName, "-c", input.cwd, command])
      : await runTmux(["new-session", "-d", "-P", "-F", "#{window_id}", "-s", input.sessionName, "-n", windowName, "-c", input.cwd, command]);
  const windowId = start.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);

  return {
    enabled: true,
    started: start.exitCode === 0,
    sessionName: input.sessionName,
    windowName,
    ...(windowId ? { windowId } : {}),
    liveLogPath: input.liveLogPath,
    attachCommand,
    ...(start.exitCode === 0 ? {} : { warning: start.stderr.trim() || "tmux observer failed to start" }),
  };
}

export async function stopTmuxObserver(observer: TmuxObserverResult): Promise<void> {
  if (!observer.started || !observer.windowId) return;
  await runTmux(["kill-window", "-t", observer.windowId]);
}
