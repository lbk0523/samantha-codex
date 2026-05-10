import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentProfile, TaskSpec } from "./lib/contracts";
import { buildCeoStatusSnapshot, formatCeoStatusReport, type CeoStatusSnapshot } from "./lib/ceo-status";
import { buildCeoReportId, CeoReportStore, type CeoReportRecord } from "./lib/ceo-report-store";
import { CostBudgetAuditStore, createRunCostBudgetObservation, type CostBudgetAuditFilter, type CostDataKind } from "./lib/cost-budget-audit";
import { acquireDaemonLock, checkDaemonHealth, readDaemonHeartbeat, writeDaemonHeartbeat } from "./lib/daemon";
import {
  decisionAllowsOrchestratorMaterialization,
  decisionHasCurrentPlanSubject,
  decisionIsCurrentBlockerClarification,
  decisionIsCurrentPlanApproval,
  decisionFromQuestionDraft,
  decisionFromOrchestratorPlan,
  DecisionStore,
  type DecisionItem,
  type DecisionKind,
  type DecisionResolution,
  type DecisionSubject,
} from "./lib/decision-store";
import { buildDecisionHistorySummary } from "./lib/decision-history-summary";
import { writeDashboard, type LiveRunEvent, type LiveRunStatus } from "./lib/dashboard";
import { GovernanceEventStore } from "./lib/governance-event-store";
import { parseGovernanceRiskClass } from "./lib/governance-taxonomy";
import { compactOutboxFileName } from "./lib/ids";
import { processInbox, type InboxCommand } from "./lib/inbox";
import { RunIndex, summarizeWorkerRun, type RunSummary } from "./lib/ledger";
import { buildWorkerLiveLogPath, formatWorkerLiveLogLine, startTmuxObserver, stopTmuxObserver, type TmuxObserverResult } from "./lib/live-log";
import { applyMerge, evaluateMergeGate, pushMerge, readWorkerRunLog } from "./lib/merge-gate";
import {
  doctorReport,
  ceoNotificationReport,
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
  remoteGoNoActionablePlanReport,
  remoteApprovalRedirectReport,
  remoteProjectAmbiguityReport,
  remoteAnswerRecordedReport,
  remoteAnswerRedirectReport,
  remoteDecisionApprovedReport,
  remoteDecisionRejectedReport,
  remoteActionApprovedReport,
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
import { operatorReviewReport, type OperatorReviewSubjectType } from "./lib/operator-review-report";
import { createOrchestratorPlanBlocker, payloadBlockerForPlan, type OrchestratorPlanBlocker } from "./lib/orchestrator-blockers";
import {
  planningMemoryFromContextResults,
  runOrchestratorPlan,
  runOrchestratorQuestionDraft,
  runOrchestratorSynthesis,
  type PlanningMemorySnippet,
} from "./lib/orchestrator-agent";
import { ancestryForPlan, ancestryForRequestIntake, selectedProjectIdFromAncestry } from "./lib/orchestration-ancestry";
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
import { validateAgentProfileGovernance } from "./lib/profile-governance";
import {
  applyProjectDefaults,
  applyProjectRemoteScopeDefaults,
  inferProjectProfile,
  loadProjectProfile,
  loadProjectProfiles,
  selectProjectRemoteScope,
  type ProjectProfile,
} from "./lib/project-profile";
import { ProjectBriefStore } from "./lib/project-brief-store";
import { searchContext } from "./lib/context-search";
import { GovernedMemoryStore } from "./lib/memory-store";
import { ProposalStore, type ProposalRecord } from "./lib/proposal-store";
import {
  createRecoveryDrillOutcomeEvent,
  findRecoveryDrill,
  formatRecoveryDrillReport,
  loadRecoveryDrillCatalog,
  parseRecoveryDrillOutcome,
  recoveryDrillSourceId,
} from "./lib/recovery-drills";
import { createRemoteDispatchAction, RemoteActionStore, type RemoteActionRecord } from "./lib/remote-action-store";
import { enqueueRemoteCommand } from "./lib/remote-command";
import { recoveryResolvedPlanIds } from "./lib/recovery-continuity";
import { buildRecoveryRequestText } from "./lib/recovery-context";
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

function budgetCostKind(value: string): CostDataKind | undefined {
  if (!value) return undefined;
  if (value === "measured" || value === "estimated" || value === "unknown") return value;
  throw new Error(`unknown cost kind: ${value}`);
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

function ceoReportsPath(args: ParsedArgs): string {
  return join(stateDir(args), "ceo-reports.jsonl");
}

function projectBriefsPath(args: ParsedArgs): string {
  return join(stateDir(args), "project-briefs.jsonl");
}

function memoryPath(args: ParsedArgs): string {
  return join(stateDir(args), "memory.jsonl");
}

function decisionsPath(args: ParsedArgs): string {
  return join(stateDir(args), "decisions.jsonl");
}

function governanceEventsPath(args: ParsedArgs): string {
  return join(stateDir(args), "governance-events.jsonl");
}

function costBudgetAuditPath(args: ParsedArgs): string {
  return join(stateDir(args), "budget-audit.jsonl");
}

function recoveryDrillsPath(args: ParsedArgs): string {
  return resolve(flag(args, "drills", join(root, "references/governance/recovery-drills.json")));
}

async function planningMemoryForRequest(input: {
  args: ParsedArgs;
  request: OrchestrationRequestRecord;
  projectProfiles: ProjectProfile[];
  generatedAt: string;
}): Promise<PlanningMemorySnippet[]> {
  const projectId = selectedProjectIdFromAncestry(input.request.ancestry);
  if (!projectId) return [];

  const [
    decisions,
    governanceEvents,
    reports,
    plans,
    projectBriefRead,
    activeMemory,
  ] = await Promise.all([
    new DecisionStore(decisionsPath(input.args)).list(),
    new GovernanceEventStore(governanceEventsPath(input.args)).list(),
    new CeoReportStore(ceoReportsPath(input.args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(input.args)).list(),
    new ProjectBriefStore(projectBriefsPath(input.args), { profiles: input.projectProfiles }).readProjectBrief(projectId),
    new GovernedMemoryStore(memoryPath(input.args), new GovernanceEventStore(governanceEventsPath(input.args))).listActive(),
  ]);

  const decisionSummary = buildDecisionHistorySummary({
    decisions,
    governanceEvents,
    reports,
    plans,
    generatedAt: input.generatedAt,
    scope: { projectId },
  });
  const results = searchContext({
    ceoReports: reports,
    decisionSummaries: [decisionSummary],
    projectBriefReads: [projectBriefRead],
    memoryRecords: activeMemory,
    governanceEvents,
  }, { projectId, limit: 12 }).results;

  return planningMemoryFromContextResults(results, { projectId, limit: 6 });
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

function expandHostPath(path: string): string {
  const home = process.env.HOME?.trim() || homedir();
  let expanded = path;
  if (expanded === "~") expanded = home;
  if (expanded.startsWith("~/")) expanded = join(home, expanded.slice(2));
  return expanded.replace(/\$(\w+)|\$\{([^}]+)\}/g, (match, bareName: string, bracedName: string) => {
    const name = bareName || bracedName;
    if (name === "HOME") return home;
    return process.env[name]?.trim() || match;
  });
}

function projectProfilesDir(args: ParsedArgs): string {
  return resolve(
    expandHostPath(
      flag(args, "project-profiles-dir", process.env.SAMANTHA_PROJECT_PROFILES_DIR ?? join(root, "references/project-profiles")),
    ),
  );
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

function decisionKind(value: string): DecisionKind {
  if (
    value === "manual" ||
    value === "orchestrator_plan_approval" ||
    value === "orchestrator_questions" ||
    value === "blocker_clarification" ||
    value === "risk_acceptance" ||
    value === "agent_profile_change" ||
    value === "capability_change" ||
    value === "memory_change"
  ) {
    return value;
  }
  throw new Error(`unsupported decision kind: ${value}`);
}

function decisionResolution(value: string): DecisionResolution {
  if (
    value === "approved" ||
    value === "rejected" ||
    value === "needs_revision" ||
    value === "answered" ||
    value === "canceled"
  ) {
    return value;
  }
  throw new Error(`unsupported decision resolution: ${value}`);
}

function operatorReviewSubjectType(value: string): OperatorReviewSubjectType {
  if (
    value === "auto" ||
    value === "request" ||
    value === "plan" ||
    value === "decision" ||
    value === "task" ||
    value === "action" ||
    value === "run"
  ) {
    return value;
  }
  throw new Error(`unsupported review subject: ${value}`);
}

function decisionSubject(args: ParsedArgs): DecisionSubject | undefined {
  const type = args.flags.get("subject-type");
  const id = args.flags.get("subject-id");
  if (type === undefined && id === undefined) return undefined;
  if (typeof type !== "string" || typeof id !== "string" || !type || !id) {
    throw new Error("decision subject requires --subject-type and --subject-id");
  }
  if (
    type !== "manual" &&
    type !== "orchestrator_plan" &&
    type !== "remote_action" &&
    type !== "task" &&
    type !== "run" &&
    type !== "agent_profile" &&
    type !== "capability" &&
    type !== "policy"
  ) {
    throw new Error(`unsupported decision subject type: ${type}`);
  }
  return { type, id };
}

function decisionOptions(value: string): string[] {
  return value.split(",").map((option) => option.trim()).filter(Boolean);
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
    if (agent.id === agentId) {
      const check = validateAgentProfileGovernance(agent, await governanceDecisions(args));
      if (!check.ok) throw new Error(`agent profile governance blocked:\n${check.violations.join("\n")}`);
      return agent;
    }
  }
  throw new Error(`agent profile not found: ${agentId}`);
}

async function loadAgentProfilesById(args: ParsedArgs, agentIds: string[]): Promise<AgentProfile[]> {
  const agents: AgentProfile[] = [];
  for (const agentId of new Set(agentIds)) {
    try {
      agents.push(await loadAgentProfile(args, agentId));
    } catch (err) {
      if (!errorMessage(err).startsWith("agent profile not found:")) throw err;
      // Materialization reports unknown target agents as validation violations.
    }
  }
  return agents;
}

async function governanceDecisions(args: ParsedArgs): Promise<DecisionItem[]> {
  return new DecisionStore(decisionsPath(args)).list();
}

async function buildDashboard(args: ParsedArgs, out: string): Promise<number> {
  const [
    runs,
    tasks,
    actions,
    decisions,
    proposals,
    drafts,
    orchestrationRequests,
    orchestratorPlans,
    ops,
    lifecycles,
    reports,
    governanceEvents,
    budgetObservations,
  ] = await Promise.all([
    new RunIndex(runsPath(args)).list(),
    new TaskStore(tasksPath(args)).list(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new DecisionStore(decisionsPath(args)).list(),
    new ProposalStore(proposalsPath(args)).list(),
    new TaskDraftStore(taskDraftsPath(args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    collectOps(args),
    new RunLifecycleStore(runLifecyclePath(args)).list(),
    new CeoReportStore(ceoReportsPath(args)).list(),
    new GovernanceEventStore(governanceEventsPath(args)).list(),
    new CostBudgetAuditStore(costBudgetAuditPath(args)).list(),
  ]);
  const projectId = flag(args, "project", "") || undefined;
  const inboxDir = resolve(flag(args, "inbox-dir", join(root, "inbox")));
  await writeDashboard(out, runs, {
    heartbeat: await readDaemonHeartbeat(heartbeatPath(args)),
    pendingInboxCount: await pendingInboxCount(inboxDir),
    ops,
    proposals,
    drafts,
    tasks,
    lifecycles,
    liveRuns: await readLiveRuns(logDir(args)),
    ceoStatus: buildCeoStatusSnapshot({
      projectId,
      runs,
      tasks,
      decisions,
      actions,
      orchestrationRequests,
      orchestratorPlans,
      orchestratorPlanBlockers: await orchestratorPlanBlockersForReport(args, orchestratorPlans),
      ops,
      lifecycles,
      reports,
      governanceEvents,
      budgetObservations,
    }),
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
  return resolve(expandHostPath(repoRoot));
}

function orchestratorRepoRoot(args: ParsedArgs): string {
  return resolve(
    expandHostPath(flag(args, "orchestrator-repo-root", process.env.SAMANTHA_ORCHESTRATOR_REPO_ROOT ?? root)),
  );
}

function codexBin(args: ParsedArgs): string {
  return flag(args, "codex-bin", process.env.SAMANTHA_CODEX_BIN ?? "codex");
}

async function executeTaskDispatch(input: {
  args: ParsedArgs;
  taskId: string;
  repoRoot: string;
  action?: RemoteActionRecord;
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
    governanceDecisions: await governanceDecisions(input.args),
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
  await tryRecordRunBudgetObservation({
    args: input.args,
    run: runSummary,
    task,
    agent,
    action: input.action,
    command: execution.preparation.codex.command,
  });
  await taskStore.updateStatus(task.id, runSummary.pass ? "completed" : "failed");
  return {
    runLog,
    runSummary,
    ...(liveLogPath ? { liveLog: { path: liveLogPath } } : {}),
    ...(tmux ? { tmux } : {}),
  };
}

async function tryRecordRunBudgetObservation(input: {
  args: ParsedArgs;
  run: RunSummary;
  task: TaskSpec;
  agent: AgentProfile;
  action?: RemoteActionRecord;
  command?: string[];
}): Promise<void> {
  try {
    await new CostBudgetAuditStore(costBudgetAuditPath(input.args)).append(
      createRunCostBudgetObservation({
        observedAt: input.run.finishedAt,
        run: input.run,
        task: input.task,
        agent: input.agent,
        action: input.action,
        command: input.command,
      }),
    );
  } catch (err) {
    console.error(`failed to write budget audit observation: ${errorMessage(err)}`);
  }
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

  const runLogs = await readRunLogsForActions(actions);
  const request = await new OrchestrationRequestStore(orchestrationRequestsPath(args)).find(plan.requestId);
  const sourcePlan = request?.recoveryOfPlanId
    ? await new OrchestratorPlanStore(orchestratorPlansPath(args)).find(request.recoveryOfPlanId)
    : undefined;
  const synthesis = await (async () => {
    try {
      return await runOrchestratorSynthesis({
        plan,
        request,
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
  const artifactPreviews = (await Promise.all(runLogs.map((runLog) => collectReportArtifactPreviews(runLog)))).flat();
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
      sourcePlan,
      artifactPreviews,
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

async function readRunLogsForReview(actions: RemoteActionRecord[], runs: RunSummary[]): Promise<WorkerRunLog[]> {
  const paths = new Set<string>();
  for (const action of actions) {
    if (action.result?.runLogPath) paths.add(action.result.runLogPath);
  }
  for (const run of runs) {
    if (run.logPath) paths.add(run.logPath);
  }

  const logs: WorkerRunLog[] = [];
  for (const path of paths) {
    try {
      logs.push(await readWorkerRunLog(path));
    } catch {
      // The review report flags missing run logs from the state records.
    }
  }
  return logs;
}

async function recoverableOrchestratorPlanCandidates(
  args: ParsedArgs,
  requestedProjectId?: string,
): Promise<RecoverableOrchestratorPlan[]> {
  const [plans, actions, requests] = await Promise.all([
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
  ]);
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const resolvedPlanIds = recoveryResolvedPlanIds({ requests, plans, actions });

  const candidates: RecoverableOrchestratorPlan[] = [];
  for (const plan of plans.slice().reverse()) {
    const actionIds = plan.actionIds ?? [];
    if (plan.status !== "materialized" || !plan.resultReportedAt || actionIds.length === 0) continue;
    if (!planMatchesProject(plan, requestedProjectId)) continue;
    if (resolvedPlanIds.has(plan.id)) continue;

    const planActions = actionIds.map((id) => actionsById.get(id));
    if (planActions.some((action) => !action)) continue;
    if (planActions.some((action) => action?.status !== "completed" && action?.status !== "failed")) continue;

    const finalActions = planActions.filter((action): action is RemoteActionRecord => action !== undefined);
    const failedActions = finalActions.filter(actionNeedsRecovery);
    const synthesisNeedsRecovery = plan.synthesis ? plan.synthesis.outcome !== "pass" : false;
    if (failedActions.length > 0 || synthesisNeedsRecovery) {
      const runLogs = await readRunLogsForActions(finalActions);
      const artifactPreviews = (await Promise.all(runLogs.map((runLog) => collectReportArtifactPreviews(runLog)))).flat();
      candidates.push({
        plan,
        actions: finalActions,
        failedActions,
        request: requestsById.get(plan.requestId),
        runLogs,
        artifactPreviews,
      });
    }
  }

  return candidates;
}

async function latestRecoverableOrchestratorPlan(
  args: ParsedArgs,
  requestedProjectId?: string,
): Promise<RecoverableOrchestratorPlan | undefined> {
  return (await recoverableOrchestratorPlanCandidates(args, requestedProjectId))[0];
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
        action: running,
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
  const plan = validateDispatch(task, agent, undefined, await governanceDecisions(input.args));
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

async function previewOrchestratorPlanMaterialization(input: {
  args: ParsedArgs;
  plan: OrchestratorPlanRecord;
  createdAt: string;
  commandId?: string;
}): Promise<ReturnType<typeof materializeOrchestratorPlan>> {
  try {
    const taskStore = new TaskStore(tasksPath(input.args));
    const actionStore = new RemoteActionStore(remoteActionsPath(input.args));
    return materializeOrchestratorPlan({
      plan: input.plan,
      agents: await loadAgentProfilesById(input.args, input.plan.payload?.tasks.map((task) => task.targetAgent) ?? []),
      projects: await loadProjectProfiles(projectProfilesDir(input.args)),
      existingTaskIds: (await taskStore.list()).map((task) => task.id),
      existingActionIds: (await actionStore.list()).map((action) => action.id),
      createdAt: input.createdAt,
      commandId: input.commandId,
    });
  } catch (err) {
    return {
      ok: false,
      violations: [`orchestrator materialization prerequisite failed: ${errorMessage(err)}`],
      tasks: [],
      actions: [],
    };
  }
}

async function blockerForOrchestratorPlan(input: {
  args: ParsedArgs;
  plan: OrchestratorPlanRecord;
  createdAt: string;
  commandId?: string;
}): Promise<OrchestratorPlanBlocker | undefined> {
  const payloadBlocker = payloadBlockerForPlan(input.plan);
  if (payloadBlocker) return payloadBlocker;
  if (input.plan.status !== "planned") return undefined;

  const materialized = await previewOrchestratorPlanMaterialization(input);
  if (materialized.ok) return undefined;
  return createOrchestratorPlanBlocker({ plan: input.plan, violations: materialized.violations });
}

async function orchestratorPlanBlockersForReport(
  args: ParsedArgs,
  plans?: OrchestratorPlanRecord[],
): Promise<OrchestratorPlanBlocker[]> {
  const candidates = (plans ?? await new OrchestratorPlanStore(orchestratorPlansPath(args)).list())
    .filter((plan) => plan.status === "planned")
    .slice()
    .reverse();
  const blockers: OrchestratorPlanBlocker[] = [];
  for (const plan of candidates) {
    const blocker = await blockerForOrchestratorPlan({
      args,
      plan,
      createdAt: new Date().toISOString(),
      commandId: `preflight-${plan.id}`,
    });
    if (blocker) blockers.push(blocker);
  }
  return blockers;
}

async function nowReportForInbox(args: ParsedArgs): Promise<string> {
  const [runs, tasks, actions, proposals, drafts, orchestrationRequests, orchestratorPlans, decisions, ops, lifecycles, reports, governanceEvents, budgetObservations] = await Promise.all([
    new RunIndex(runsPath(args)).list(),
    new TaskStore(tasksPath(args)).listActive(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new ProposalStore(proposalsPath(args)).list(),
    new TaskDraftStore(taskDraftsPath(args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    new DecisionStore(decisionsPath(args)).list(),
    collectOps(args),
    new RunLifecycleStore(runLifecyclePath(args)).list(),
    new CeoReportStore(ceoReportsPath(args)).list(),
    new GovernanceEventStore(governanceEventsPath(args)).list(),
    new CostBudgetAuditStore(costBudgetAuditPath(args)).list(),
  ]);
  return nowReport({
    runs,
    tasks,
    actions,
    proposals,
    drafts,
    orchestrationRequests,
    orchestratorPlans,
    decisions,
    orchestratorPlanBlockers: await orchestratorPlanBlockersForReport(args, orchestratorPlans),
    ops: withoutActiveInboxCommand(ops),
    lifecycles,
    reports,
    governanceEvents,
    budgetObservations,
  });
}

async function loadCeoStatusSnapshot(args: ParsedArgs): Promise<CeoStatusSnapshot> {
  const [runs, tasks, decisions, actions, orchestrationRequests, orchestratorPlans, ops, lifecycles, reports, governanceEvents, budgetObservations] = await Promise.all([
    new RunIndex(runsPath(args)).list(),
    new TaskStore(tasksPath(args)).list(),
    new DecisionStore(decisionsPath(args)).list(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    collectOps(args),
    new RunLifecycleStore(runLifecyclePath(args)).list(),
    new CeoReportStore(ceoReportsPath(args)).list(),
    new GovernanceEventStore(governanceEventsPath(args)).list(),
    new CostBudgetAuditStore(costBudgetAuditPath(args)).list(),
  ]);
  const projectId = flag(args, "project", "") || undefined;

  return buildCeoStatusSnapshot({
    projectId,
    runs,
    tasks,
    decisions,
    actions,
    orchestrationRequests,
    orchestratorPlans,
    orchestratorPlanBlockers: await orchestratorPlanBlockersForReport(args, orchestratorPlans),
    ops,
    lifecycles,
    reports,
    governanceEvents,
    budgetObservations,
  });
}

async function ensureDecisionForOrchestratorPlan(input: {
  args: ParsedArgs;
  plan: OrchestratorPlanRecord;
  request?: OrchestrationRequestRecord;
  createdAt: string;
}): Promise<DecisionItem | undefined> {
  const subject: DecisionSubject = { type: "orchestrator_plan", id: input.plan.id };
  const store = new DecisionStore(decisionsPath(input.args));
  const existing = await store.latestForSubject(subject);
  if (existing) return existing;

  const decision = decisionFromOrchestratorPlan({
    plan: input.plan,
    request: input.request,
    createdAt: input.createdAt,
    source: "system",
  });
  if (!decision) return undefined;
  await store.append(decision);
  return decision;
}

function decisionGateReport(decision: DecisionItem | undefined): string {
  if (!decision) {
    return ["# decision-required", "", "BK decision required, but no decision item could be created."].join("\n");
  }

  const nextActionLines =
    decision.kind === "blocker_clarification"
      ? [
          `- 답변: ${"`/answer <답변>`"}`,
          `- 수정 요청: ${"`/revise <피드백>`"}`,
          `- 취소: ${"`/cancel`"}`,
        ]
      : [
          `- 계획 승인: ${"`/approve`"}`,
          `- 계획 수정: ${"`/revise <피드백>`"}`,
          `- 계획 취소: ${"`/cancel`"}`,
        ];

  return [
    "# decision-required",
    "",
    decision.kind === "blocker_clarification"
      ? "BK clarification required before Samantha materializes worker tasks."
      : "BK decision required before Samantha materializes worker tasks.",
    `Status: ${decision.status}`,
    `Title: ${decision.title}`,
    `Prompt: ${decision.prompt}`,
    decision.risk ? `Risk: ${decision.risk}` : "",
    decision.kind === "blocker_clarification" && decision.options.length
      ? `Options: ${decision.options.join(" / ")}`
      : "",
    "",
    "다음 액션:",
    ...nextActionLines,
    "",
    "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function validateRemoteProjectContext(input: {
  args: ParsedArgs;
  requestedProjectId?: string;
  requestedScopeId?: string;
}): Promise<void> {
  if (!input.requestedProjectId && input.requestedScopeId) {
    throw new Error("project id is required when scope id is specified");
  }
  if (!input.requestedProjectId) return;
  const project = await loadProjectProfile(projectProfilesDir(input.args), input.requestedProjectId);
  if (input.requestedScopeId) {
    selectProjectRemoteScope(project, { requestedScopeId: input.requestedScopeId });
  }
}

function planProjectId(plan: OrchestratorPlanRecord): string | undefined {
  return selectedProjectIdFromAncestry(plan.ancestry);
}

function planMatchesProject(plan: OrchestratorPlanRecord, requestedProjectId?: string): boolean {
  if (!requestedProjectId) return true;
  return planProjectId(plan) === requestedProjectId;
}

function decisionMatchesProject(decision: DecisionItem, plans: OrchestratorPlanRecord[], requestedProjectId?: string): boolean {
  if (!requestedProjectId) return true;
  const decisionProjectId = selectedProjectIdFromAncestry(decision.ancestry);
  if (decisionProjectId) return decisionProjectId === requestedProjectId;
  if (decision.subject?.type !== "orchestrator_plan") return false;
  const plan = plans.find((item) => item.id === decision.subject?.id);
  return plan?.ancestry?.mode === "assigned" && plan.ancestry.projectId === requestedProjectId;
}

function currentActionablePlans(plans: OrchestratorPlanRecord[], requestedProjectId?: string): OrchestratorPlanRecord[] {
  return plans.filter((plan) => (plan.status === "planned" || plan.status === "questions") && planMatchesProject(plan, requestedProjectId));
}

async function selectSingleCurrentPlan(input: {
  args: ParsedArgs;
  requestedProjectId?: string;
  command: string;
  example?: string;
}): Promise<{ plan?: OrchestratorPlanRecord; report?: string }> {
  await validateRemoteProjectContext({ args: input.args, requestedProjectId: input.requestedProjectId });
  const plans = await new OrchestratorPlanStore(orchestratorPlansPath(input.args)).list();
  const candidates = currentActionablePlans(plans, input.requestedProjectId);
  if (candidates.length === 0) return {};
  if (candidates.length > 1) {
    return {
      report: remoteProjectAmbiguityReport({
        command: input.command,
        reason: "두 개 이상의 현재 계획이 명령 대상이 될 수 있습니다. 잘못된 프로젝트 진행을 막기 위해 실행하지 않았습니다.",
        example: input.example,
      }),
    };
  }
  return { plan: candidates[0] };
}

async function selectPendingRequestForPlan(input: {
  args: ParsedArgs;
  requestedProjectId?: string;
  requestedScopeId?: string;
}): Promise<{ request?: OrchestrationRequestRecord; report?: string }> {
  await validateRemoteProjectContext(input);
  const [requests, projectProfiles] = await Promise.all([
    new OrchestrationRequestStore(orchestrationRequestsPath(input.args)).list(),
    loadProjectProfiles(projectProfilesDir(input.args)),
  ]);
  const pending = requests
    .filter((request) => request.status === "pending_plan")
    .filter((request) => {
      if (!input.requestedProjectId) return true;
      const projectId = selectedProjectIdFromAncestry(request.ancestry);
      return !projectId || projectId === input.requestedProjectId;
    });

  if (pending.length === 0) return {};

  if (!input.requestedProjectId && pending.length === 1) {
    const request = pending[0];
    if (request.ancestry?.mode === "unassigned" && projectProfiles.length > 1) {
      return {
        report: remoteProjectAmbiguityReport({
          command: "/plan",
          reason: "현재 요청의 프로젝트가 확정되지 않았습니다. 계획을 만들기 전에 프로젝트를 지정해야 합니다.",
          example: "/plan <project>",
        }),
      };
    }
    return { request };
  }

  if (pending.length > 1) {
    return {
      report: remoteProjectAmbiguityReport({
        command: "/plan",
        reason: "두 개 이상의 현재 작업 요청이 계획 대상이 될 수 있습니다. 프로젝트를 지정해도 여러 요청이 남으면 로컬에서 정확한 요청을 확인하세요.",
        example: input.requestedProjectId ? undefined : "/plan <project>",
      }),
    };
  }

  return { request: pending[0] };
}

async function resolveLatestDecision(input: {
  args: ParsedArgs;
  receivedAt: string;
  resolution: DecisionResolution;
  note: string;
  remotePlanApprovalOnly?: boolean;
}): Promise<DecisionItem | undefined> {
  const store = new DecisionStore(decisionsPath(input.args));
  const planStore = new OrchestratorPlanStore(orchestratorPlansPath(input.args));
  const plans = await planStore.list();
  const resolved = await store.resolveLatestPending({
    resolvedAt: input.receivedAt,
    resolution: input.resolution,
    note: input.note,
    predicate: (decision) =>
      input.remotePlanApprovalOnly
        ? decisionIsCurrentPlanApproval(decision, plans)
        : decisionHasCurrentPlanSubject(decision, plans),
  });
  await cancelRejectedApprovalPlan({
    planStore,
    decision: resolved,
    canceledAt: input.receivedAt,
    cancelReason: input.note,
  });
  if (resolved) await recordGovernedDecisionApproval(input.args, resolved);
  return resolved;
}

async function cancelRejectedApprovalPlan(input: {
  planStore: OrchestratorPlanStore;
  decision: DecisionItem | undefined;
  canceledAt: string;
  cancelReason: string;
}): Promise<void> {
  if (input.decision?.kind !== "orchestrator_plan_approval") return;
  if (input.decision.resolution !== "rejected") return;
  if (input.decision.subject?.type !== "orchestrator_plan") return;

  const plan = await input.planStore.find(input.decision.subject.id);
  if (plan?.status !== "planned" && plan?.status !== "questions") return;

  await input.planStore.markCanceled(plan.id, {
    canceledAt: input.canceledAt,
    cancelReason: input.cancelReason,
  });
}

async function recordGovernedDecisionApproval(args: ParsedArgs, decision: DecisionItem): Promise<void> {
  if (decision.status !== "resolved" || decision.resolution !== "approved") return;
  if (
    decision.kind !== "agent_profile_change" &&
    decision.kind !== "capability_change" &&
    decision.kind !== "memory_change"
  ) return;
  if (!decision.subject) throw new Error(`${decision.kind} decisions require a subject`);
  if (!decision.risk) throw new Error(`${decision.kind} decisions require a risk class`);
  const subjectType =
    decision.subject.type === "agent_profile" ||
      decision.subject.type === "capability" ||
      decision.subject.type === "policy" ||
      decision.subject.type === "memory"
      ? decision.subject.type
      : undefined;
  if (!subjectType) throw new Error(`${decision.kind} decisions cannot approve subject type: ${decision.subject.type}`);

  await new GovernanceEventStore(governanceEventsPath(args)).create({
    timestamp: decision.resolvedAt ?? new Date().toISOString(),
    actor: decision.resolvedBy ?? "bk",
    source: { kind: "decision", id: decision.id },
    subject: { type: subjectType, id: decision.subject.id },
    kind: "transition_approved",
    riskClass: parseGovernanceRiskClass(decision.risk),
    summary: decision.prompt,
    related: { decisionIds: [decision.id] },
    dedupeKey: `governed-decision-approval:${decision.id}`,
  });
}

function relatedRefsFromFlags(args: ParsedArgs): { decisionIds?: string[]; actionIds?: string[]; runIds?: string[] } | undefined {
  const decisionId = flag(args, "decision-id", "");
  const actionId = flag(args, "action-id", "");
  const runId = flag(args, "run-id", "");
  const related = {
    decisionIds: decisionId ? [decisionId] : undefined,
    actionIds: actionId ? [actionId] : undefined,
    runIds: runId ? [runId] : undefined,
  };
  return related.decisionIds || related.actionIds || related.runIds ? related : undefined;
}

async function resolveLatestRemotePlanApprovalDecision(
  args: ParsedArgs,
  receivedAt: string,
  resolution: "approved" | "rejected",
  requestedProjectId?: string,
): Promise<string> {
  await validateRemoteProjectContext({ args, requestedProjectId });
  const store = new DecisionStore(decisionsPath(args));
  const planStore = new OrchestratorPlanStore(orchestratorPlansPath(args));
  const plans = await planStore.list();
  const candidates = (await store.list()).filter((decision) =>
    decisionIsCurrentPlanApproval(decision, plans) && decisionMatchesProject(decision, plans, requestedProjectId)
  );

  if (candidates.length !== 1) {
    if (candidates.length > 1) {
      return remoteProjectAmbiguityReport({
        command: resolution === "approved" ? "/approve" : "/cancel",
        reason:
          resolution === "approved"
            ? "Telegram approval is only allowed when exactly one current plan approval decision is pending. 두 개 이상의 현재 계획 승인 결정이 명령 대상이 될 수 있습니다. 잘못된 프로젝트 승인을 막기 위해 승인하지 않았습니다."
            : "Telegram rejection is only allowed when exactly one current plan approval decision is pending. 두 개 이상의 현재 계획 승인 결정이 명령 대상이 될 수 있습니다. 잘못된 프로젝트 취소를 막기 위해 거절하지 않았습니다.",
        example: resolution === "approved" ? "/approve project:<project>" : "/cancel project:<project>",
      });
    }
    return remoteApprovalRedirectReport({
      reason:
        resolution === "approved"
          ? candidates.length === 0
            ? "승인할 현재 pending 계획 결정이 없습니다."
            : "Telegram approval is only allowed when exactly one current plan approval decision is pending for the selected project."
          : candidates.length === 0
            ? "거절할 현재 pending 계획 결정이 없습니다."
            : "Telegram rejection is only allowed when exactly one current plan approval decision is pending for the selected project.",
    });
  }

  const note = resolution === "approved" ? "Approved via Telegram /approve." : "Rejected via latest decision command.";
  const resolved = await store.resolve(candidates[0].id, {
    resolvedAt: receivedAt,
    resolution,
    note,
  });
  await cancelRejectedApprovalPlan({
    planStore,
    decision: resolved,
    canceledAt: receivedAt,
    cancelReason: note,
  });

  return resolution === "approved" ? remoteDecisionApprovedReport() : remoteDecisionRejectedReport();
}

async function approveLatestRemoteDecision(args: ParsedArgs, receivedAt: string, requestedProjectId?: string): Promise<string> {
  return resolveLatestRemotePlanApprovalDecision(args, receivedAt, "approved", requestedProjectId);
}

async function answerLatestRemoteBlockerClarification(args: ParsedArgs, receivedAt: string, note: string, requestedProjectId?: string): Promise<string> {
  if (!note.trim()) throw new Error("answer text is required");
  await validateRemoteProjectContext({ args, requestedProjectId });

  const store = new DecisionStore(decisionsPath(args));
  const planStore = new OrchestratorPlanStore(orchestratorPlansPath(args));
  const plans = await planStore.list();
  const candidates = (await store.list()).filter((decision) =>
    decisionIsCurrentBlockerClarification(decision, plans) && decisionMatchesProject(decision, plans, requestedProjectId)
  );

  if (candidates.length !== 1) {
    if (candidates.length > 1) {
      return remoteProjectAmbiguityReport({
        command: "/answer",
        reason: "Telegram answer is only allowed when exactly one current blocker clarification is pending. 두 개 이상의 현재 blocker clarification이 명령 대상이 될 수 있습니다. 잘못된 프로젝트에 답변하지 않도록 기록하지 않았습니다.",
        example: "/answer project:<project> <답변>",
      });
    }
    return remoteAnswerRedirectReport({
      reason:
        candidates.length === 0
          ? "답변할 현재 pending blocker clarification이 없습니다."
          : "Telegram answer is only allowed when exactly one current blocker clarification is pending for the selected project.",
    });
  }

  await store.resolve(candidates[0].id, {
    resolvedAt: receivedAt,
    resolution: "answered",
    note,
  });

  return remoteAnswerRecordedReport();
}

async function writeCeoNotificationOutbox(
  args: ParsedArgs,
  snapshot: CeoStatusSnapshot,
  createdAt: string,
): Promise<{ file: string; path: string; record: CeoReportRecord }> {
  const report = ceoNotificationReport(snapshot);
  const file = compactOutboxFileName({
    createdAt,
    kind: "ceo-notify",
    label: snapshot.overall,
    source: `${createdAt}-${ceoNotificationIdentity(snapshot)}`,
  });
  const dir = outboxDir(args);
  const path = join(dir, file);
  const record: CeoReportRecord = {
    schemaVersion: 1,
    id: buildCeoReportId({ generatedAt: createdAt, outboxFile: file, overall: snapshot.overall }),
    kind: "ceo_notify",
    generatedAt: createdAt,
    outboxFile: file,
    outboxPath: path,
    deliveryStatePath: telegramRepliesPath(args),
    overall: snapshot.overall,
    nextActionKind: snapshot.nextAction.kind,
    decisionCount: snapshot.needsDecision.length,
    activeCount: snapshot.active.length,
    blockedCount: snapshot.blocked.length,
    riskCount: snapshot.risks.length,
  };
  const store = new CeoReportStore(ceoReportsPath(args));
  const existingRecord = await store.find(record.id);
  if (existingRecord) {
    return { file: existingRecord.outboxFile, path: existingRecord.outboxPath, record: existingRecord };
  }
  const persistedRecord = await store.append(record);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${report}\n`, "utf8");
  return { file, path, record: persistedRecord };
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

function ceoNotifyPeriodStart(now: Date): string {
  const period = new Date(now);
  period.setUTCMinutes(0, 0, 0);
  return period.toISOString();
}

function isCeoNotifyDeliveryStateRisk(risk: string): boolean {
  const normalized = risk.toLowerCase();
  return (
    normalized.includes("telegram reply state") ||
    normalized.includes("telegram reply failure") ||
    normalized.includes("unsent remote outbox")
  );
}

function ceoNotificationIdentity(snapshot: CeoStatusSnapshot): string {
  return JSON.stringify({
    overall: snapshot.overall,
    nextAction: {
      kind: snapshot.nextAction.kind,
      targetId: snapshot.nextAction.targetId,
      reason: snapshot.nextAction.reason,
    },
    needsDecision: snapshot.needsDecision.map((item) => ({
      kind: item.kind,
      title: item.title,
      status: item.status,
      reason: item.reason,
      subject: item.subject,
    })),
    active: snapshot.active.map((item) => ({ kind: item.kind, id: item.id, status: item.status, title: item.title })),
    blocked: snapshot.blocked.map((item) => ({ kind: item.kind, id: item.id, status: item.status, title: item.title })),
    historicalFailures: snapshot.historicalFailures.map((item) => ({
      kind: item.kind,
      id: item.id,
      status: item.status,
      title: item.title,
    })),
    risks: snapshot.risks.filter((risk) => !isCeoNotifyDeliveryStateRisk(risk)),
  });
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
        `merge candidate: ${result.status}`,
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
          `merge candidate: ${preflight.status}`,
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
      requests: await new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
      plans: await new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
      decisions: await new DecisionStore(decisionsPath(args)).list(),
      tasks: await new TaskStore(tasksPath(args)).list(),
      actions: await new RemoteActionStore(remoteActionsPath(args)).list(),
      lifecycles: await new RunLifecycleStore(runLifecyclePath(args)).list(),
      reports: await new CeoReportStore(ceoReportsPath(args)).list(),
      governanceEvents: await new GovernanceEventStore(governanceEventsPath(args)).list(),
      orchestratorPlanBlockers: await orchestratorPlanBlockersForReport(args),
      budgetObservations: await new CostBudgetAuditStore(costBudgetAuditPath(args)).list(),
      projectId: typeof command.args?.projectId === "string" ? command.args.projectId : undefined,
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
    const requestId = String(command.args?.requestId ?? buildOrchestrationRequestId(receivedAt, command.id));
    const projectProfiles = await loadProjectProfiles(projectProfilesDir(args));
    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
    await validateRemoteProjectContext({ args, requestedProjectId });
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: requestId,
      ancestry: ancestryForRequestIntake({
        requestId,
        requestText: text,
        projectProfiles,
        requestedProjectId,
      }),
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
    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
    await validateRemoteProjectContext({ args, requestedProjectId });
    const recoverableCandidates = await recoverableOrchestratorPlanCandidates(args, requestedProjectId);
    if (recoverableCandidates.length > 1) {
      return remoteProjectAmbiguityReport({
        command: "/recover",
        reason: "두 개 이상의 현재 복구 후보가 명령 대상이 될 수 있습니다. 잘못된 프로젝트 복구를 막기 위해 요청을 만들지 않았습니다.",
        example: "/recover project:<project>",
      });
    }
    const recoverable = recoverableCandidates[0];
    if (!recoverable) return nowReportForInbox(args);
    const recoveryProjectId = selectedProjectIdFromAncestry(recoverable.plan.ancestry);
    const recoveryProject = recoveryProjectId
      ? await loadProjectProfile(projectProfilesDir(args), recoveryProjectId)
      : undefined;

    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: String(command.args?.requestId ?? buildOrchestrationRequestId(receivedAt, `recover-${recoverable.plan.id}`)),
      ancestry: recoverable.plan.ancestry,
      source: command.args?.source === "local" ? "local" : "remote",
      senderId: typeof command.args?.senderId === "string" ? command.args.senderId : undefined,
      text: buildRecoveryRequestText({
        ...recoverable,
        canonicalProjectRepoRoot: recoveryProject?.repoRoot,
      }),
      status: "pending_plan",
      createdAt: receivedAt,
      recoveryOfPlanId: recoverable.plan.id,
    };
    await new OrchestrationRequestStore(orchestrationRequestsPath(args)).append(request);
    return orchestratorRecoveryRequestReport({
      request,
      sourcePlan: recoverable.plan,
      failedActions: recoverable.failedActions,
    });
  }
  if (command.type === "decisions:approve-latest") {
    return approveLatestRemoteDecision(
      args,
      String(command.args?.receivedAt ?? new Date().toISOString()),
      typeof command.args?.projectId === "string" ? command.args.projectId : undefined,
    );
  }
  if (command.type === "decisions:answer-blocker-clarification") {
    return answerLatestRemoteBlockerClarification(
      args,
      String(command.args?.receivedAt ?? new Date().toISOString()),
      String(command.args?.note ?? ""),
      typeof command.args?.projectId === "string" ? command.args.projectId : undefined,
    );
  }
  if (command.type === "decisions:reject-latest") {
    return resolveLatestRemotePlanApprovalDecision(
      args,
      String(command.args?.receivedAt ?? new Date().toISOString()),
      "rejected",
      typeof command.args?.projectId === "string" ? command.args.projectId : undefined,
    );
  }
  if (command.type === "orchestrator:revise-latest") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const feedback = String(command.args?.feedback ?? "");
    if (!feedback.trim()) throw new Error("revision feedback is required");
    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;

    const planStore = new OrchestratorPlanStore(orchestratorPlansPath(args));
    const selected = await selectSingleCurrentPlan({ args, requestedProjectId, command: "/revise", example: "/revise project:<project> <feedback>" });
    if (selected.report) return selected.report;
    const plan = selected.plan;
    if (!plan) return nowReportForInbox(args);

    const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(args));
    const originalRequest = await requestStore.find(plan.requestId);
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: String(command.args?.requestId ?? buildOrchestrationRequestId(receivedAt, `revise-${plan.id}`)),
      ancestry: plan.ancestry ?? originalRequest?.ancestry,
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
    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
    const selected = await selectSingleCurrentPlan({ args, requestedProjectId, command: "/cancel", example: "/cancel project:<project>" });
    if (selected.report) return selected.report;
    const plan = selected.plan;
    if (plan) {
      const canceled = await planStore.markCanceled(plan.id, { canceledAt: receivedAt, cancelReason: reason });
      return orchestratorCancelReport({ plan: canceled });
    }

    const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(args));
    const requestSelection = await selectPendingRequestForPlan({ args, requestedProjectId });
    if (requestSelection.report) return requestSelection.report;
    const request = requestSelection.request;
    if (request) {
      const discarded = await requestStore.markDiscarded(request.id, { discardedAt: receivedAt });
      return orchestratorCancelReport({ request: discarded });
    }

    return nowReportForInbox(args);
  }
  if (command.type === "orchestrator:plan-latest") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(args));
    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
    const requestedScopeId = typeof command.args?.scopeId === "string" ? command.args.scopeId : undefined;
    const selectedRequest = await selectPendingRequestForPlan({ args, requestedProjectId, requestedScopeId });
    if (selectedRequest.report) return selectedRequest.report;
    const request = selectedRequest.request;
    if (!request) return nowReportForInbox(args);

    const projectProfiles = await loadProjectProfiles(projectProfilesDir(args));
    const planAncestry = ancestryForPlan({
      request,
      projectProfiles,
      requestedProjectId,
    });
    const planRequest: OrchestrationRequestRecord = {
      ...request,
      ancestry: planAncestry,
    };
    const planningMemory = await planningMemoryForRequest({
      args,
      request: planRequest,
      projectProfiles,
      generatedAt: receivedAt,
    });
    const result = await runOrchestratorPlan({
      request: planRequest,
      agent: await loadAgentProfile(args, "codex-orchestrator"),
      repoRoot: orchestratorRepoRoot(args),
      projectProfiles,
      requestedProjectId,
      requestedScopeId,
      planningMemory,
      codexBin: codexBin(args),
    });
    const plan: OrchestratorPlanRecord = {
      schemaVersion: 1,
      id: buildOrchestratorPlanId({ requestId: request.id, createdAt: receivedAt }),
      ancestry: planAncestry,
      requestId: request.id,
      status: result.status,
      createdAt: receivedAt,
      completedAt: new Date().toISOString(),
      command: result.command,
      rawOutput: result.rawOutput,
      payload: result.payload,
      classification: result.classification,
      failure: result.failure,
    };
    await new OrchestratorPlanStore(orchestratorPlansPath(args)).append(plan);
    const reportedRequest =
      plan.status === "failed" ? request : await requestStore.markPlanned(request.id, plan.completedAt ?? receivedAt, { ancestry: planAncestry });
    const blocker = await blockerForOrchestratorPlan({
      args,
      plan,
      createdAt: plan.completedAt ?? receivedAt,
      commandId: `plan-preflight-${plan.id}`,
    });
    if (!blocker) {
      await ensureDecisionForOrchestratorPlan({
        args,
        plan,
        request: reportedRequest,
        createdAt: plan.completedAt ?? receivedAt,
      });
    }
    return orchestratorPlanReport({ request: reportedRequest, plan, blocker });
  }
  if (command.type === "orchestrator:show-current-plan") {
    const selected = await selectSingleCurrentPlan({
      args,
      requestedProjectId: typeof command.args?.projectId === "string" ? command.args.projectId : undefined,
      command: "/plan_current",
      example: "/plan_current project:<project>",
    });
    if (selected.report) return selected.report;
    const plan = selected.plan;
    if (!plan) return nowReportForInbox(args);
    const request = await new OrchestrationRequestStore(orchestrationRequestsPath(args)).find(plan.requestId);
    const blocker = await blockerForOrchestratorPlan({
      args,
      plan,
      createdAt: new Date().toISOString(),
      commandId: `show-preflight-${plan.id}`,
    });
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
      blocker,
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
    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
    const selected = await selectSingleCurrentPlan({ args, requestedProjectId, command: "/go", example: "/go project:<project>" });
    if (selected.report) return selected.report;
    const orchestratorPlan = selected.plan;
    if (orchestratorPlan) {
      if (orchestratorPlan.status !== "planned") {
        return orchestratorGoBlockedReport({ plan: orchestratorPlan });
      }

      const decisionStore = new DecisionStore(decisionsPath(args));
      const currentPlans = await orchestratorPlanStore.list();
      const blockerClarificationCandidates = (await decisionStore.list())
        .filter((decision) =>
          decisionIsCurrentBlockerClarification(decision, currentPlans)
          && decisionMatchesProject(decision, currentPlans, requestedProjectId)
        );
      if (blockerClarificationCandidates.length > 1) {
        return remoteProjectAmbiguityReport({
          command: "/go",
          reason: "두 개 이상의 현재 blocker clarification이 명령 대상이 될 수 있습니다. 먼저 프로젝트를 지정하거나 로컬에서 정확한 항목을 확인하세요.",
          example: "/go project:<project>",
        });
      }
      const currentBlockerClarification = blockerClarificationCandidates.slice().reverse()[0];
      if (currentBlockerClarification) {
        return decisionGateReport(currentBlockerClarification);
      }

      const materialized = await previewOrchestratorPlanMaterialization({
        args,
        plan: orchestratorPlan,
        createdAt: receivedAt,
        commandId: command.id,
      });
      if (!materialized.ok) {
        return orchestratorGoBlockedReport({
          plan: orchestratorPlan,
          violations: materialized.violations,
          blocker: createOrchestratorPlanBlocker({ plan: orchestratorPlan, violations: materialized.violations }),
        });
      }

      const decision = await ensureDecisionForOrchestratorPlan({
        args,
        plan: orchestratorPlan,
        request: await new OrchestrationRequestStore(orchestrationRequestsPath(args)).find(orchestratorPlan.requestId),
        createdAt: receivedAt,
      });
      if (!decisionAllowsOrchestratorMaterialization(decision)) {
        return decisionGateReport(decision);
      }

      const taskStore = new TaskStore(tasksPath(args));
      const actionStore = new RemoteActionStore(remoteActionsPath(args));

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
    const pendingRequests = (await new OrchestrationRequestStore(orchestrationRequestsPath(args)).list())
      .filter((request) => request.status === "pending_plan")
      .filter((request) => {
        if (!requestedProjectId) return true;
        const requestProjectId = selectedProjectIdFromAncestry(request.ancestry);
        return !requestProjectId || requestProjectId === requestedProjectId;
      });
    if (pendingRequests.length > 0) {
      return nowReportForInbox(args);
    }

    const integrationReport = await advanceLatestPassedRunIntegration(args);
    if (integrationReport) return integrationReport;

    return remoteGoNoActionablePlanReport();
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

  if (args.command === "decisions:create") {
    const title = flag(args, "title", "");
    const prompt = flag(args, "prompt", "");
    if (!title || !prompt) throw new Error("usage: decisions:create --title=<text> --prompt=<text>");
    const decision = await new DecisionStore(decisionsPath(args)).create({
      title,
      prompt,
      kind: decisionKind(flag(args, "kind", "manual")),
      source: "local",
      subject: decisionSubject(args),
      options: decisionOptions(flag(args, "options", "approve,reject,revise")),
      risk: flag(args, "risk", "") || undefined,
      createdAt: flag(args, "created-at", new Date().toISOString()),
    });
    printJson(decision);
    return;
  }

  if (args.command === "decisions:list") {
    const store = new DecisionStore(decisionsPath(args));
    printJson(args.flags.get("pending") === true ? await store.listPending() : await store.list());
    return;
  }

  if (args.command === "decisions:approve-latest" || args.command === "decisions:reject-latest") {
    const resolution: "approved" | "rejected" = args.command === "decisions:approve-latest" ? "approved" : "rejected";
    const resolved = await resolveLatestDecision({
      args,
      receivedAt: flag(args, "resolved-at", new Date().toISOString()),
      resolution,
      note:
        flag(args, "note", "") ||
        (resolution === "approved" ? "Approved via decisions:approve-latest." : "Rejected via decisions:reject-latest."),
    });
    printJson(
      resolved
        ? { ok: true, decision: resolved }
        : { ok: true, decision: null, reason: "no current pending decision" },
    );
    return;
  }

  if (args.command === "decisions:resolve") {
    const id = args.positionals[0];
    if (!id) throw new Error("usage: decisions:resolve <decision-id> --resolution=<approved|rejected|needs_revision|answered|canceled>");
    const resolvedAt = flag(args, "resolved-at", new Date().toISOString());
    const note = flag(args, "note", "") || undefined;
    const resolved = await new DecisionStore(decisionsPath(args)).resolve(id, {
      resolvedAt,
      resolution: decisionResolution(flag(args, "resolution", "")),
      note,
    });
    await cancelRejectedApprovalPlan({
      planStore: new OrchestratorPlanStore(orchestratorPlansPath(args)),
      decision: resolved,
      canceledAt: resolvedAt,
      cancelReason: note ?? "Rejected via decisions:resolve.",
    });
    await recordGovernedDecisionApproval(args, resolved);
    printJson(resolved);
    return;
  }

  if (args.command === "decisions:archive") {
    const id = args.positionals[0];
    const reason = flag(args, "reason", "");
    if (!id || !reason) throw new Error("usage: decisions:archive <decision-id> --reason=<text>");
    printJson(
      await new DecisionStore(decisionsPath(args)).archive(id, {
        archivedAt: flag(args, "archived-at", new Date().toISOString()),
        reason,
      }),
    );
    return;
  }

  if (args.command === "orchestrator:question-draft") {
    const blocker = flag(args, "blocker", "");
    if (!blocker) {
      throw new Error("usage: orchestrator:question-draft --blocker=<text> --subject-type=<type> --subject-id=<id> [--context=<text>]");
    }
    const subject = decisionSubject(args);
    if (!subject) throw new Error("orchestrator:question-draft requires --subject-type and --subject-id");
    const subjectPlan = subject.type === "orchestrator_plan"
      ? await new OrchestratorPlanStore(orchestratorPlansPath(args)).find(subject.id)
      : undefined;
    const result = await runOrchestratorQuestionDraft({
      blocker,
      context: [
        flag(args, "context", "") || "",
        subjectPlan?.ancestry?.mode === "assigned"
          ? `ancestry project=${subjectPlan.ancestry.projectId} goal=${subjectPlan.ancestry.goalId} workItem=${subjectPlan.ancestry.workItemId}`
          : "",
      ].filter(Boolean).join("\n") || undefined,
      subject,
      agent: await loadAgentProfile(args, "codex-orchestrator"),
      repoRoot: orchestratorRepoRoot(args),
      codexBin: codexBin(args),
    });
    if (!result.payload) {
      printJson({ ok: false, command: result.command, rawOutput: result.rawOutput, failure: result.failure });
      return;
    }
    const decision = decisionFromQuestionDraft({
      payload: result.payload,
      ancestry: subjectPlan?.ancestry,
      subject,
      createdAt: flag(args, "created-at", new Date().toISOString()),
      source: "system",
    });
    await new DecisionStore(decisionsPath(args)).append(decision);
    printJson({ ok: true, decision, draft: result.payload, command: result.command });
    return;
  }

  if (args.command === "ceo:status") {
    const snapshot = await loadCeoStatusSnapshot(args);
    if (args.flags.get("json") === true) {
      printJson(snapshot);
    } else {
      console.log(formatCeoStatusReport(snapshot, { completedLimit: Number(flag(args, "limit", "10")) }));
    }
    return;
  }

  if (args.command === "orchestrator:current") {
    const projectId = flag(args, "project", "") || undefined;
    await validateRemoteProjectContext({ args, requestedProjectId: projectId });
    const [requests, plans, decisions] = await Promise.all([
      new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
      new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
      new DecisionStore(decisionsPath(args)).list(),
    ]);
    const currentPlans = currentActionablePlans(plans, projectId);
    const currentRequests = requests
      .filter((request) => request.status === "pending_plan")
      .filter((request) => {
        if (!projectId) return true;
        const requestProjectId = selectedProjectIdFromAncestry(request.ancestry);
        return !requestProjectId || requestProjectId === projectId;
      });
    const currentDecisions = decisions.filter((decision) =>
      decision.status === "pending" && decisionHasCurrentPlanSubject(decision, plans) && decisionMatchesProject(decision, plans, projectId)
    );
    printJson({
      projectId: projectId ?? null,
      ambiguous: {
        requests: currentRequests.length > 1,
        plans: currentPlans.length > 1,
        decisions: currentDecisions.length > 1,
      },
      currentRequests,
      currentPlans,
      currentDecisions,
    });
    return;
  }

  if (args.command === "ceo:notify") {
    const now = new Date(flag(args, "now", new Date().toISOString()));
    const createdAt = flag(args, "created-at", ceoNotifyPeriodStart(now));
    const snapshot = await loadCeoStatusSnapshot(args);
    printJson(await writeCeoNotificationOutbox(args, snapshot, createdAt));
    return;
  }

  if (args.command === "runs:list") {
    printJson(await new RunIndex(runsPath(args)).list());
    return;
  }

  if (args.command === "budget:list") {
    const filter: CostBudgetAuditFilter = {
      projectId: flag(args, "project", "") || undefined,
      goalId: flag(args, "goal", "") || undefined,
      workItemId: flag(args, "work-item", "") || undefined,
      runId: flag(args, "run", "") || undefined,
      actionId: flag(args, "action", "") || undefined,
      model: flag(args, "model", "") || undefined,
      costKind: budgetCostKind(flag(args, "cost-kind", "")),
    };
    printJson(await new CostBudgetAuditStore(costBudgetAuditPath(args)).list(filter));
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

  if (args.command === "review:show") {
    const id = args.positionals[0];
    if (!id) throw new Error("usage: review:show <id> [--subject=auto|request|plan|decision|task|action|run]");
    const [requests, plans, decisions, tasks, actions, runs, lifecycles] = await Promise.all([
      new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
      new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
      new DecisionStore(decisionsPath(args)).list(),
      new TaskStore(tasksPath(args)).list(),
      new RemoteActionStore(remoteActionsPath(args)).list(),
      new RunIndex(runsPath(args)).list(),
      new RunLifecycleStore(runLifecyclePath(args)).list(),
    ]);
    console.log(
      operatorReviewReport({
        subject: { type: operatorReviewSubjectType(flag(args, "subject", "auto")), id },
        requests,
        plans,
        decisions,
        tasks,
        actions,
        runs,
        runLogs: await readRunLogsForReview(actions, runs),
        lifecycles,
      }),
    );
    return;
  }

  if (args.command === "drills:list") {
    const catalog = await loadRecoveryDrillCatalog(recoveryDrillsPath(args));
    printJson(
      catalog.drills.map((drill) => ({
        id: drill.id,
        title: drill.title,
        failureMode: drill.failureMode,
        governedSubject: drill.governedSubject,
        projectProfileIds: drill.projectProfileIds,
      })),
    );
    return;
  }

  if (args.command === "drills:show") {
    const id = args.positionals[0];
    if (!id) throw new Error("usage: drills:show <drill-id>");
    const catalog = await loadRecoveryDrillCatalog(recoveryDrillsPath(args));
    const drill = findRecoveryDrill(catalog, id);
    const [projectProfiles, events] = await Promise.all([
      loadProjectProfiles(projectProfilesDir(args)),
      new GovernanceEventStore(governanceEventsPath(args)).list({
        source: { kind: "operator_report", id: recoveryDrillSourceId(drill.id) },
      }),
    ]);
    console.log(formatRecoveryDrillReport({ drill, projectProfiles, events }));
    return;
  }

  if (args.command === "drills:record") {
    const id = args.positionals[0];
    const note = flag(args, "note", "");
    if (!id || !note) {
      throw new Error("usage: drills:record <drill-id> --outcome=<fixed|still_blocked|needs_bk> --note=<summary>");
    }
    const catalog = await loadRecoveryDrillCatalog(recoveryDrillsPath(args));
    const drill = findRecoveryDrill(catalog, id);
    const event = createRecoveryDrillOutcomeEvent({
      drill,
      outcome: parseRecoveryDrillOutcome(flag(args, "outcome", "")),
      timestamp: flag(args, "timestamp", new Date().toISOString()),
      actor: flag(args, "actor", "bk"),
      note,
      related: relatedRefsFromFlags(args),
    });
    printJson(await new GovernanceEventStore(governanceEventsPath(args)).append(event));
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
        governanceDecisions: await governanceDecisions(args),
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
      "  ceo:status [--json] [--limit=10] [--project=<id>]",
      "  ceo:notify",
      "  decisions:create --title=<text> --prompt=<text>",
      "  decisions:list [--pending]",
      "  decisions:approve-latest [--note=<text>]",
      "  decisions:reject-latest [--note=<text>]",
      "  decisions:resolve <decision-id> --resolution=<approved|rejected|needs_revision|answered|canceled>",
      "  decisions:archive <decision-id> --reason=<text>",
      "  orchestrator:current [--project=<id>]",
      "  orchestrator:question-draft --blocker=<text> --subject-type=<type> --subject-id=<id> [--context=<text>]",
      "  next-action",
      "  doctor [--json]",
      "  health:check [--max-age-ms=15000]",
      "  dashboard:build [--project=<id>]",
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
      "  budget:list [--project=<id>] [--goal=<id>] [--work-item=<id>] [--run=<id>] [--action=<id>] [--model=<id>] [--cost-kind=<measured|estimated|unknown>]",
      "  review:show <id> [--subject=auto|request|plan|decision|task|action|run]",
      "  drills:list",
      "  drills:show <drill-id>",
      "  drills:record <drill-id> --outcome=<fixed|still_blocked|needs_bk> --note=<summary>",
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
