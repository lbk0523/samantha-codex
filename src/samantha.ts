import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentProfile, TaskSpec } from "./lib/contracts";
import { acquireDaemonLock, checkDaemonHealth, readDaemonHeartbeat, writeDaemonHeartbeat } from "./lib/daemon";
import { writeDashboard, type LiveRunEvent, type LiveRunStatus } from "./lib/dashboard";
import { compactOutboxFileName } from "./lib/ids";
import { processInbox, type InboxCommand } from "./lib/inbox";
import { RunIndex, summarizeWorkerRun, type RunSummary } from "./lib/ledger";
import { buildWorkerLiveLogPath, formatWorkerLiveLogLine, startTmuxObserver, stopTmuxObserver, type TmuxObserverResult } from "./lib/live-log";
import { applyMerge, evaluateMergeGate, pushMerge, readWorkerRunLog } from "./lib/merge-gate";
import {
  doctorReport,
  draftProposeAddedReport,
  failuresReport,
  healthReport,
  orchestrationRequestAddedReport,
  orchestratorCancelReport,
  orchestratorGoBlockedReport,
  orchestratorGoMaterializedReport,
  orchestratorPlanReport,
  orchestratorPlanResultReport,
  orchestratorRecoveryRequestReport,
  orchestratorRevisionRequestReport,
  proposalAddedReport,
  proposalsListReport,
  proposalReviewedReport,
  proposalShowReport,
  nowReport,
  nextActionReport,
  remoteHelpReport,
  remoteDeprecatedCommandReport,
  remoteActionApprovedReport,
  remoteGoReport,
  remoteIntegrationReport,
  type RemoteActionArtifactPreview,
  remoteActionPreparedReport,
  remoteActionResultReport,
  remoteActionShowReport,
  remoteActionsListReport,
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
} from "./lib/operator-reports";
import { collectOpsSnapshot, withoutActiveInboxCommand } from "./lib/ops-diagnostics";
import { runOrchestratorPlan, runOrchestratorSynthesis } from "./lib/orchestrator-agent";
import { materializeOrchestratorPlan } from "./lib/orchestrator-materializer";
import {
  buildOrchestrationRequestId,
  buildOrchestratorPlanId,
  OrchestrationRequestStore,
  OrchestratorPlanStore,
  type OrchestrationRequestRecord,
  type OrchestratorPlanRecord,
} from "./lib/orchestrator-store";
import { runPlan } from "./lib/plan-runner";
import { validateDispatch } from "./lib/policy";
import {
  applyProjectDefaults,
  applyProjectRemoteScopeDefaults,
  inferProjectProfile,
  loadProjectProfile,
  loadProjectProfiles,
  selectProjectRemoteScope,
  type ProjectProfile,
} from "./lib/project-profile";
import { ProposalStore, type ProposalRecord } from "./lib/proposal-store";
import { createRemoteDispatchAction, RemoteActionStore, type RemoteActionRecord } from "./lib/remote-action-store";
import { enqueueRemoteCommand } from "./lib/remote-command";
import { lifecycleBaseFromRunLog, RunLifecycleStore, type RunLifecycleRecord } from "./lib/run-lifecycle-store";
import { buildWorkerRunId, writeWorkerRunLog, type WorkerRunLog } from "./lib/run-log";
import {
  checkTaskDraft,
  parseTaskDraftUpdatePatch,
  TaskDraftStore,
  taskDraftPatchTemplate,
  taskDraftReadiness,
  taskDraftFromProposal,
  taskSpecFromDraft,
  type TaskDraftRecord,
  validateTaskTargetFiles,
} from "./lib/task-draft-store";
import { TaskStore } from "./lib/task-store";
import { pollTelegramToInbox } from "./lib/telegram-adapter";
import { sendOutboxReplies } from "./lib/telegram-reply-adapter";
import { cleanupCompletedWorktree } from "./lib/worktree-cleanup";
import { branchForTask, worktreePathForTask } from "./lib/worktree";
import { executeWorkerDispatch, prepareWorkerDispatch, commitWorkerChanges } from "./lib/worker-dispatch";
import { evaluateWorkerResult } from "./lib/worker-result";
import { gitHead, gitTopLevel } from "./lib/git";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

const root = resolve(import.meta.dir, "..");

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (const arg of rest) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) {
      flags.set(arg.slice(2), true);
    } else {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }

  return { command, positionals, flags };
}

function flag(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : fallback;
}

function stateDir(args: ParsedArgs): string {
  return resolve(flag(args, "state-dir", join(root, "state")));
}

function runsPath(args: ParsedArgs): string {
  return join(stateDir(args), "runs.jsonl");
}

function tasksPath(args: ParsedArgs): string {
  return join(stateDir(args), "tasks.jsonl");
}

function proposalsPath(args: ParsedArgs): string {
  return join(stateDir(args), "proposals.jsonl");
}

function taskDraftsPath(args: ParsedArgs): string {
  return join(stateDir(args), "task-drafts.jsonl");
}

function orchestrationRequestsPath(args: ParsedArgs): string {
  return join(stateDir(args), "orchestration-requests.jsonl");
}

function orchestratorPlansPath(args: ParsedArgs): string {
  return join(stateDir(args), "orchestrator-plans.jsonl");
}

function runLifecyclePath(args: ParsedArgs): string {
  return join(stateDir(args), "run-lifecycle.jsonl");
}

function remoteActionsPath(args: ParsedArgs): string {
  return join(stateDir(args), "remote-actions.jsonl");
}

function actionRunnerLockPath(args: ParsedArgs): string {
  return resolve(flag(args, "actions-lock-file", join(stateDir(args), "actions.lock")));
}

function logDir(args: ParsedArgs): string {
  return resolve(flag(args, "log-dir", join(root, "runs")));
}

function outboxDir(args: ParsedArgs): string {
  return resolve(flag(args, "outbox-dir", join(root, "outbox")));
}

function agentProfilesDir(args: ParsedArgs): string {
  return resolve(flag(args, "agent-profiles-dir", join(root, "references/agent-profiles")));
}

function projectProfilesDir(args: ParsedArgs): string {
  return resolve(flag(args, "project-profiles-dir", join(root, "references/project-profiles")));
}

function daemonLockPath(args: ParsedArgs): string {
  return resolve(flag(args, "lock-file", join(stateDir(args), "daemon.lock")));
}

function heartbeatPath(args: ParsedArgs): string {
  return resolve(flag(args, "heartbeat-file", join(stateDir(args), "heartbeat.json")));
}

function telegramOffsetPath(args: ParsedArgs): string {
  return resolve(flag(args, "telegram-offset-file", join(stateDir(args), "telegram-offset.json")));
}

function telegramRepliesPath(args: ParsedArgs): string {
  return resolve(flag(args, "telegram-replies-file", join(stateDir(args), "telegram-replies.json")));
}

function envFilePath(args: ParsedArgs): string {
  return resolve(flag(args, "env-file", join(root, ".env")));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxLength = 1200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}\n...[truncated]`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function formatLiveLogFromStdin(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream() as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const formatted = formatWorkerLiveLogLine(line);
      if (formatted) console.log(formatted);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const formatted = formatWorkerLiveLogLine(buffer);
    if (formatted) console.log(formatted);
  }
}

async function pendingInboxCount(path: string): Promise<number> {
  try {
    return (await readdir(path)).filter((file) => file.endsWith(".json")).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function knownAgentIds(args: ParsedArgs): Promise<string[]> {
  const dir = agentProfilesDir(args);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  const agents = await Promise.all(files.map((file) => readJson<AgentProfile>(join(dir, file))));
  return agents.map((agent) => agent.id);
}

async function loadAgentProfile(args: ParsedArgs, agentId: string): Promise<AgentProfile> {
  const dir = agentProfilesDir(args);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    const agent = await readJson<AgentProfile>(join(dir, file));
    if (agent.id === agentId) return agent;
  }
  throw new Error(`agent profile not found: ${agentId}`);
}

async function loadAgentProfilesById(args: ParsedArgs, agentIds: string[]): Promise<AgentProfile[]> {
  const agents: AgentProfile[] = [];
  for (const agentId of new Set(agentIds)) {
    try {
      agents.push(await loadAgentProfile(args, agentId));
    } catch {
      // Materialization reports unknown target agents as validation violations.
    }
  }
  return agents;
}

async function buildDashboard(args: ParsedArgs, out: string): Promise<number> {
  const runs = await new RunIndex(runsPath(args)).list();
  const inboxDir = resolve(flag(args, "inbox-dir", join(root, "inbox")));
  await writeDashboard(out, runs, {
    heartbeat: await readDaemonHeartbeat(heartbeatPath(args)),
    pendingInboxCount: await pendingInboxCount(inboxDir),
    ops: await collectOps(args),
    proposals: await new ProposalStore(proposalsPath(args)).list(),
    drafts: await new TaskDraftStore(taskDraftsPath(args)).list(),
    tasks: await new TaskStore(tasksPath(args)).list(),
    lifecycles: await new RunLifecycleStore(runLifecyclePath(args)).list(),
    liveRuns: await readLiveRuns(logDir(args)),
  });
  return runs.length;
}

async function readLiveRuns(baseLogDir: string): Promise<LiveRunStatus[]> {
  const liveDir = join(baseLogDir, "live");
  let files: string[];
  try {
    files = (await readdir(liveDir)).filter((file) => file.endsWith(".jsonl")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const liveRuns: LiveRunStatus[] = [];
  for (const file of files) {
    const liveLogPath = join(liveDir, file);
    const lines = (await readFile(liveLogPath, "utf8")).split(/\r?\n/).filter(Boolean);
    const rawEvents = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const events = rawEvents.flatMap(summarizeLiveRunEvent);
    const meta = rawEvents.find((event) => event.type === "meta");
    const latestRaw = rawEvents.at(-1);
    const latest = events.at(-1);
    if (!latest || !latestRaw) continue;

    const latestTextEvent = events
      .slice()
      .reverse()
      .find((event) => typeof event.text === "string" && event.text.trim());
    const latestText = latestTextEvent?.text;
    liveRuns.push({
      runId: String(latestRaw.runId ?? meta?.runId ?? file.replace(/\.jsonl$/, "")),
      taskId: String(latestRaw.taskId ?? meta?.taskId ?? "unknown"),
      agentId: typeof latestRaw.agentId === "string" ? latestRaw.agentId : typeof meta?.agentId === "string" ? meta.agentId : undefined,
      phase: latest.phase,
      lastEventType: latest.type,
      lastAt: latest.at,
      liveLogPath,
      ...(latestText ? { latestText } : {}),
      events,
    });
  }
  return liveRuns;
}

function summarizeLiveRunEvent(event: Record<string, unknown>): LiveRunEvent[] {
  const type = typeof event.type === "string" ? event.type : "event";
  const text = typeof event.text === "string" ? summarizeLiveText(event.text) : undefined;
  if ((type === "stdout" || type === "stderr") && typeof event.text === "string" && event.text.trim() && !text) {
    return [];
  }
  return [
    {
      at: typeof event.at === "string" ? event.at : "",
      type,
      phase: typeof event.phase === "string" ? event.phase : undefined,
      text,
      command: commandText(event.command),
      exitCode: typeof event.exitCode === "number" ? event.exitCode : undefined,
    },
  ];
}

function summarizeLiveText(text: string): string | undefined {
  const summary = text
    .split(/\r?\n/)
    .flatMap((line) => summarizeNestedCodexLine(line))
    .filter(Boolean)
    .join("\n")
    .trim();
  return summary || undefined;
}

function summarizeNestedCodexLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      item?: {
        type?: string;
        text?: string;
        command?: string;
        aggregated_output?: string;
        exit_code?: number | null;
      };
    };
    if (parsed.type === "turn.completed") return [];
    if (parsed.type === "thread.started") return ["[thread] started"];
    if (parsed.type === "turn.started") return ["[turn] started"];
    if (parsed.type === "item.started" && parsed.item?.type === "command_execution") {
      return [`[cmd:start] ${parsed.item.command ?? ""}`.trim()];
    }
    if (parsed.type === "item.completed" && parsed.item?.type === "agent_message") {
      return [parsed.item.text ?? ""];
    }
    if (parsed.type === "item.completed" && parsed.item?.type === "command_execution") {
      const output = parsed.item.aggregated_output ? `\n${parsed.item.aggregated_output}` : "";
      return [`[cmd:exit ${String(parsed.item.exit_code ?? "?")}] ${parsed.item.command ?? ""}${output}`.trimEnd()];
    }
  } catch {
    return [line];
  }
  return [line];
}

function commandText(command: unknown): string | undefined {
  if (Array.isArray(command)) return command.map(String).join(" ");
  return typeof command === "string" ? command : undefined;
}

async function serveDashboard(args: ParsedArgs): Promise<void> {
  const out = resolve(flag(args, "out", join(root, "dashboard/index.html")));
  const hostname = flag(args, "host", "127.0.0.1");
  const port = Number(flag(args, "port", "4173"));
  const server = Bun.serve({
    hostname,
    port,
    fetch: async (request) => {
      const url = new URL(request.url);
      const route = dashboardRoute(url.pathname);
      if (!route) return new Response("not found", { status: 404 });
      await buildDashboard(args, out);
      const htmlPath = route === "lane-view" ? join(dirname(out), "lane-view.html") : out;
      return new Response(await readFile(htmlPath, "utf8"), {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
      });
    },
  });

  console.log(`Samantha dashboard listening on http://${server.hostname}:${server.port}/`);
  console.log(`Rendering ${out} on each request`);
  await new Promise(() => {});
}

function dashboardRoute(pathname: string): "overview" | "lane-view" | undefined {
  if (pathname === "/" || pathname === "/index.html" || pathname === "/overview") return "overview";
  if (pathname === "/lane-view" || pathname === "/lane-view.html") return "lane-view";
  return undefined;
}

async function collectOps(args: ParsedArgs) {
  return collectOpsSnapshot({
    envFilePath: envFilePath(args),
    inboxDir: resolve(flag(args, "inbox-dir", join(root, "inbox"))),
    outboxDir: resolve(flag(args, "outbox-dir", join(root, "outbox"))),
    archiveInboxDir: resolve(flag(args, "archive-dir", join(root, "archive", "inbox"))),
    heartbeatPath: heartbeatPath(args),
    lockPath: daemonLockPath(args),
    telegramOffsetPath: telegramOffsetPath(args),
    telegramRepliesPath: telegramRepliesPath(args),
    maxAgeMs: Number(flag(args, "max-age-ms", "15000")),
  });
}

function remoteDispatchRepoRoot(args: ParsedArgs): string {
  const repoRoot = flag(args, "repo-root", process.env.SAMANTHA_REPO_ROOT ?? "");
  if (!repoRoot) {
    throw new Error("remote dispatch actions require inbox:watch --repo-root=<repo> or SAMANTHA_REPO_ROOT");
  }
  return resolve(repoRoot);
}

function orchestratorRepoRoot(args: ParsedArgs): string {
  return resolve(flag(args, "orchestrator-repo-root", process.env.SAMANTHA_ORCHESTRATOR_REPO_ROOT ?? root));
}

function codexBin(args: ParsedArgs): string {
  return flag(args, "codex-bin", process.env.SAMANTHA_CODEX_BIN ?? "codex");
}

async function executeTaskDispatch(input: {
  args: ParsedArgs;
  taskId: string;
  repoRoot: string;
  allocate?: boolean;
  liveLog?: boolean;
  tmux?: boolean;
  worktreesDir?: string;
  tmuxSession?: string;
  codexBin?: string;
  startedAt?: string;
}) {
  const taskStore = new TaskStore(tasksPath(input.args));
  const task = await taskStore.find(input.taskId);
  if (!task) throw new Error(`task not found: ${input.taskId}`);
  if (task.status !== "pending") throw new Error(`task must be pending to dispatch: ${task.status}`);

  const agent = await loadAgentProfile(input.args, task.targetAgent);
  const allocate = input.allocate === true || agent.worktreePolicy === "per-task";
  const baseLogDir = logDir(input.args);
  const startedAt = input.startedAt ?? new Date().toISOString();
  const runId = buildWorkerRunId({ startedAt, taskId: task.id });
  const liveLogPath = input.tmux === true || input.liveLog === true
    ? buildWorkerLiveLogPath(baseLogDir, runId)
    : undefined;
  const dispatchInput = {
    task,
    agent,
    repoRoot: resolve(input.repoRoot),
    allocate,
    worktreesDir: input.worktreesDir || undefined,
    codexBin: input.codexBin ?? codexBin(input.args),
    ...(liveLogPath ? { liveLogPath, runId } : {}),
  };

  let tmux: TmuxObserverResult | undefined;
  if (input.tmux === true && liveLogPath) {
    tmux = await startTmuxObserver({
      sessionName: input.tmuxSession ?? flag(input.args, "tmux-session", "samantha"),
      taskId: task.id,
      runId,
      liveLogPath,
      cwd: root,
      formatterCommand: "bun run src/samantha.ts live:format",
    });
  }
  let execution;
  try {
    execution = await executeWorkerDispatch(dispatchInput);
  } finally {
    if (tmux?.started) {
      try {
        await stopTmuxObserver(tmux);
      } catch (err) {
        console.error(`failed to stop tmux observer: ${errorMessage(err)}`);
      }
    }
  }
  const finishedAt = new Date().toISOString();
  const logInput = {
    ...dispatchInput,
    execute: true,
    startedAt,
    finishedAt,
    execution,
  };
  const runLog = await writeWorkerRunLog(baseLogDir, logInput);
  const runSummary = summarizeWorkerRun({ ...logInput, runId: runLog.runId, logPath: runLog.path });
  await new RunIndex(runsPath(input.args)).append(runSummary);
  await taskStore.updateStatus(task.id, runSummary.pass ? "completed" : "failed");
  return {
    runLog,
    runSummary,
    ...(liveLogPath ? { liveLog: { path: liveLogPath } } : {}),
    ...(tmux ? { tmux } : {}),
  };
}

async function writeRemoteActionResultOutbox(args: ParsedArgs, action: RemoteActionRecord): Promise<void> {
  const completedAt = action.completedAt ?? new Date().toISOString();
  const file = compactOutboxFileName({
    createdAt: completedAt,
    kind: "result",
    label: action.taskTitle,
    source: action.id,
  });
  let runLog: WorkerRunLog | undefined;

  if (action.result?.runLogPath) {
    try {
      runLog = await readWorkerRunLog(action.result.runLogPath);
    } catch {
      runLog = undefined;
    }
  }

  const dir = outboxDir(args);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, file),
    `${remoteActionResultReport({ action, runLog, artifactPreviews: await collectReportArtifactPreviews(runLog) })}\n`,
    "utf8",
  );
}

function isPreviewableReportArtifact(file: string): boolean {
  return /\.(md|mdx|txt)$/i.test(file);
}

async function collectReportArtifactPreviews(runLog: WorkerRunLog | undefined): Promise<RemoteActionArtifactPreview[]> {
  if (!runLog || runLog.task.resultMode !== "report") return [];

  const worktreePath = runLog.result.preparation.worktreePath;
  const files = (runLog.result.evaluation?.changedFiles ?? runLog.result.commit?.files ?? [])
    .filter(isPreviewableReportArtifact)
    .slice(0, 3);
  const previews: RemoteActionArtifactPreview[] = [];

  for (const file of files) {
    const absolutePath = resolve(worktreePath, file);
    const relativePath = relative(worktreePath, absolutePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) continue;

    try {
      previews.push({ file, text: await readFile(absolutePath, "utf8") });
    } catch {
      // The worker result report should still be sent even if an artifact was removed.
    }
  }

  return previews;
}

async function tryWriteRemoteActionResultOutbox(args: ParsedArgs, action: RemoteActionRecord): Promise<void> {
  try {
    await writeRemoteActionResultOutbox(args, action);
  } catch (err) {
    console.error(`failed to write remote action result report: ${errorMessage(err)}`);
  }
}

async function writeOrchestratorPlanResultOutbox(args: ParsedArgs, plan: OrchestratorPlanRecord): Promise<void> {
  const actionIds = plan.actionIds ?? [];
  if (actionIds.length === 0 || plan.resultReportedAt) return;

  const actions = (await new RemoteActionStore(remoteActionsPath(args)).list()).filter((action) =>
    actionIds.includes(action.id),
  );
  if (actions.length !== actionIds.length) return;
  if (actions.some((action) =>
    action.status === "pending" || action.status === "waiting" || action.status === "approved" || action.status === "running"
  )) {
    return;
  }

  const runLogs = (
    await Promise.all(
      actions.map(async (action) => {
        if (!action.result?.runLogPath) return undefined;
        try {
          return await readWorkerRunLog(action.result.runLogPath);
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((log): log is WorkerRunLog => log !== undefined);
  const synthesis = await (async () => {
    try {
      return await runOrchestratorSynthesis({
        plan,
        request: await new OrchestrationRequestStore(orchestrationRequestsPath(args)).find(plan.requestId),
        actions,
        runLogs,
        agent: await loadAgentProfile(args, "codex-orchestrator"),
        repoRoot: orchestratorRepoRoot(args),
        codexBin: codexBin(args),
      });
    } catch (err) {
      return { rawOutput: "", payload: undefined, failure: errorMessage(err) };
    }
  })();
  const reportedAt = new Date().toISOString();
  const file = compactOutboxFileName({
    createdAt: reportedAt,
    kind: "plan-result",
    label: plan.payload?.summary ?? plan.requestId,
    source: plan.id,
  });
  await mkdir(outboxDir(args), { recursive: true });
  await writeFile(
    join(outboxDir(args), file),
    `${orchestratorPlanResultReport({
      plan,
      actions,
      runLogs,
      synthesis: synthesis.payload,
      synthesisFailure: synthesis.failure,
    })}\n`,
    "utf8",
  );
  await new OrchestratorPlanStore(orchestratorPlansPath(args)).markResultReported(plan.id, {
    resultReportedAt: reportedAt,
    synthesisAt: synthesis.payload || synthesis.failure ? reportedAt : undefined,
    synthesis: synthesis.payload,
    synthesisFailure: synthesis.failure,
  });
}

async function tryWriteOrchestratorPlanResultOutbox(args: ParsedArgs, action: RemoteActionRecord): Promise<void> {
  try {
    const plan = (await new OrchestratorPlanStore(orchestratorPlansPath(args)).list())
      .slice()
      .reverse()
      .find((item) => item.status === "materialized" && !item.resultReportedAt && (item.actionIds ?? []).includes(action.id));
    if (plan) await writeOrchestratorPlanResultOutbox(args, plan);
  } catch (err) {
    console.error(`failed to write orchestrator plan result report: ${errorMessage(err)}`);
  }
}

async function tryWriteReadyOrchestratorPlanResultOutboxes(args: ParsedArgs): Promise<void> {
  try {
    const plans = (await new OrchestratorPlanStore(orchestratorPlansPath(args)).list()).filter(
      (plan) => plan.status === "materialized" && !plan.resultReportedAt,
    );
    for (const plan of plans) {
      await writeOrchestratorPlanResultOutbox(args, plan);
    }
  } catch (err) {
    console.error(`failed to write ready orchestrator plan result reports: ${errorMessage(err)}`);
  }
}

function actionNeedsRecovery(action: RemoteActionRecord): boolean {
  return action.status === "failed" || action.result?.pass === false;
}

interface RecoverableOrchestratorPlan {
  plan: OrchestratorPlanRecord;
  actions: RemoteActionRecord[];
  failedActions: RemoteActionRecord[];
  request?: OrchestrationRequestRecord;
  runLogs: WorkerRunLog[];
  artifactPreviews: RemoteActionArtifactPreview[];
}

async function readRunLogsForActions(actions: RemoteActionRecord[]): Promise<WorkerRunLog[]> {
  const logs = await Promise.all(
    actions.map(async (action) => {
      if (!action.result?.runLogPath) return undefined;
      try {
        return await readWorkerRunLog(action.result.runLogPath);
      } catch {
        return undefined;
      }
    }),
  );
  return logs.filter((log): log is WorkerRunLog => log !== undefined);
}

async function latestRecoverableOrchestratorPlan(args: ParsedArgs): Promise<
  RecoverableOrchestratorPlan | undefined
> {
  const [plans, actions, requests] = await Promise.all([
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
  ]);
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  const requestsById = new Map(requests.map((request) => [request.id, request]));

  for (const plan of plans.slice().reverse()) {
    const actionIds = plan.actionIds ?? [];
    if (plan.status !== "materialized" || !plan.resultReportedAt || actionIds.length === 0) continue;

    const planActions = actionIds.map((id) => actionsById.get(id));
    if (planActions.some((action) => !action)) continue;
    if (planActions.some((action) => action?.status !== "completed" && action?.status !== "failed")) continue;

    const finalActions = planActions.filter((action): action is RemoteActionRecord => action !== undefined);
    const failedActions = finalActions.filter(actionNeedsRecovery);
    const synthesisNeedsRecovery = plan.synthesis ? plan.synthesis.outcome !== "pass" : false;
    if (failedActions.length > 0 || synthesisNeedsRecovery) {
      const runLogs = await readRunLogsForActions(finalActions);
      const artifactPreviews = (await Promise.all(runLogs.map((runLog) => collectReportArtifactPreviews(runLog)))).flat();
      return {
        plan,
        actions: finalActions,
        failedActions,
        request: requestsById.get(plan.requestId),
        runLogs,
        artifactPreviews,
      };
    }
  }

  return undefined;
}

function recoveryRequestText(input: RecoverableOrchestratorPlan): string {
  const plan = input.plan;
  const failedActions = input.failedActions.length ? input.failedActions : input.actions.filter(actionNeedsRecovery);
  const runLogForAction = (action: RemoteActionRecord) =>
    input.runLogs.find((log) => log.runId === action.result?.runId || log.task.id === action.taskId);
  const changedFiles = Array.from(
    new Set(
      failedActions.flatMap((action) => {
        const runLog = runLogForAction(action);
        return runLog?.result.evaluation?.changedFiles ?? runLog?.result.commit?.files ?? [];
      }),
    ),
  );
  const runLogPaths = Array.from(new Set(failedActions.flatMap((action) => action.result?.runLogPath ? [action.result.runLogPath] : [])));
  const lines = [
    "복구 계획 요청입니다.",
    "",
    `실패한 계획: ${plan.id}`,
    `원 요청 ID: ${plan.requestId}`,
    input.request?.text ? `원 요청: ${compactLine(input.request.text)}` : "",
    plan.payload?.summary ? `원 계획 요약: ${compactLine(plan.payload.summary)}` : "",
    plan.synthesis?.summary ? `결과 종합: ${compactLine(plan.synthesis.summary)}` : "",
    plan.synthesis?.userMessage ? `결과 메시지: ${compactLine(plan.synthesis.userMessage)}` : "",
    "",
    "실패 action:",
    ...(failedActions.length
      ? failedActions.flatMap((action) => {
          const runLog = runLogForAction(action);
          const actionFiles = runLog?.result.evaluation?.changedFiles ?? runLog?.result.commit?.files ?? [];
          return [
            `- ${action.taskTitle}: status=${action.status} outcome=${action.result?.outcome ?? "unknown"}`,
            action.result?.failure ? `  실패 이유: ${compactLine(action.result.failure)}` : "",
            actionFiles.length ? `  관련 변경/산출: ${actionFiles.map(compactLine).join(", ")}` : "",
            action.result?.runLogPath ? `  run log: ${action.result.runLogPath}` : "",
          ].filter(Boolean);
        })
      : ["- action 자체 실패는 없지만 오케스트레이터 종합 결과가 복구 필요 상태입니다."]),
    "",
    "관련 변경/산출:",
    ...(changedFiles.length ? changedFiles.slice(0, 12).map((file) => `- ${file}`) : ["- 실패 action에서 변경 파일을 찾지 못했습니다. run log를 참고하세요."]),
    changedFiles.length > 12 ? `- 외 ${changedFiles.length - 12}개` : "",
    "",
    "Run log 참고:",
    ...(runLogPaths.length ? runLogPaths.map((path) => `- ${path}`) : ["- 없음"]),
    input.artifactPreviews.length ? "" : "",
    ...(input.artifactPreviews.length
      ? [
          "산출물 미리보기:",
          ...input.artifactPreviews.slice(0, 2).flatMap((preview) => [
            `파일: ${preview.file}`,
            clipText(preview.text, 800),
          ]),
        ]
      : []),
    "",
    "요청:",
    "위 실패 원인을 먼저 재검토하고, 무작정 retry하지 말고 복구 계획을 제안하세요.",
    "복구 task는 project profile의 canonical repoRoot에서 시작해야 합니다.",
    "실패 run log나 worker worktree path를 repoRoot로 복사하지 마세요.",
    "repoRoot가 불확실하면 비워 두고 projectId를 맞춰 materializer가 profile 기본값을 쓰게 하세요.",
    "필요하면 원인 확인용 report task를 먼저 두고, 수정/검증 task는 의존 관계로 분리하세요.",
  ];

  return clipText(lines.join("\n"), 4000);
}

function revisionRequestText(input: {
  plan: OrchestratorPlanRecord;
  request?: OrchestrationRequestRecord;
  feedback: string;
}): string {
  const taskLines = input.plan.payload?.tasks.map((task) =>
    `- ${task.id}: ${task.title} agent=${task.targetAgent} mode=${task.resultMode ?? "write"}`,
  ) ?? [];
  const lines = [
    "계획 수정 요청입니다.",
    "",
    `기존 계획: ${input.plan.id}`,
    `원 요청 ID: ${input.plan.requestId}`,
    input.request?.text ? `원 요청: ${compactLine(input.request.text)}` : "",
    input.plan.payload?.summary ? `기존 계획 요약: ${compactLine(input.plan.payload.summary)}` : "",
    input.plan.payload?.questions.length ? `기존 확인 질문: ${input.plan.payload.questions.map(compactLine).join(" / ")}` : "",
    taskLines.length ? "기존 작업 후보:" : "",
    ...taskLines,
    "",
    "사용자 피드백:",
    compactLine(input.feedback),
    "",
    "요청:",
    "이전 계획을 그대로 재사용하지 말고, 사용자 피드백을 반영해 새 계획을 다시 제안하세요.",
    "새 계획이 안전하지 않거나 모호하면 tasks를 비우고 questions에 확인 질문을 남기세요.",
  ];

  return clipText(lines.filter((line) => line !== "").join("\n"), 4000);
}

async function runApprovedRemoteActions(args: ParsedArgs, limit: number): Promise<{ actionId: string; status: string }[]> {
  const store = new RemoteActionStore(remoteActionsPath(args));
  const results: { actionId: string; status: string }[] = [];

  while (results.length < limit) {
    await promoteReadyWaitingActions(args, store);
    const action = (await store.list()).find((item) => item.status === "approved");
    if (!action) break;
    const startedAt = new Date().toISOString();
    const runId = buildWorkerRunId({ startedAt, taskId: action.taskId });
    const tmuxSession = flag(args, "tmux-session", "samantha");
    const running = await store.markRunning(action.id, startedAt, {
      runId,
      liveLogPath: buildWorkerLiveLogPath(logDir(args), runId),
      tmuxSession,
    });
    if (running.kind !== "dispatch_task") throw new Error(`unsupported remote action kind: ${running.kind}`);

    try {
      const result = await executeTaskDispatch({
        args,
        taskId: running.taskId,
        repoRoot: running.repoRoot,
        allocate: true,
        tmux: true,
        tmuxSession,
        startedAt,
      });
      const finished = await store.markFinished(running.id, {
        status: result.runSummary.pass ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        result: {
          runId: result.runSummary.runId,
          runLogPath: result.runLog.path,
          liveLogPath: result.liveLog?.path,
          tmuxSession: result.tmux?.sessionName,
          pass: result.runSummary.pass,
          outcome: result.runSummary.outcome,
          failure: result.runSummary.failureReason,
        },
      });
      await tryWriteRemoteActionResultOutbox(args, finished);
      await tryWriteOrchestratorPlanResultOutbox(args, finished);
      results.push({ actionId: finished.id, status: finished.status });
    } catch (err) {
      const failed = await store.markFinished(running.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        result: { failure: errorMessage(err) },
      });
      await markActionTaskFailed(args, failed);
      await tryWriteRemoteActionResultOutbox(args, failed);
      await tryWriteOrchestratorPlanResultOutbox(args, failed);
      results.push({ actionId: failed.id, status: failed.status });
    }
  }

  await tryWriteReadyOrchestratorPlanResultOutboxes(args);
  return results;
}

async function promoteReadyWaitingActions(args: ParsedArgs, store: RemoteActionStore): Promise<void> {
  const actions = await store.list();
  const byId = new Map(actions.map((action) => [action.id, action]));
  const waiting = actions.filter((action) => action.status === "waiting");

  for (const action of waiting) {
    const dependencyIds = action.dependsOnActionIds ?? [];
    const dependencies = dependencyIds.map((id) => byId.get(id));
    const missingDependency = dependencyIds.find((id, index) => !dependencies[index]);
    const failedDependency = dependencies.find(
      (dependency) => dependency?.status === "failed" || (dependency?.status === "completed" && dependency.result?.pass === false),
    );

    if (missingDependency || failedDependency) {
      const reason = missingDependency
        ? `dependency action missing: ${missingDependency}`
        : `dependency action failed: ${failedDependency?.id}`;
      const failed = await store.markFailed(action.id, {
        completedAt: new Date().toISOString(),
        result: { pass: false, outcome: "dependency_failed", failure: reason },
      });
      await markActionTaskFailed(args, failed);
      await tryWriteRemoteActionResultOutbox(args, failed);
      await tryWriteOrchestratorPlanResultOutbox(args, failed);
      continue;
    }

    if (dependencies.every((dependency) => dependency?.status === "completed" && dependency.result?.pass === true)) {
      await store.markDependenciesSatisfied(action.id, new Date().toISOString());
    }
  }
}

async function markActionTaskFailed(args: ParsedArgs, action: RemoteActionRecord): Promise<void> {
  const taskStore = new TaskStore(tasksPath(args));
  const task = await taskStore.find(action.taskId);
  if (!task || (task.status !== "pending" && task.status !== "in_progress")) return;
  await taskStore.updateStatus(task.id, "failed");
}

async function prepareDispatchActionForTask(input: {
  args: ParsedArgs;
  taskId: string;
  commandId?: string;
  receivedAt?: string;
}) {
  const task = await new TaskStore(tasksPath(input.args)).find(input.taskId);
  if (!task) throw new Error(`task not found: ${input.taskId}`);
  if (task.status !== "pending") throw new Error(`task must be pending to dispatch: ${task.status}`);
  const agent = await loadAgentProfile(input.args, task.targetAgent);
  const plan = validateDispatch(task, agent);
  if (!plan.mayDispatch) {
    throw new Error(`dispatch blocked:\n${plan.violations.join("\n")}`);
  }

  const action = createRemoteDispatchAction({
    task,
    repoRoot: task.repoRoot ? resolve(task.repoRoot) : remoteDispatchRepoRoot(input.args),
    createdAt: input.receivedAt ?? new Date().toISOString(),
    source: "remote",
    commandId: input.commandId,
  });
  await new RemoteActionStore(remoteActionsPath(input.args)).append(action);
  return action;
}

async function projectProfileForRemotePlan(input: {
  args: ParsedArgs;
  draftProjectId?: string;
  requestedProjectId?: string;
  requestText?: string;
}): Promise<{ profile: ProjectProfile; inferred: boolean }> {
  if (input.requestedProjectId) {
    return {
      profile: await loadProjectProfile(projectProfilesDir(input.args), input.requestedProjectId),
      inferred: false,
    };
  }

  const profiles = await loadProjectProfiles(projectProfilesDir(input.args));
  const inferred = inferProjectProfile(profiles, { requestText: input.requestText });
  if (inferred && inferred.id !== input.draftProjectId) return { profile: inferred, inferred: true };

  if (input.draftProjectId) {
    return {
      profile: await loadProjectProfile(projectProfilesDir(input.args), input.draftProjectId),
      inferred: false,
    };
  }

  if (inferred) return { profile: inferred, inferred: true };
  if (profiles.length === 1 && profiles[0]) return { profile: profiles[0], inferred: true };
  if (profiles.length === 0) throw new Error("project profile is required, but no project profiles are configured");
  throw new Error("project id is required: send /plan <project_id>");
}

async function nowReportForInbox(args: ParsedArgs): Promise<string> {
  const [runs, tasks, actions, proposals, drafts, orchestrationRequests, orchestratorPlans, ops, lifecycles] = await Promise.all([
    new RunIndex(runsPath(args)).list(),
    new TaskStore(tasksPath(args)).listActive(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new ProposalStore(proposalsPath(args)).list(),
    new TaskDraftStore(taskDraftsPath(args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    collectOps(args),
    new RunLifecycleStore(runLifecyclePath(args)).list(),
  ]);
  return nowReport({
    runs,
    tasks,
    actions,
    proposals,
    drafts,
    orchestrationRequests,
    orchestratorPlans,
    ops: withoutActiveInboxCommand(ops),
    lifecycles,
  });
}

function lifecycleBaseInput(input: { log: WorkerRunLog; run: RunSummary; updatedAt: string }) {
  return lifecycleBaseFromRunLog({
    log: input.log,
    runLogPath: input.run.logPath,
    repoRoot: input.run.repoRoot,
    updatedAt: input.updatedAt,
  });
}

async function markRunLifecycle(args: ParsedArgs, run: RunSummary, stage: "merged" | "pushed" | "cleaned", updatedAt: string) {
  const log = await readWorkerRunLog(run.logPath);
  return new RunLifecycleStore(runLifecyclePath(args)).mark(
    lifecycleBaseInput({ log, run, updatedAt }),
    stage,
    updatedAt,
  );
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function latestRunNeedingIntegration(runs: RunSummary[], lifecycles: RunLifecycleRecord[]): RunSummary | undefined {
  const lifecyclesByRunId = new Map(lifecycles.map((record) => [record.runId, record]));
  const latestLifecycleUpdate = Math.max(0, ...lifecycles.map((record) => Date.parse(record.updatedAt) || 0));
  return runs
    .slice()
    .reverse()
    .find((run) => {
      const lifecycle = lifecyclesByRunId.get(run.runId);
      if (!run.pass || !run.commit) return false;
      if (lifecycle?.mergedAt && lifecycle.pushedAt && lifecycle.cleanedAt) return false;
      if (lifecycle) return true;
      return latestLifecycleUpdate === 0 || (Date.parse(run.finishedAt) || 0) > latestLifecycleUpdate;
    });
}

async function latestPrimaryWorkflowTimestamp(args: ParsedArgs): Promise<number> {
  const [runs, actions, requests, plans, lifecycles] = await Promise.all([
    new RunIndex(runsPath(args)).list(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    new RunLifecycleStore(runLifecyclePath(args)).list(),
  ]);
  return Math.max(
    0,
    ...runs.map((run) => timestamp(run.finishedAt)),
    ...actions.flatMap((action) => [
      timestamp(action.createdAt),
      timestamp(action.approvedAt),
      timestamp(action.startedAt),
      timestamp(action.completedAt),
    ]),
    ...requests.flatMap((request) => [
      timestamp(request.createdAt),
      timestamp(request.plannedAt),
      timestamp(request.discardedAt),
    ]),
    ...plans.flatMap((plan) => [
      timestamp(plan.createdAt),
      timestamp(plan.completedAt),
      timestamp(plan.approvedAt),
      timestamp(plan.materializedAt),
      timestamp(plan.resultReportedAt),
      timestamp(plan.synthesisAt),
      timestamp(plan.canceledAt),
      timestamp(plan.supersededAt),
    ]),
    ...lifecycles.map((lifecycle) => timestamp(lifecycle.updatedAt)),
  );
}

function latestRelevantDraft(drafts: TaskDraftRecord[], primaryWorkflowTimestamp: number): TaskDraftRecord | undefined {
  return drafts
    .slice()
    .reverse()
    .find((item) => item.status === "drafted" && timestamp(item.updatedAt ?? item.createdAt) >= primaryWorkflowTimestamp);
}

async function advanceLatestPassedRunIntegration(args: ParsedArgs): Promise<string | undefined> {
  const runs = await new RunIndex(runsPath(args)).list();
  const lifecycles = await new RunLifecycleStore(runLifecyclePath(args)).list();
  const run = latestRunNeedingIntegration(runs, lifecycles);
  if (!run) return undefined;

  const lifecycle = lifecycles.find((record) => record.runId === run.runId);
  const updatedAt = new Date().toISOString();

  if (!lifecycle?.mergedAt) {
    const result = await applyMerge({
      runLogPath: run.logPath,
      repoRoot: run.repoRoot,
      targetBranch: "main",
    });
    const ok = (result.applied && result.verified) || (result.gate.alreadyMerged && result.violations.length === 0);
    const nextLifecycle = ok ? await markRunLifecycle(args, run, "merged", updatedAt) : undefined;
    return remoteIntegrationReport({
      stage: "merge",
      run,
      ok,
      lifecycle: nextLifecycle,
      details: [
        result.gate.alreadyMerged ? "이미 merge된 run입니다." : "",
        result.applied ? "fast-forward merge를 적용했습니다." : "merge는 적용하지 않았습니다.",
        result.verified ? "post-merge 검증을 통과했습니다." : "",
        ...result.violations,
      ].filter(Boolean),
    });
  }

  if (!lifecycle.pushedAt) {
    const preflight = await evaluateMergeGate({
      runLogPath: run.logPath,
      repoRoot: run.repoRoot,
      targetBranch: "main",
    });
    if (!preflight.alreadyMerged || preflight.violations.length > 0) {
      return remoteIntegrationReport({
        stage: "push",
        run,
        ok: false,
        lifecycle,
        details: [
          ...preflight.violations,
          preflight.alreadyMerged ? "" : "run commit이 아직 target repo에 통합되지 않았습니다.",
        ].filter(Boolean),
      });
    }

    const result = await pushMerge({
      repoRoot: run.repoRoot,
      remote: "origin",
      branch: "main",
    });
    const nextLifecycle = result.mayPush ? await markRunLifecycle(args, run, "pushed", updatedAt) : undefined;
    return remoteIntegrationReport({
      stage: "push",
      run,
      ok: result.mayPush,
      lifecycle: nextLifecycle ?? lifecycle,
      details: [
        result.mayPush ? "origin main push를 완료했습니다." : "",
        result.push ? `push exit ${result.push.exitCode}` : "",
        ...result.violations,
      ].filter(Boolean),
    });
  }

  if (!lifecycle.cleanedAt) {
    const result = await cleanupCompletedWorktree({
      runLogPath: run.logPath,
      repoRoot: run.repoRoot,
      targetBranch: "main",
      deleteBranch: true,
    });
    const nextLifecycle = result.cleaned ? await markRunLifecycle(args, run, "cleaned", updatedAt) : undefined;
    return remoteIntegrationReport({
      stage: "cleanup",
      run,
      ok: result.cleaned,
      lifecycle: nextLifecycle ?? lifecycle,
      details: [
        result.cleaned ? "worker worktree 정리를 완료했습니다." : "",
        result.worktreePath ? `worktree=${result.worktreePath}` : "",
        result.branch ? `branch=${result.branch}` : "",
        ...result.violations,
      ].filter(Boolean),
    });
  }

  return nowReportForInbox(args);
}

async function handleInboxCommand(command: InboxCommand, args: ParsedArgs): Promise<string> {
  if (command.type === "remote:help") {
    return remoteHelpReport(command.args?.mode === "advanced" ? "advanced" : "basic");
  }
  if (command.type === "remote:deprecated") {
    return remoteDeprecatedCommandReport({
      command: String(command.args?.command ?? "unknown"),
      replacement: String(command.args?.replacement ?? "/now"),
    });
  }
  if (command.type === "status:show") {
    const runs = await new RunIndex(runsPath(args)).list();
    const ops = withoutActiveInboxCommand(await collectOps(args));
    return statusReport({
      runs,
      heartbeat: ops.health.heartbeat,
      pendingInboxCount: ops.queues.pendingInboxCount,
      ops,
      proposals: await new ProposalStore(proposalsPath(args)).list(),
      drafts: await new TaskDraftStore(taskDraftsPath(args)).list(),
      actions: await new RemoteActionStore(remoteActionsPath(args)).list(),
      lifecycles: await new RunLifecycleStore(runLifecyclePath(args)).list(),
    });
  }
  if (command.type === "ops:now") {
    return nowReportForInbox(args);
  }
  if (command.type === "ops:doctor") {
    return doctorReport(withoutActiveInboxCommand(await collectOps(args)));
  }
  if (command.type === "health:check") {
    return healthReport(
      await checkDaemonHealth({
        heartbeatPath: heartbeatPath(args),
        lockPath: daemonLockPath(args),
        maxAgeMs: Number(command.args?.maxAgeMs ?? flag(args, "max-age-ms", "15000")),
      }),
    );
  }
  if (command.type === "runs:list") {
    const runs = await new RunIndex(runsPath(args)).list();
    return runsListReport(runs);
  }
  if (command.type === "runs:show") {
    const id = String(command.args?.id ?? "");
    const run = await new RunIndex(runsPath(args)).find(id);
    return runShowReport(id, run);
  }
  if (command.type === "runs:show-latest") {
    const run = (await new RunIndex(runsPath(args)).list()).at(-1);
    return runShowReport(run?.runId ?? "latest", run);
  }
  if (command.type === "runs:failures") {
    const runs = await new RunIndex(runsPath(args)).list();
    return failuresReport(runs);
  }
  if (command.type === "proposals:add") {
    const proposal: ProposalRecord = {
      schemaVersion: 1,
      id: String(command.args?.id ?? ""),
      text: String(command.args?.text ?? ""),
      source: "remote",
      senderId: String(command.args?.senderId ?? ""),
      status: "pending_review",
      createdAt: String(command.args?.receivedAt ?? new Date().toISOString()),
    };
    if (!proposal.id) throw new Error("proposal id is required");
    if (!proposal.text.trim()) throw new Error("proposal text is required");
    await new ProposalStore(proposalsPath(args)).append(proposal);
    return proposalAddedReport(proposal);
  }
  if (command.type === "proposals:list") {
    const proposals = await new ProposalStore(proposalsPath(args)).list();
    return proposalsListReport(proposals);
  }
  if (command.type === "proposals:show") {
    const id = String(command.args?.id ?? "");
    const proposal = await new ProposalStore(proposalsPath(args)).find(id);
    return proposalShowReport(id, proposal);
  }
  if (command.type === "proposals:show-latest") {
    const proposals = await new ProposalStore(proposalsPath(args)).list();
    const proposal = proposals.slice().reverse().find((item) => item.status === "pending_review") ?? proposals.at(-1);
    return proposalShowReport(proposal?.id ?? "latest", proposal);
  }
  if (command.type === "proposals:accept" || command.type === "proposals:reject") {
    const id = String(command.args?.id ?? "");
    if (!id) throw new Error("proposal id is required");
    const action = command.type === "proposals:accept" ? "accept" : "reject";
    const proposal = await new ProposalStore(proposalsPath(args)).updateStatus(
      id,
      action === "accept" ? "accepted" : "rejected",
      {
        reviewedAt: String(command.args?.receivedAt ?? new Date().toISOString()),
        reviewNote: typeof command.args?.note === "string" ? command.args.note : undefined,
      },
    );
    return proposalReviewedReport(action, proposal);
  }
  if (command.type === "orchestrator:add-request") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const text = String(command.args?.text ?? "");
    if (!text.trim()) throw new Error("orchestration request text is required");
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: String(command.args?.requestId ?? buildOrchestrationRequestId(receivedAt, command.id)),
      source: command.args?.source === "local" ? "local" : "remote",
      senderId: typeof command.args?.senderId === "string" ? command.args.senderId : undefined,
      text,
      status: "pending_plan",
      createdAt: receivedAt,
    };
    if (!request.id) throw new Error("orchestration request id is required");
    await new OrchestrationRequestStore(orchestrationRequestsPath(args)).append(request);
    return orchestrationRequestAddedReport(request);
  }
  if (command.type === "orchestrator:recover-latest") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const recoverable = await latestRecoverableOrchestratorPlan(args);
    if (!recoverable) return nowReportForInbox(args);

    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: String(command.args?.requestId ?? buildOrchestrationRequestId(receivedAt, `recover-${recoverable.plan.id}`)),
      source: command.args?.source === "local" ? "local" : "remote",
      senderId: typeof command.args?.senderId === "string" ? command.args.senderId : undefined,
      text: recoveryRequestText(recoverable),
      status: "pending_plan",
      createdAt: receivedAt,
    };
    await new OrchestrationRequestStore(orchestrationRequestsPath(args)).append(request);
    return orchestratorRecoveryRequestReport({
      request,
      sourcePlan: recoverable.plan,
      failedActions: recoverable.failedActions,
    });
  }
  if (command.type === "orchestrator:revise-latest") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const feedback = String(command.args?.feedback ?? "");
    if (!feedback.trim()) throw new Error("revision feedback is required");

    const planStore = new OrchestratorPlanStore(orchestratorPlansPath(args));
    const plan = await planStore.latestActionable();
    if (!plan) return nowReportForInbox(args);

    const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(args));
    const originalRequest = await requestStore.find(plan.requestId);
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: String(command.args?.requestId ?? buildOrchestrationRequestId(receivedAt, `revise-${plan.id}`)),
      source: command.args?.source === "local" ? "local" : "remote",
      senderId: typeof command.args?.senderId === "string" ? command.args.senderId : undefined,
      text: revisionRequestText({ plan, request: originalRequest, feedback }),
      status: "pending_plan",
      createdAt: receivedAt,
    };
    await requestStore.append(request);
    const supersededPlan = await planStore.markSuperseded(plan.id, {
      supersededAt: receivedAt,
      supersededByRequestId: request.id,
    });
    return orchestratorRevisionRequestReport({ request, supersededPlan });
  }
  if (command.type === "orchestrator:cancel-current") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const reason = typeof command.args?.reason === "string" ? command.args.reason : undefined;
    const planStore = new OrchestratorPlanStore(orchestratorPlansPath(args));
    const plan = await planStore.latestActionable();
    if (plan) {
      const canceled = await planStore.markCanceled(plan.id, { canceledAt: receivedAt, cancelReason: reason });
      return orchestratorCancelReport({ plan: canceled });
    }

    const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(args));
    const request = await requestStore.latestPending();
    if (request) {
      const discarded = await requestStore.markDiscarded(request.id, { discardedAt: receivedAt });
      return orchestratorCancelReport({ request: discarded });
    }

    return nowReportForInbox(args);
  }
  if (command.type === "orchestrator:plan-latest") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(args));
    const request = await requestStore.latestPending();
    if (!request) return nowReportForInbox(args);

    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
    const requestedScopeId = typeof command.args?.scopeId === "string" ? command.args.scopeId : undefined;
    const result = await runOrchestratorPlan({
      request,
      agent: await loadAgentProfile(args, "codex-orchestrator"),
      repoRoot: orchestratorRepoRoot(args),
      projectProfiles: await loadProjectProfiles(projectProfilesDir(args)),
      requestedProjectId,
      requestedScopeId,
      codexBin: codexBin(args),
    });
    const plan: OrchestratorPlanRecord = {
      schemaVersion: 1,
      id: buildOrchestratorPlanId({ requestId: request.id, createdAt: receivedAt }),
      requestId: request.id,
      status: result.status,
      createdAt: receivedAt,
      completedAt: new Date().toISOString(),
      command: result.command,
      rawOutput: result.rawOutput,
      payload: result.payload,
      failure: result.failure,
    };
    await new OrchestratorPlanStore(orchestratorPlansPath(args)).append(plan);
    const reportedRequest =
      plan.status === "failed" ? request : await requestStore.markPlanned(request.id, plan.completedAt ?? receivedAt);
    return orchestratorPlanReport({ request: reportedRequest, plan });
  }
  if (command.type === "orchestrator:show-current-plan") {
    const plan = await new OrchestratorPlanStore(orchestratorPlansPath(args)).latestActionable();
    if (!plan) return nowReportForInbox(args);
    const request = await new OrchestrationRequestStore(orchestrationRequestsPath(args)).find(plan.requestId);
    return orchestratorPlanReport({
      request: request ?? {
        schemaVersion: 1,
        id: plan.requestId,
        source: "remote",
        text: plan.requestId,
        status: "planned",
        createdAt: plan.createdAt,
      },
      plan,
    });
  }
  if (command.type === "drafts:add") {
    const proposalId = String(command.args?.proposalId ?? "");
    if (!proposalId) throw new Error("proposal id is required");
    const proposal = await new ProposalStore(proposalsPath(args)).find(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    const draft = taskDraftFromProposal(proposal, String(command.args?.receivedAt ?? new Date().toISOString()));
    await new TaskDraftStore(taskDraftsPath(args)).append(draft);
    return taskDraftAddedReport(draft);
  }
  if (command.type === "drafts:add-from-proposal-text") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const proposal: ProposalRecord = {
      schemaVersion: 1,
      id: String(command.args?.proposalId ?? ""),
      text: String(command.args?.text ?? ""),
      source: "remote",
      senderId: String(command.args?.senderId ?? ""),
      status: "accepted",
      createdAt: receivedAt,
      reviewedAt: receivedAt,
      reviewNote: "accepted by /draft_propose",
    };
    if (!proposal.id) throw new Error("proposal id is required");
    if (!proposal.text.trim()) throw new Error("proposal text is required");

    const draft = taskDraftFromProposal(proposal, receivedAt);
    await new ProposalStore(proposalsPath(args)).append(proposal);
    await new TaskDraftStore(taskDraftsPath(args)).append(draft);
    return draftProposeAddedReport({ proposal, draft });
  }
  if (command.type === "drafts:list") {
    const drafts = await new TaskDraftStore(taskDraftsPath(args)).list();
    return taskDraftsListReport(drafts);
  }
  if (command.type === "drafts:show") {
    const id = String(command.args?.id ?? "");
    const draft = await new TaskDraftStore(taskDraftsPath(args)).find(id);
    return taskDraftShowReport(id, draft);
  }
  if (command.type === "drafts:show-latest") {
    const drafts = await new TaskDraftStore(taskDraftsPath(args)).list();
    const draft = drafts.slice().reverse().find((item) => item.status === "drafted") ?? drafts.at(-1);
    return taskDraftShowReport(draft?.id ?? "latest", draft);
  }
  if (command.type === "drafts:plan-latest") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const draftStore = new TaskDraftStore(taskDraftsPath(args));
    const draft = (await draftStore.list()).slice().reverse().find((item) => item.status === "drafted");
    if (!draft) return taskDraftShowReport("latest", undefined);

    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
    const requestedScopeId = typeof command.args?.scopeId === "string" ? command.args.scopeId : undefined;
    const { profile: project, inferred: inferredProject } = await projectProfileForRemotePlan({
      args,
      draftProjectId: draft.projectId,
      requestedProjectId,
      requestText: `${draft.title}\n${draft.instructions}`,
    });
    const scope = selectProjectRemoteScope(project, {
      requestedScopeId,
      requestText: `${draft.title}\n${draft.instructions}`,
    });
    const draftPatch =
      scope === undefined
        ? {
            targetFiles: draft.targetFiles.length ? draft.targetFiles : undefined,
            forbiddenChanges: draft.forbiddenChanges.length ? draft.forbiddenChanges : undefined,
            setupCommands: (draft.setupCommands ?? []).length ? draft.setupCommands : undefined,
            verifyCommands: draft.verifyCommands.length ? draft.verifyCommands : undefined,
            resultMode: draft.resultMode,
          }
        : {};
    const patch = applyProjectRemoteScopeDefaults(
      draftPatch,
      project,
      scope,
    );
    const plannedTargetFiles = patch.targetFiles ?? draft.targetFiles;
    const plannedForbiddenChanges = patch.forbiddenChanges ?? draft.forbiddenChanges;
    const targetFileViolations = validateTaskTargetFiles(plannedTargetFiles, plannedForbiddenChanges);
    if (targetFileViolations.length) {
      return taskDraftPlanReport({
        draft: {
          ...draft,
          projectId: patch.projectId ?? draft.projectId,
          repoRoot: patch.repoRoot ?? draft.repoRoot,
          targetFiles: plannedTargetFiles,
          forbiddenChanges: plannedForbiddenChanges,
          setupCommands: patch.setupCommands ?? draft.setupCommands,
          verifyCommands: patch.verifyCommands ?? draft.verifyCommands,
          resultMode: patch.resultMode ?? draft.resultMode,
          updatedAt: receivedAt,
        },
        project,
        scope,
        violations: targetFileViolations,
        inferredProject,
        inferredScope: !requestedScopeId && scope !== undefined,
      });
    }
    const updated = await draftStore.update(draft.id, patch, receivedAt);
    const check = checkTaskDraft(updated, { knownAgentIds: await knownAgentIds(args) });
    return taskDraftPlanReport({
      draft: updated,
      project,
      scope,
      violations: check.violations,
      inferredProject,
      inferredScope: !requestedScopeId && scope !== undefined,
    });
  }
  if (command.type === "drafts:prepare-latest") {
    const projectId = String(command.args?.projectId ?? "");
    if (!projectId) throw new Error("project id is required");
    const rawTargetFiles = command.args?.targetFiles;
    const targetFiles =
      rawTargetFiles === undefined
        ? []
        : Array.isArray(rawTargetFiles) && rawTargetFiles.every((item) => typeof item === "string")
          ? (rawTargetFiles as string[])
          : undefined;
    if (!targetFiles) throw new Error("targetFiles must be a string array");

    const draftStore = new TaskDraftStore(taskDraftsPath(args));
    const draft = (await draftStore.list()).slice().reverse().find((item) => item.status === "drafted");
    if (!draft) return taskDraftShowReport("latest", undefined);

    const project = await loadProjectProfile(projectProfilesDir(args), projectId);
    const targetFileViolations = validateTaskTargetFiles(targetFiles, project.forbiddenChanges);
    if (targetFileViolations.length) {
      return taskDraftPrepareBlockedReport({ draft, projectId, violations: targetFileViolations });
    }
    const updated = await draftStore.update(
      draft.id,
      applyProjectDefaults(targetFiles.length ? { targetFiles } : {}, project),
      String(command.args?.receivedAt ?? new Date().toISOString()),
    );
    const check = checkTaskDraft(updated, { knownAgentIds: await knownAgentIds(args) });
    return taskDraftPreparedReport({ draft: updated, projectId, violations: check.violations });
  }
  if (command.type === "drafts:approve-latest") {
    const draftStore = new TaskDraftStore(taskDraftsPath(args));
    const draft = (await draftStore.list()).slice().reverse().find((item) => item.status === "drafted");
    if (!draft) return taskDraftShowReport("latest", undefined);

    const check = checkTaskDraft(draft, { knownAgentIds: await knownAgentIds(args) });
    if (!check.ok) return taskDraftApprovalBlockedReport({ draft, violations: check.violations });

    const task = taskSpecFromDraft(draft);
    await new TaskStore(tasksPath(args)).append(task);
    const approved = await draftStore.markApproved(draft.id, String(command.args?.receivedAt ?? new Date().toISOString()));
    return taskDraftApprovedReport({ draft: approved, task });
  }
  if (command.type === "tasks:list") {
    const tasks = await new TaskStore(tasksPath(args)).listActive();
    return tasksListReport(tasks);
  }
  if (command.type === "tasks:show") {
    const id = String(command.args?.id ?? "");
    const task = (await new TaskStore(tasksPath(args)).list()).find((item) => item.id === id);
    return taskShowReport(id, task);
  }
  if (command.type === "actions:list") {
    const actions = await new RemoteActionStore(remoteActionsPath(args)).list();
    return remoteActionsListReport(actions);
  }
  if (command.type === "actions:show") {
    const id = String(command.args?.id ?? "");
    const action = await new RemoteActionStore(remoteActionsPath(args)).find(id);
    return remoteActionShowReport(id, action);
  }
  if (command.type === "actions:show-current") {
    const actions = await new RemoteActionStore(remoteActionsPath(args)).list();
    const action =
      actions
        .slice()
        .reverse()
        .find((item) => item.status === "running" || item.status === "approved" || item.status === "waiting" || item.status === "pending") ?? actions.at(-1);
    return remoteActionShowReport(action?.id ?? "current", action);
  }
  if (command.type === "actions:prepare-dispatch") {
    const taskId = String(command.args?.taskId ?? "");
    if (!taskId) throw new Error("task id is required");
    const action = await prepareDispatchActionForTask({
      args,
      taskId,
      receivedAt: String(command.args?.receivedAt ?? new Date().toISOString()),
      commandId: command.id,
    });
    return remoteActionPreparedReport(action);
  }
  if (command.type === "actions:run-next") {
    const existing = (await new RemoteActionStore(remoteActionsPath(args)).list())
      .slice()
      .reverse()
      .find((action) => action.status === "pending" || action.status === "waiting" || action.status === "approved" || action.status === "running");
    if (existing?.status === "pending") return remoteActionPreparedReport(existing);
    if (existing) return remoteActionShowReport(existing.id, existing);

    const task = (await new TaskStore(tasksPath(args)).listActive()).find((item) => item.status === "pending");
    if (!task) return nowReportForInbox(args);
    const action = await prepareDispatchActionForTask({
      args,
      taskId: task.id,
      receivedAt: String(command.args?.receivedAt ?? new Date().toISOString()),
      commandId: command.id,
    });
    return remoteActionPreparedReport(action);
  }
  if (command.type === "actions:go") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const orchestratorPlanStore = new OrchestratorPlanStore(orchestratorPlansPath(args));
    const orchestratorPlan = await orchestratorPlanStore.latestActionable();
    if (orchestratorPlan) {
      if (orchestratorPlan.status !== "planned") {
        return orchestratorGoBlockedReport({ plan: orchestratorPlan });
      }

      const taskStore = new TaskStore(tasksPath(args));
      const actionStore = new RemoteActionStore(remoteActionsPath(args));
      const materialized = materializeOrchestratorPlan({
        plan: orchestratorPlan,
        agents: await loadAgentProfilesById(args, orchestratorPlan.payload?.tasks.map((task) => task.targetAgent) ?? []),
        projects: await loadProjectProfiles(projectProfilesDir(args)),
        existingTaskIds: (await taskStore.list()).map((task) => task.id),
        existingActionIds: (await actionStore.list()).map((action) => action.id),
        createdAt: receivedAt,
        commandId: command.id,
      });
      if (!materialized.ok) {
        return orchestratorGoBlockedReport({ plan: orchestratorPlan, violations: materialized.violations });
      }

      for (const task of materialized.tasks) {
        await taskStore.append(task);
      }
      const materializedActions: RemoteActionRecord[] = [];
      for (const action of materialized.actions) {
        await actionStore.append(action);
        materializedActions.push(
          action.status === "pending" ? await actionStore.markApproved(action.id, receivedAt) : action,
        );
      }
      const plan = await orchestratorPlanStore.markMaterialized(orchestratorPlan.id, {
        approvedAt: receivedAt,
        materializedAt: new Date().toISOString(),
        taskIds: materialized.tasks.map((task) => task.id),
        actionIds: materializedActions.map((action) => action.id),
      });
      return orchestratorGoMaterializedReport({ plan, tasks: materialized.tasks, actions: materializedActions });
    }
    if (await new OrchestrationRequestStore(orchestrationRequestsPath(args)).latestPending()) {
      return nowReportForInbox(args);
    }

    const actionStore = new RemoteActionStore(remoteActionsPath(args));
    const currentAction = (await actionStore.list())
      .slice()
      .reverse()
      .find((item) => item.status === "pending" || item.status === "waiting" || item.status === "approved" || item.status === "running");
    if (currentAction?.status === "pending") {
      return remoteGoReport({ action: await actionStore.markApproved(currentAction.id, receivedAt) });
    }
    if (currentAction) return remoteActionShowReport(currentAction.id, currentAction);

    const taskStore = new TaskStore(tasksPath(args));
    const integrationReport = await advanceLatestPassedRunIntegration(args);
    if (integrationReport) return integrationReport;

    const pendingTask = (await taskStore.listActive()).find((item) => item.status === "pending");
    if (pendingTask) {
      const action = await prepareDispatchActionForTask({
        args,
        taskId: pendingTask.id,
        receivedAt,
        commandId: command.id,
      });
      return remoteGoReport({
        action: await new RemoteActionStore(remoteActionsPath(args)).markApproved(action.id, receivedAt),
        task: pendingTask,
      });
    }

    const draftStore = new TaskDraftStore(taskDraftsPath(args));
    const draft = latestRelevantDraft(await draftStore.list(), await latestPrimaryWorkflowTimestamp(args));
    if (!draft) return nowReportForInbox(args);
    const check = checkTaskDraft(draft, { knownAgentIds: await knownAgentIds(args) });
    if (!check.ok) return taskDraftApprovalBlockedReport({ draft, violations: check.violations });

    const task = taskSpecFromDraft(draft);
    await taskStore.append(task);
    const approvedDraft = await draftStore.markApproved(draft.id, receivedAt);
    const action = await prepareDispatchActionForTask({
      args,
      taskId: task.id,
      receivedAt,
      commandId: command.id,
    });
    return remoteGoReport({
      action: await new RemoteActionStore(remoteActionsPath(args)).markApproved(action.id, receivedAt),
      draft: approvedDraft,
      task,
    });
  }
  if (command.type === "actions:approve") {
    const id = String(command.args?.id ?? "");
    if (!id) throw new Error("action id is required");
    const store = new RemoteActionStore(remoteActionsPath(args));
    const approved = await store.markApproved(id, String(command.args?.receivedAt ?? new Date().toISOString()));
    return remoteActionApprovedReport(approved);
  }
  if (command.type === "actions:approve-latest") {
    const action = (await new RemoteActionStore(remoteActionsPath(args)).list())
      .slice()
      .reverse()
      .find((item) => item.status === "pending");
    if (!action) return nowReportForInbox(args);
    const approved = await new RemoteActionStore(remoteActionsPath(args)).markApproved(
      action.id,
      String(command.args?.receivedAt ?? new Date().toISOString()),
    );
    return remoteActionApprovedReport(approved);
  }
  if (command.type === "ops:next-action") {
    return nowReportForInbox(args);
  }
  if (command.type === "dashboard:build") {
    const out = resolve(flag(args, "out", join(root, "dashboard/index.html")));
    await buildDashboard(args, out);
    return [`# dashboard:build`, "", `Wrote ${out}`, `Wrote ${join(dirname(out), "lane-view.html")}`].join("\n");
  }

  throw new Error(`unsupported inbox command: ${command.type}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "live:format") {
    await formatLiveLogFromStdin();
    return;
  }

  if (args.command === "runs:list") {
    printJson(await new RunIndex(runsPath(args)).list());
    return;
  }

  if (args.command === "runs:show") {
    const runId = args.positionals[0];
    if (!runId) throw new Error("usage: runs:show <run-id>");
    const summary = await new RunIndex(runsPath(args)).find(runId);
    const log = summary ? await readJson(summary.logPath).catch(() => undefined) : undefined;
    printJson({ summary, log });
    return;
  }

  if (args.command === "tasks:add") {
    const taskPath = args.positionals[0];
    if (!taskPath) throw new Error("usage: tasks:add <task.json>");
    const task = await readJson<TaskSpec>(resolve(taskPath));
    await new TaskStore(tasksPath(args)).append(task);
    printJson({ added: task.id });
    return;
  }

  if (args.command === "tasks:list") {
    const taskStore = new TaskStore(tasksPath(args));
    printJson(args.flags.get("include-archived") === true ? await taskStore.list() : await taskStore.listActive());
    return;
  }

  if (args.command === "tasks:show") {
    const taskId = args.positionals[0];
    if (!taskId) throw new Error("usage: tasks:show <task-id>");
    printJson((await new TaskStore(tasksPath(args)).find(taskId)) ?? null);
    return;
  }

  if (args.command === "actions:list") {
    printJson(await new RemoteActionStore(remoteActionsPath(args)).list());
    return;
  }

  if (args.command === "actions:show") {
    const actionId = args.positionals[0];
    if (!actionId) throw new Error("usage: actions:show <action-id>");
    printJson((await new RemoteActionStore(remoteActionsPath(args)).find(actionId)) ?? null);
    return;
  }

  if (args.command === "actions:run-pending") {
    const limit = Math.max(1, Number(flag(args, "limit", "1")));
    const lock = await acquireDaemonLock({
      lockPath: actionRunnerLockPath(args),
      command: "actions:run-pending",
    });
    try {
      printJson({ processed: await runApprovedRemoteActions(args, limit) });
    } finally {
      await lock.release();
    }
    return;
  }

  if (args.command === "actions:watch") {
    const intervalMs = Number(flag(args, "interval-ms", "1000"));
    const limit = Math.max(1, Number(flag(args, "limit", "1")));
    const lock = await acquireDaemonLock({
      lockPath: actionRunnerLockPath(args),
      command: "actions:watch",
    });
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      while (!stopping) {
        await runApprovedRemoteActions(args, limit);
        await Bun.sleep(Number.isFinite(intervalMs) ? intervalMs : 1000);
      }
    } finally {
      await lock.release();
    }
    return;
  }

  if (args.command === "tasks:dispatch") {
    const taskId = args.positionals[0];
    const repoRoot = flag(args, "repo-root", "");
    if (!taskId || !repoRoot) throw new Error("usage: tasks:dispatch <task-id> --repo-root=<repo> [--execute]");

    const taskStore = new TaskStore(tasksPath(args));
    const task = await taskStore.find(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "pending") throw new Error(`task must be pending to dispatch: ${task.status}`);

    const agent = await loadAgentProfile(args, task.targetAgent);
    const execute = args.flags.get("execute") === true;
    const allocate = args.flags.get("allocate") === true || (execute && agent.worktreePolicy === "per-task");
    const worktreesDir = flag(args, "worktrees-dir", "");
    const workerCodexBin = codexBin(args);

    if (!execute) {
      printJson(await prepareWorkerDispatch({
        task,
        agent,
        repoRoot: resolve(repoRoot),
        allocate,
        worktreesDir: worktreesDir || undefined,
        codexBin: workerCodexBin,
      }));
      return;
    }

    const result = await executeTaskDispatch({
      args,
      taskId,
      repoRoot,
      allocate,
      worktreesDir,
      liveLog: args.flags.get("live-log") === true,
      tmux: args.flags.get("tmux") === true,
      tmuxSession: flag(args, "tmux-session", "samantha"),
      codexBin: workerCodexBin,
    });
    printJson(result);
    if (!result.runSummary.pass) process.exitCode = 1;
    return;
  }

  if (args.command === "tasks:retry") {
    const taskId = args.positionals[0];
    if (!taskId) throw new Error("usage: tasks:retry <task-id>");
    const taskStore = new TaskStore(tasksPath(args));
    const task = await taskStore.find(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "failed" && task.status !== "blocked") {
      throw new Error(`task must be failed or blocked to retry: ${task.status}`);
    }
    printJson(await taskStore.updateStatus(task.id, "pending"));
    return;
  }

  if (args.command === "tasks:archive") {
    const taskId = args.positionals[0];
    const reason = flag(args, "reason", "");
    if (!taskId || !reason.trim()) throw new Error("usage: tasks:archive <task-id> --reason=<text>");
    printJson(await new TaskStore(tasksPath(args)).archive(taskId, {
      archivedAt: new Date().toISOString(),
      reason,
    }));
    return;
  }

  if (args.command === "tasks:finalize-worktree") {
    const taskId = args.positionals[0];
    const repoRootFlag = flag(args, "repo-root", "");
    if (!taskId || !repoRootFlag) {
      throw new Error("usage: tasks:finalize-worktree <task-id> --repo-root=<repo> [--worktree=<path>] [--note=<text>]");
    }

    const taskStore = new TaskStore(tasksPath(args));
    const task = await taskStore.find(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);

    const agent = await loadAgentProfile(args, task.targetAgent);
    const repoRoot = await gitTopLevel(resolve(repoRootFlag));
    const worktreesDir = flag(args, "worktrees-dir", "");
    const worktreePath = resolve(
      flag(args, "worktree", worktreePathForTask(repoRoot, task.id, worktreesDir || undefined)),
    );
    const baseCommit = await gitHead(repoRoot);
    const note = flag(args, "note", "manual finalize passed");
    const output = `HARNESS_RESULT: ${JSON.stringify({ status: "pass", note, commit: "" })}`;
    const startedAt = new Date().toISOString();
    const evaluation = await evaluateWorkerResult({
      task,
      cwd: worktreePath,
      baseCommit,
      output,
    });
    const commit =
      evaluation.pass && agent.writerClass === "writer"
        ? await commitWorkerChanges({
            task,
            cwd: worktreePath,
            files: evaluation.changedFiles,
          })
        : undefined;
    const commitPassed = !commit || (commit.add.exitCode === 0 && commit.commit.exitCode === 0);
    const finishedAt = new Date().toISOString();
    const execution = {
      preparation: {
        taskId: task.id,
        agentId: agent.id,
        worktreePath,
        allocation: {
          taskId: task.id,
          repoRoot,
          worktreePath,
          branch: branchForTask(task.id),
          baseCommit,
        },
        codex: {
          prompt: "Manual finalize of an existing worker worktree.",
          command: ["manual", "finalize-worktree"],
        },
      },
      setupResults: [],
      command: {
        command: ["manual", "finalize-worktree"],
        exitCode: 0,
        stdout: output,
        stderr: "",
      },
      evaluation,
      commit,
      pass: evaluation.pass && commitPassed,
    };
    const logInput = {
      task,
      agent,
      repoRoot,
      allocate: true,
      execute: true,
      worktreesDir: worktreesDir || undefined,
      startedAt,
      finishedAt,
      execution,
    };
    const runLog = await writeWorkerRunLog(resolve(flag(args, "log-dir", join(root, "runs"))), logInput);
    const runSummary = summarizeWorkerRun({ ...logInput, runId: runLog.runId, logPath: runLog.path });
    await new RunIndex(runsPath(args)).append(runSummary);
    await taskStore.updateStatus(task.id, runSummary.pass ? "completed" : "failed");
    printJson({ runLog, runSummary });
    if (!runSummary.pass) process.exitCode = 1;
    return;
  }

  if (args.command === "proposals:list") {
    printJson(await new ProposalStore(proposalsPath(args)).list());
    return;
  }

  if (args.command === "proposals:show") {
    const proposalId = args.positionals[0];
    if (!proposalId) throw new Error("usage: proposals:show <proposal-id>");
    printJson((await new ProposalStore(proposalsPath(args)).find(proposalId)) ?? null);
    return;
  }

  if (args.command === "proposals:accept" || args.command === "proposals:reject") {
    const proposalId = args.positionals[0];
    if (!proposalId) throw new Error(`usage: ${args.command} <proposal-id> [--note=<text>]`);
    const status = args.command === "proposals:accept" ? "accepted" : "rejected";
    printJson(
      await new ProposalStore(proposalsPath(args)).updateStatus(proposalId, status, {
        reviewedAt: new Date().toISOString(),
        reviewNote: typeof args.flags.get("note") === "string" ? String(args.flags.get("note")) : undefined,
      }),
    );
    return;
  }

  if (args.command === "proposals:draft-task") {
    const proposalId = args.positionals[0];
    if (!proposalId) throw new Error("usage: proposals:draft-task <proposal-id>");
    const proposal = await new ProposalStore(proposalsPath(args)).find(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    const draft = taskDraftFromProposal(proposal, new Date().toISOString());
    await new TaskDraftStore(taskDraftsPath(args)).append(draft);
    printJson(draft);
    return;
  }

  if (args.command === "drafts:list") {
    printJson(await new TaskDraftStore(taskDraftsPath(args)).list());
    return;
  }

  if (args.command === "drafts:show") {
    const draftId = args.positionals[0];
    if (!draftId) throw new Error("usage: drafts:show <draft-id>");
    printJson((await new TaskDraftStore(taskDraftsPath(args)).find(draftId)) ?? null);
    return;
  }

  if (args.command === "drafts:check") {
    const draftId = args.positionals[0];
    if (!draftId) throw new Error("usage: drafts:check <draft-id>");
    const draft = await new TaskDraftStore(taskDraftsPath(args)).find(draftId);
    const result = checkTaskDraft(draft, { knownAgentIds: await knownAgentIds(args) });
    printJson({
      check: result,
      readiness: taskDraftReadiness(draft, {
        knownAgentIds: await knownAgentIds(args),
        projectId: flag(args, "project", "") || undefined,
      }),
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "drafts:template") {
    const draftId = args.positionals[0];
    if (!draftId) throw new Error("usage: drafts:template <draft-id> [--project=<id>]");
    const draft = await new TaskDraftStore(taskDraftsPath(args)).find(draftId);
    if (!draft) throw new Error(`task draft not found: ${draftId}`);
    const projectId = flag(args, "project", "");
    const defaults = projectId ? applyProjectDefaults({}, await loadProjectProfile(projectProfilesDir(args), projectId)) : {};
    printJson(taskDraftPatchTemplate(draft, defaults));
    return;
  }

  if (args.command === "drafts:update") {
    const draftId = args.positionals[0];
    const from = flag(args, "from", "");
    if (!draftId || !from) throw new Error("usage: drafts:update <draft-id> --from=<draft-patch.json>");
    const projectId = flag(args, "project", "");
    const patch = parseTaskDraftUpdatePatch(await readJson<unknown>(resolve(from)));
    const nextPatch = projectId
      ? applyProjectDefaults(patch, await loadProjectProfile(projectProfilesDir(args), projectId))
      : patch;
    const updated = await new TaskDraftStore(taskDraftsPath(args)).update(draftId, nextPatch, new Date().toISOString());
    printJson({
      draft: updated,
      check: checkTaskDraft(updated, { knownAgentIds: await knownAgentIds(args) }),
      readiness: taskDraftReadiness(updated, {
        knownAgentIds: await knownAgentIds(args),
        projectId: projectId || undefined,
      }),
    });
    return;
  }

  if (args.command === "drafts:prepare") {
    const draftId = args.positionals[0];
    const projectId = flag(args, "project", "");
    if (!draftId || !projectId) throw new Error("usage: drafts:prepare <draft-id> --project=<id> [--from=<draft-patch.json>]");
    const from = flag(args, "from", "");
    const patch = parseTaskDraftUpdatePatch(from ? await readJson<unknown>(resolve(from)) : {});
    const project = await loadProjectProfile(projectProfilesDir(args), projectId);
    const before = await new TaskDraftStore(taskDraftsPath(args)).find(draftId);
    const updated = await new TaskDraftStore(taskDraftsPath(args)).update(
      draftId,
      applyProjectDefaults(patch, project),
      new Date().toISOString(),
    );
    printJson({
      project,
      before: before
        ? {
            targetFiles: before.targetFiles.length,
            forbiddenChanges: before.forbiddenChanges.length,
            setupCommands: before.setupCommands?.length ?? 0,
            verifyCommands: before.verifyCommands.length,
          }
        : undefined,
      draft: updated,
      check: checkTaskDraft(updated, { knownAgentIds: await knownAgentIds(args) }),
      readiness: taskDraftReadiness(updated, { knownAgentIds: await knownAgentIds(args), projectId }),
    });
    return;
  }

  if (args.command === "drafts:approve") {
    const draftId = args.positionals[0];
    if (!draftId) throw new Error("usage: drafts:approve <draft-id>");
    const draftStore = new TaskDraftStore(taskDraftsPath(args));
    const draft = await draftStore.find(draftId);
    const check = checkTaskDraft(draft, { knownAgentIds: await knownAgentIds(args) });
    if (!check.ok || !draft) {
      printJson({
        check,
        readiness: taskDraftReadiness(draft, { knownAgentIds: await knownAgentIds(args) }),
      });
      process.exitCode = 1;
      return;
    }
    const task = taskSpecFromDraft(draft);
    await new TaskStore(tasksPath(args)).append(task);
    const approved = await draftStore.markApproved(draft.id, new Date().toISOString());
    printJson({ approved: approved.id, task });
    return;
  }

  if (args.command === "merge:check") {
    printJson(
      await evaluateMergeGate({
        runLogPath: resolve(flag(args, "run-log", "")),
        repoRoot: resolve(flag(args, "repo-root", ".")),
        targetBranch: flag(args, "target-branch", "main"),
      }),
    );
    return;
  }

  if (args.command === "merge:apply") {
    const runLogPath = resolve(flag(args, "run-log", ""));
    const repoRoot = resolve(flag(args, "repo-root", "."));
    const result = await applyMerge({
      runLogPath,
      repoRoot,
      targetBranch: flag(args, "target-branch", "main"),
    });
    let lifecycle;
    if ((result.applied && result.verified) || (result.gate.alreadyMerged && result.violations.length === 0)) {
      lifecycle = await new RunLifecycleStore(runLifecyclePath(args)).mark(
        lifecycleBaseFromRunLog({
          log: await readWorkerRunLog(runLogPath),
          runLogPath,
          repoRoot,
          updatedAt: new Date().toISOString(),
        }),
        "merged",
        new Date().toISOString(),
      );
    }
    printJson({ ...result, lifecycle });
    return;
  }

  if (args.command === "merge:push") {
    const runLogFlag = flag(args, "run-log", "");
    const repoRoot = resolve(flag(args, "repo-root", "."));
    const branch = flag(args, "branch", "main");
    const remote = flag(args, "remote", "origin");
    let resolvedRunLogPath = "";
    let preflight;
    if (runLogFlag) {
      resolvedRunLogPath = resolve(runLogFlag);
      preflight = await evaluateMergeGate({
        runLogPath: resolvedRunLogPath,
        repoRoot,
        targetBranch: branch,
      });
      if (!preflight.alreadyMerged || preflight.violations.length > 0) {
        printJson({
          mayPush: false,
          remote,
          branch,
          preflight,
          violations: [
            ...preflight.violations,
            ...(preflight.alreadyMerged ? [] : ["run commit is not integrated; run merge:apply first"]),
          ],
        });
        return;
      }
    }
    const result = await pushMerge({
      repoRoot,
      remote,
      branch,
    });
    let lifecycle;
    if (resolvedRunLogPath && result.mayPush) {
      lifecycle = await new RunLifecycleStore(runLifecyclePath(args)).mark(
        lifecycleBaseFromRunLog({
          log: await readWorkerRunLog(resolvedRunLogPath),
          runLogPath: resolvedRunLogPath,
          repoRoot,
          updatedAt: new Date().toISOString(),
        }),
        "pushed",
        new Date().toISOString(),
      );
    }
    printJson({ ...result, preflight, lifecycle });
    return;
  }

  if (args.command === "next-action" || args.command === "ops:next-action") {
    printJson({
      report: await nowReportForInbox(args),
    });
    return;
  }

  if (args.command === "runs:mark-lifecycle") {
    const runLogFlag = flag(args, "run-log", "");
    const repoRoot = resolve(flag(args, "repo-root", "."));
    if (!runLogFlag) throw new Error("usage: runs:mark-lifecycle --run-log=<path> --repo-root=<repo> [--merged] [--pushed] [--cleaned]");
    const runLogPath = resolve(runLogFlag);
    const log = await readWorkerRunLog(runLogPath);
    const store = new RunLifecycleStore(runLifecyclePath(args));
    let lifecycle = lifecycleBaseFromRunLog({
      log,
      runLogPath,
      repoRoot,
      updatedAt: new Date().toISOString(),
    });
    if (args.flags.get("merged") === true) lifecycle = await store.mark(lifecycle, "merged", new Date().toISOString());
    if (args.flags.get("pushed") === true) lifecycle = await store.mark(lifecycle, "pushed", new Date().toISOString());
    if (args.flags.get("cleaned") === true) lifecycle = await store.mark(lifecycle, "cleaned", new Date().toISOString());
    printJson(lifecycle);
    return;
  }

  if (args.command === "worktree:cleanup") {
    const runLogPath = resolve(flag(args, "run-log", ""));
    const repoRoot = resolve(flag(args, "repo-root", "."));
    const result = await cleanupCompletedWorktree({
      runLogPath,
      repoRoot,
      targetBranch: flag(args, "target-branch", "main"),
      deleteBranch: args.flags.get("keep-branch") !== true,
    });
    let lifecycle;
    if (result.cleaned) {
      lifecycle = await new RunLifecycleStore(runLifecyclePath(args)).mark(
        lifecycleBaseFromRunLog({
          log: await readWorkerRunLog(runLogPath),
          runLogPath,
          repoRoot,
          updatedAt: new Date().toISOString(),
        }),
        "cleaned",
        new Date().toISOString(),
      );
    }
    printJson({ ...result, lifecycle });
    return;
  }

  if (args.command === "health:check") {
    const result = await checkDaemonHealth({
      heartbeatPath: heartbeatPath(args),
      lockPath: daemonLockPath(args),
      maxAgeMs: Number(flag(args, "max-age-ms", "15000")),
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "doctor" || args.command === "ops:doctor") {
    const snapshot = await collectOps(args);
    if (args.flags.get("json") === true) {
      printJson(snapshot);
    } else {
      console.log(doctorReport(snapshot));
    }
    if (!snapshot.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "plan:run") {
    const planPath = args.positionals[0];
    if (!planPath) throw new Error("usage: plan:run <plan.json> [--execute]");
    printJson(
      await runPlan({
        planPath: resolve(planPath),
        execute: args.flags.get("execute") === true,
        logDir: resolve(flag(args, "log-dir", join(root, "runs"))),
        stateDir: stateDir(args),
      }),
    );
    return;
  }

  if (args.command === "inbox:process" || args.command === "inbox:watch") {
    const inboxDir = resolve(flag(args, "inbox-dir", join(root, "inbox")));
    const outboxDir = resolve(flag(args, "outbox-dir", join(root, "outbox")));
    const archiveDir = resolve(flag(args, "archive-dir", join(root, "archive/inbox")));
    const intervalMs = Number(flag(args, "interval-ms", "5000"));
    const isWatch = args.command === "inbox:watch";
    const lock = isWatch
      ? await acquireDaemonLock({
          lockPath: daemonLockPath(args),
          command: "inbox:watch",
        })
      : undefined;
    let stopping = false;
    let processedTotal = 0;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      stopping = true;
    };
    const writeWatchHeartbeat = async () => {
      if (!isWatch || !lock) return;
      await writeDaemonHeartbeat(heartbeatPath(args), {
        schemaVersion: 1,
        pid: process.pid,
        command: "inbox:watch",
        status: stopping ? "stopping" : "running",
        lockPath: lock.path,
        inboxDir,
        outboxDir,
        archiveDir,
        processedTotal,
        updatedAt: new Date().toISOString(),
      });
    };

    if (isWatch) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const heartbeatIntervalMs = Math.max(1000, Math.min(Number.isFinite(intervalMs) ? intervalMs : 5000, 5000));
      heartbeatTimer = setInterval(() => {
        void writeWatchHeartbeat().catch((err) => {
          console.error(`failed to write daemon heartbeat: ${errorMessage(err)}`);
        });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      await writeWatchHeartbeat();
    }

    try {
      do {
        const processed = await processInbox({
          inboxDir,
          outboxDir,
          archiveDir,
          handle: (command) => handleInboxCommand(command, args),
        });
        processedTotal += processed.length;
        await writeWatchHeartbeat();
        if (args.command === "inbox:process") {
          printJson({ processed });
          return;
        }
        await Bun.sleep(Number.isFinite(intervalMs) ? intervalMs : 5000);
      } while (!stopping);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await lock?.release();
    }
    return;
  }

  if (args.command === "remote:enqueue") {
    const inputPath = args.positionals[0];
    if (!inputPath) throw new Error("usage: remote:enqueue <remote-command.json>");
    printJson(
      await enqueueRemoteCommand({
        inputPath: resolve(inputPath),
        inboxDir: resolve(flag(args, "inbox-dir", join(root, "inbox"))),
        allowedSenderId: flag(args, "allowed-sender-id", ""),
      }),
    );
    return;
  }

  if (args.command === "telegram:poll") {
    const token = flag(args, "bot-token", process.env.TELEGRAM_BOT_TOKEN ?? "");
    const allowedSenderId = flag(
      args,
      "allowed-sender-id",
      process.env.TELEGRAM_ALLOWED_SENDER_ID ?? process.env.TELEGRAM_CHAT_ID ?? "",
    );
    const offsetPath = telegramOffsetPath(args);
    const storedOffset = await readOptionalJson<{ nextOffset?: number }>(offsetPath);
    const explicitOffset = args.flags.get("offset");
    const offset = typeof explicitOffset === "string" ? Number(explicitOffset) : storedOffset?.nextOffset;
    const result = await pollTelegramToInbox({
      token,
      allowedSenderId,
      inboxDir: resolve(flag(args, "inbox-dir", join(root, "inbox"))),
      offset,
      limit: Number(flag(args, "limit", "10")),
      timeoutSeconds: Number(flag(args, "timeout-seconds", "0")),
    });
    if (result.nextOffset !== undefined) {
      await mkdir(stateDir(args), { recursive: true });
      await writeFile(offsetPath, `${JSON.stringify({ nextOffset: result.nextOffset }, null, 2)}\n`, "utf8");
    }
    printJson(result);
    return;
  }

  if (args.command === "telegram:reply") {
    const token = flag(args, "bot-token", process.env.TELEGRAM_BOT_TOKEN ?? "");
    const chatId = flag(
      args,
      "chat-id",
      process.env.TELEGRAM_REPLY_CHAT_ID ??
        process.env.TELEGRAM_CHAT_ID ??
        process.env.TELEGRAM_ALLOWED_SENDER_ID ??
        "",
    );
    printJson(
      await sendOutboxReplies({
        token,
        chatId,
        outboxDir: resolve(flag(args, "outbox-dir", join(root, "outbox"))),
        statePath: telegramRepliesPath(args),
        limit: Number(flag(args, "limit", "10")),
        minAgeMs: Number(flag(args, "min-age-ms", "1000")),
        markExisting: args.flags.get("mark-existing") === true,
        sendExisting: args.flags.get("send-existing") === true,
      }),
    );
    return;
  }

  if (args.command === "dashboard:build") {
    const out = resolve(flag(args, "out", join(root, "dashboard/index.html")));
    const runs = await buildDashboard(args, out);
    printJson({ out, laneViewOut: join(dirname(out), "lane-view.html"), runs });
    return;
  }

  if (args.command === "dashboard:serve") {
    await serveDashboard(args);
    return;
  }

  console.log(
    [
      "usage: bun run samantha <command>",
      "",
      "routine commands:",
      "  telegram:poll [--allowed-sender-id=<id>] [--bot-token=<token>]",
      "  telegram:reply [--chat-id=<id>] [--mark-existing] [--send-existing]",
      "  inbox:process",
      "  inbox:watch",
      "  actions:run-pending [--limit=1]",
      "  actions:watch [--interval-ms=1000] [--limit=1]",
      "  next-action",
      "  doctor [--json]",
      "  health:check [--max-age-ms=15000]",
      "  dashboard:build",
      "  dashboard:serve [--port=4173] [--host=127.0.0.1]",
      "",
      "integration gates:",
      "  merge:check --run-log=<path> --repo-root=<repo>",
      "  merge:apply --run-log=<path> --repo-root=<repo>",
      "  merge:push --repo-root=<repo> [--run-log=<path>] [--remote=origin] [--branch=main]",
      "  worktree:cleanup --run-log=<path> --repo-root=<repo> [--keep-branch]",
      "  runs:mark-lifecycle --run-log=<path> --repo-root=<repo> [--merged] [--pushed] [--cleaned]",
      "",
      "local debug and recovery:",
      "  runs:list",
      "  runs:show <run-id>",
      "  tasks:add <task.json>",
      "  tasks:list [--include-archived]",
      "  tasks:show <task-id>",
      "  tasks:archive <task-id> --reason=<text>",
      "  tasks:dispatch <task-id> --repo-root=<repo> [--execute] [--tmux] [--live-log]",
      "  tasks:finalize-worktree <task-id> --repo-root=<repo> [--worktree=<path>] [--note=<text>]",
      "  tasks:retry <task-id>",
      "  actions:list",
      "  actions:show <action-id>",
      "  plan:run <plan.json> [--execute]",
      "  remote:enqueue <remote-command.json>",
      "  live:format",
      "",
      "legacy local fallback:",
      "  proposals:list",
      "  proposals:show <proposal-id>",
      "  proposals:accept <proposal-id> [--note=<text>]",
      "  proposals:reject <proposal-id> [--note=<text>]",
      "  proposals:draft-task <proposal-id>",
      "  drafts:list",
      "  drafts:show <draft-id>",
      "  drafts:check <draft-id>",
      "  drafts:template <draft-id> [--project=<id>]",
      "  drafts:update <draft-id> --from=<draft-patch.json>",
      "  drafts:prepare <draft-id> --project=<id> [--from=<draft-patch.json>]",
      "  drafts:approve <draft-id>",
    ].join("\n"),
  );
}

await main();
