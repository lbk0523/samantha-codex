import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentProfile, TaskSpec } from "./lib/contracts";
import {
  AuthorityGrantStore,
  checkAuthorityGrant,
  REPORT_ONLY_AUTOPILOT_ACTIONS,
  type AuthorityGrantRecord,
} from "./lib/authority-grant";
import {
  AutopilotEvidenceStore,
  createAutopilotEvidence,
  type AutopilotEvidenceRecord,
  type AutopilotTransition,
} from "./lib/autopilot-evidence-store";
import { buildCeoStatusSnapshot, formatCeoStatusReport, type CeoStatusSnapshot } from "./lib/ceo-status";
import {
  CeoTurnStore,
  createCeoTurnRecord,
  type CeoTurnActor,
  type CeoTurnDetectedIntent,
  type CeoTurnLinkedStateIds,
  type CeoTurnResponseBoundary,
  type CeoTurnSource,
} from "./lib/ceo-turn-store";
import {
  buildCeoReportId,
  buildNotificationDigestId,
  buildNotificationThrottleKey,
  CeoReportStore,
  classifyNotificationUrgency,
  notificationDigestWindow,
  type CeoNotifyReportRecord,
  type CeoReportRecord,
} from "./lib/ceo-report-store";
import {
  buildConversationMemoryCandidates,
  readCeoConversationMemory,
  type CeoConversationMemoryReadResult,
} from "./lib/conversation-memory";
import {
  BudgetPolicyStore,
  CostBudgetAuditStore,
  createRunCostBudgetObservation,
  type BudgetEvaluationContext,
  type CostBudgetAuditFilter,
  type CostDataKind,
} from "./lib/cost-budget-audit";
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
  remoteDropPendingRequestsReport,
  remoteDuplicateRecoveryPendingRequestReport,
  remoteDuplicatePendingRequestReport,
  remoteReportOnlyAutopilotAdmissionBlockedReport,
  remoteGoNoActionablePlanReport,
  remoteUnblockReport,
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
import { collectOpsSnapshot, withoutActiveInboxCommand, type HostOwnershipRecord, type HostOwnershipRole } from "./lib/ops-diagnostics";
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
import { decideQueueAdmission, findBudgetPolicyForGate, formatQueueAdmissionDecision, queueAdmissionRecord, buildQueuePressureSnapshot, type QueueAdmissionDecisionResult } from "./lib/queue-pressure";
import {
  applyProjectDefaults,
  applyProjectRemoteScopeDefaults,
  classifyRemoteRequest,
  inferProjectProfile,
  loadProjectProfile,
  loadProjectProfiles,
  selectProjectRemoteScope,
  type ProjectProfile,
} from "./lib/project-profile";
import { ProjectBriefStore } from "./lib/project-brief-store";
import { searchContext, type ContextSearchResult } from "./lib/context-search";
import { GovernedMemoryStore } from "./lib/memory-store";
import { LearningCandidateStore, ProposalStore, type LearningCandidateRecord, type ProposalRecord } from "./lib/proposal-store";
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
import { currentOrchestratorPlanNeedsRecovery } from "./lib/orchestrator-recovery";
import {
  RoutineTriggerObservationStore,
  RoutineTriggerStore,
  routineActivationPolicy,
  routineObservationToOrchestrationRequest,
  type RoutineTriggerRecord,
} from "./lib/routine-trigger-store";
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
import { buildOperatingSurfaceView } from "./lib/operating-surface";
import {
  buildBackupManifest,
  validateHostMigration,
  validateRestore,
} from "./lib/backup-restore";

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

function learningCandidatesPath(args: ParsedArgs): string {
  return join(stateDir(args), "learning-candidates.jsonl");
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

function ceoTurnsPath(args: ParsedArgs): string {
  return join(stateDir(args), "ceo-turns.jsonl");
}

function projectBriefsPath(args: ParsedArgs): string {
  return join(stateDir(args), "project-briefs.jsonl");
}

function memoryPath(args: ParsedArgs): string {
  return join(stateDir(args), "memory.jsonl");
}

function conversationMemoryPath(args: ParsedArgs): string {
  return resolve(flag(args, "conversation-memory", join(root, "CEO_Conversation_MEMORY.md")));
}

function authorityGrantsPath(args: ParsedArgs): string {
  return join(stateDir(args), "authority-grants.jsonl");
}

function autopilotEvidencePath(args: ParsedArgs): string {
  return join(stateDir(args), "autopilot-evidence.jsonl");
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

function budgetPoliciesPath(args: ParsedArgs): string {
  return join(stateDir(args), "budget-policies.jsonl");
}

function routineTriggersPath(args: ParsedArgs): string {
  return join(stateDir(args), "routine-triggers.jsonl");
}

function routineTriggerObservationsPath(args: ParsedArgs): string {
  return join(stateDir(args), "routine-trigger-observations.jsonl");
}

function recoveryDrillsPath(args: ParsedArgs): string {
  return resolve(flag(args, "drills", join(root, "references/governance/recovery-drills.json")));
}

function backupManifestPath(args: ParsedArgs): string {
  return resolve(flag(args, "manifest", join(root, "backup-manifest.json")));
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
    conversationMemory,
  ] = await Promise.all([
    new DecisionStore(decisionsPath(input.args)).list(),
    new GovernanceEventStore(governanceEventsPath(input.args)).list(),
    new CeoReportStore(ceoReportsPath(input.args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(input.args)).list(),
    new ProjectBriefStore(projectBriefsPath(input.args), { profiles: input.projectProfiles }).readProjectBrief(projectId),
    new GovernedMemoryStore(memoryPath(input.args), new GovernanceEventStore(governanceEventsPath(input.args))).listActive(),
    readCeoConversationMemory(conversationMemoryPath(input.args)),
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
    conversationMemory: [conversationMemory],
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

function hostOwnershipPath(args: ParsedArgs): string {
  return resolve(flag(args, "host-ownership-path", join(stateDir(args), "host-ownership.json")));
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

function stableHostId(value: string): string | undefined {
  const hostId = value.trim();
  return hostId && !/[\\/]/.test(hostId) ? hostId : undefined;
}

function isoTimestampFlag(name: string, value: string): string {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be a valid ISO timestamp`);
  }
  return value;
}

async function writeHostOwnership(args: ParsedArgs, role: HostOwnershipRole): Promise<void> {
  const hostId = stableHostId(flag(args, "host-id", ""));
  if (!hostId) {
    throw new Error(`usage: ${args.command} --host-id=<id>${role === "active_automation_host" ? " [--expires-at=<iso>]" : ""}`);
  }
  const expiresAt = role === "active_automation_host" ? flag(args, "expires-at", "") : "";
  const record: HostOwnershipRecord = {
    schemaVersion: 1,
    role,
    hostId,
    updatedAt: new Date().toISOString(),
    ...(expiresAt ? { expiresAt: isoTimestampFlag("--expires-at", expiresAt) } : {}),
  };
  const path = hostOwnershipPath(args);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  printJson({ path, record });
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
    value === "routine_change" ||
    value === "budget_change" ||
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
    type !== "routine" &&
    type !== "policy" &&
    type !== "memory" &&
    type !== "budget"
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
    budgetPolicies,
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
    new BudgetPolicyStore(budgetPoliciesPath(args)).list(),
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
      taskDrafts: drafts,
      actions,
      orchestrationRequests,
      orchestratorPlans,
      orchestratorPlanBlockers: await orchestratorPlanBlockersForReport(args, orchestratorPlans),
      ops,
      lifecycles,
      reports,
      governanceEvents,
      budgetObservations,
      budgetPolicies,
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
  const hostId = flag(args, "host-id", process.env.SAMANTHA_HOST_ID ?? "").trim();
  return collectOpsSnapshot({
    envFilePath: envFilePath(args),
    inboxDir: resolve(flag(args, "inbox-dir", join(root, "inbox"))),
    outboxDir: resolve(flag(args, "outbox-dir", join(root, "outbox"))),
    archiveInboxDir: resolve(flag(args, "archive-dir", join(root, "archive", "inbox"))),
    hostOwnershipPath: hostOwnershipPath(args),
    currentHostId: hostId || undefined,
    heartbeatPath: heartbeatPath(args),
    lockPath: daemonLockPath(args),
    telegramOffsetPath: telegramOffsetPath(args),
    telegramRepliesPath: telegramRepliesPath(args),
    maxAgeMs: Number(flag(args, "max-age-ms", "15000")),
    maxPendingInboxAgeMs: Number(flag(args, "max-pending-inbox-age-ms", "300000")),
    localOnly: args.flags.get("local-only") === true,
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

async function buildAndRecordOrchestratorPlanResultReport(
  args: ParsedArgs,
  plan: OrchestratorPlanRecord,
  reportedAt = new Date().toISOString(),
): Promise<string | undefined> {
  const actionIds = plan.actionIds ?? [];
  if (actionIds.length === 0 || plan.resultReportedAt) return undefined;

  const actions = (await new RemoteActionStore(remoteActionsPath(args)).list()).filter((action) =>
    actionIds.includes(action.id),
  );
  if (actions.length !== actionIds.length) return undefined;
  if (actions.some((action) =>
    action.status === "pending" || action.status === "waiting" || action.status === "approved" || action.status === "running"
  )) {
    return undefined;
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
  const report = orchestratorPlanResultReport({
    plan,
    actions,
    runLogs,
    synthesis: synthesis.payload,
    synthesisFailure: synthesis.failure,
    sourcePlan,
    artifactPreviews,
  });
  await new OrchestratorPlanStore(orchestratorPlansPath(args)).markResultReported(plan.id, {
    resultReportedAt: reportedAt,
    synthesisAt: synthesis.payload || synthesis.failure ? reportedAt : undefined,
    synthesis: synthesis.payload,
    synthesisFailure: synthesis.failure,
  });
  return report;
}

async function writeOrchestratorPlanResultOutbox(args: ParsedArgs, plan: OrchestratorPlanRecord): Promise<void> {
  const reportedAt = new Date().toISOString();
  const report = await buildAndRecordOrchestratorPlanResultReport(args, plan, reportedAt);
  if (!report) return;
  const file = compactOutboxFileName({
    createdAt: reportedAt,
    kind: "plan-result",
    label: plan.payload?.summary ?? plan.requestId,
    source: plan.id,
  });
  await mkdir(outboxDir(args), { recursive: true });
  await writeFile(
    join(outboxDir(args), file),
    `${report}\n`,
    "utf8",
  );
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

type RemoteUnblockCandidateKind = "failed_plan" | "blocked_plan";

interface RemoteUnblockCandidate {
  kind: RemoteUnblockCandidateKind;
  plan: OrchestratorPlanRecord;
  reason: string;
  blocker?: OrchestratorPlanBlocker;
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

function planActivityTime(plan: OrchestratorPlanRecord): number {
  return Math.max(
    timestamp(plan.synthesisAt),
    timestamp(plan.resultReportedAt),
    timestamp(plan.materializedAt),
    timestamp(plan.approvedAt),
    timestamp(plan.completedAt),
    timestamp(plan.createdAt),
  );
}

async function remoteUnblockCandidates(
  args: ParsedArgs,
  requestedProjectId?: string,
): Promise<RemoteUnblockCandidate[]> {
  const plans = await new OrchestratorPlanStore(orchestratorPlansPath(args)).list();
  const blockers = new Map((await orchestratorPlanBlockersForReport(args, plans)).map((blocker) => [blocker.planId, blocker]));
  return plans
    .filter((plan) => planMatchesProject(plan, requestedProjectId))
    .flatMap((plan): RemoteUnblockCandidate[] => {
      const blocker = blockers.get(plan.id);
      if (blocker) {
        return [{
          kind: "blocked_plan",
          plan,
          blocker,
          reason: blocker.violations[0] ?? "plan materialization is blocked",
        }];
      }
      if (plan.status === "failed" && currentOrchestratorPlanNeedsRecovery(plan, plans)) {
        return [{
          kind: "failed_plan",
          plan,
          reason: plan.failure ?? plan.synthesisFailure ?? plan.synthesis?.summary ?? "planning failed",
        }];
      }
      return [];
    })
    .sort((left, right) => planActivityTime(right.plan) - planActivityTime(left.plan));
}

async function handleRemoteUnblock(input: {
  args: ParsedArgs;
  receivedAt: string;
  requestedProjectId?: string;
  reason?: string;
  command: string;
}): Promise<string> {
  await validateRemoteProjectContext({ args: input.args, requestedProjectId: input.requestedProjectId });
  const candidates = await remoteUnblockCandidates(input.args, input.requestedProjectId);
  if (candidates.length > 1 && !input.requestedProjectId) {
    return remoteProjectAmbiguityReport({
      command: input.command,
      reason: "두 개 이상의 stale planning block이 명령 대상이 될 수 있습니다. 잘못된 프로젝트 block을 제거하지 않도록 실행하지 않았습니다.",
      example: "/unblock project:<project>",
      examples: projectExamplesForRecords(candidates.map((candidate) => candidate.plan), "/unblock"),
    });
  }

  const candidate = candidates[0];
  if (!candidate) {
    const ops = withoutActiveInboxCommand(await collectOps(input.args));
    const pressure = await queuePressureForReport(input.args, ops, input.requestedProjectId);
    return remoteUnblockReport({
      changed: false,
      projectId: input.requestedProjectId,
      remainingSafeCandidates: 0,
      pressureClass: pressure.pressureClass,
      nextTelegram: pressure.metrics.recoveryNeeds > 0
        ? `/recover${input.requestedProjectId ? ` project:${input.requestedProjectId}` : ""}`
        : "/now",
    });
  }

  const planStore = new OrchestratorPlanStore(orchestratorPlansPath(input.args));
  if (candidate.kind === "blocked_plan") {
    await planStore.markCanceled(candidate.plan.id, {
      canceledAt: input.receivedAt,
      cancelReason: input.reason ?? candidate.reason,
    });
  } else {
    await planStore.markSuperseded(candidate.plan.id, {
      supersededAt: input.receivedAt,
      supersededByRequestId: buildOrchestrationRequestId(input.receivedAt, `unblock-${candidate.plan.id}`),
    });
  }

  const remaining = await remoteUnblockCandidates(input.args, input.requestedProjectId);
  const ops = withoutActiveInboxCommand(await collectOps(input.args));
  const pressure = await queuePressureForReport(input.args, ops, input.requestedProjectId);
  return remoteUnblockReport({
    changed: true,
    projectId: input.requestedProjectId ?? selectedProjectIdFromAncestry(candidate.plan.ancestry),
    clearedKind: candidate.kind,
    reason: input.reason ?? candidate.reason,
    remainingSafeCandidates: remaining.length,
    pressureClass: pressure.pressureClass,
    nextTelegram: pressure.pressureClass === "normal" || pressure.pressureClass === "watch" ? "/now" : "/check",
  });
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
    const actions = await store.list();
    const action = actions.find((item) => item.status === "approved");
    if (!action) break;
    const startedAt = new Date().toISOString();
    const dependentWaitingActionIds = actions
      .filter((item) => item.status === "waiting" && (item.dependsOnActionIds ?? []).includes(action.id))
      .map((item) => item.id);
    const admission = await queueAdmissionFor({
      args,
      subjectKind: "action",
      projectId: selectedProjectIdFromAncestry(action.ancestry),
      budgetContext: budgetContextForAction(action),
      excludeActionId: action.id,
      excludeActionIds: dependentWaitingActionIds,
    });
    if (admission.decision !== "accept") {
      results.push({ actionId: action.id, status: `admission_${admission.decision}` });
      break;
    }
    const runId = buildWorkerRunId({ startedAt, taskId: action.taskId });
    const running = await store.markRunning(action.id, startedAt, {
      runId,
      liveLogPath: buildWorkerLiveLogPath(logDir(args), runId),
    });
    if (running.kind !== "dispatch_task") throw new Error(`unsupported remote action kind: ${running.kind}`);

    try {
      const result = await executeTaskDispatch({
        args,
        taskId: running.taskId,
        repoRoot: running.repoRoot,
        action: running,
        allocate: running.allocate,
        liveLog: true,
        startedAt,
      });
      const finished = await store.markFinished(running.id, {
        status: result.runSummary.pass ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        result: {
          runId: result.runSummary.runId,
          runLogPath: result.runLog.path,
          liveLogPath: result.liveLog?.path,
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
      const admission = await queueAdmissionFor({
        args,
        subjectKind: "action",
        projectId: selectedProjectIdFromAncestry(action.ancestry),
        budgetContext: budgetContextForAction(action),
        excludeActionId: action.id,
      });
      if (admission.decision !== "accept") continue;
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

async function runAutopilotReportActions(args: ParsedArgs, actionIds: string[]): Promise<RemoteActionRecord[]> {
  const store = new RemoteActionStore(remoteActionsPath(args));
  const targetIds = new Set(actionIds);
  const finished: RemoteActionRecord[] = [];

  while (finished.length < actionIds.length) {
    await promoteReadyWaitingActions(args, store);
    const actions = await store.list();
    const targets = actions.filter((action) => targetIds.has(action.id));
    const finalTargets = targets.filter((action) => action.status === "completed" || action.status === "failed");
    if (finalTargets.length === actionIds.length) return finalTargets;

    const action = targets.find((item) => item.status === "approved");
    if (!action) {
      const waiting = targets.find((item) => item.status === "pending" || item.status === "waiting" || item.status === "running");
      throw new Error(`autopilot report action is not ready: ${waiting?.id ?? "missing action"}`);
    }

    const task = await new TaskStore(tasksPath(args)).find(action.taskId);
    const agent = task ? await loadAgentProfile(args, task.targetAgent) : undefined;
    if (!task || task.resultMode !== "report" || agent?.writerClass !== "non-writer") {
      throw new Error(`autopilot may only execute non-writer report actions: ${action.id}`);
    }

    const startedAt = new Date().toISOString();
    const admission = await queueAdmissionFor({
      args,
      subjectKind: "action",
      projectId: selectedProjectIdFromAncestry(action.ancestry),
      budgetContext: budgetContextForAction(action),
      excludeActionId: action.id,
      excludeActionIds: actionIds.filter((id) => id !== action.id),
    });
    if (admission.decision !== "accept") throw new Error(`autopilot action admission ${admission.decision}: ${admission.reason}`);

    const runId = buildWorkerRunId({ startedAt, taskId: action.taskId });
    const running = await store.markRunning(action.id, startedAt, {
      runId,
      liveLogPath: buildWorkerLiveLogPath(logDir(args), runId),
    });

    try {
      const result = await executeTaskDispatch({
        args,
        taskId: running.taskId,
        repoRoot: running.repoRoot,
        action: running,
        allocate: false,
        liveLog: true,
        startedAt,
      });
      const completed = await store.markFinished(running.id, {
        status: result.runSummary.pass ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        result: {
          runId: result.runSummary.runId,
          runLogPath: result.runLog.path,
          liveLogPath: result.liveLog?.path,
          pass: result.runSummary.pass,
          outcome: result.runSummary.outcome,
          failure: result.runSummary.failureReason,
        },
      });
      if (!result.runSummary.pass) await markActionTaskFailed(args, completed);
      finished.push(completed);
    } catch (err) {
      const failed = await store.markFinished(running.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        result: { failure: errorMessage(err) },
      });
      await markActionTaskFailed(args, failed);
      finished.push(failed);
    }
  }

  return finished;
}

function autopilotResultReport(input: {
  request: OrchestrationRequestRecord;
  authorityGrant?: AuthorityGrantRecord;
  evidence?: AutopilotEvidenceRecord;
  status: "completed" | "blocked" | "failed";
  endpoint: "result" | "bk_judgment" | "local_only_blocker";
  summary: string;
  planReport?: string;
  resultReport?: string;
  failure?: string;
}): string {
  const nestedReport = stripReportOnlyCommandChoreography(input.resultReport ?? input.planReport ?? "");
  const lines = [
    "# autopilot-result",
    "",
    `상태: \`${input.status}\``,
    "BK 입력: `1회`",
    `요청: \`${input.request.id}\``,
    input.authorityGrant ? `권한: \`${input.authorityGrant.id}\`` : "",
    input.evidence ? `증거: \`${input.evidence.id}\`` : "",
    `종료 조건: \`${input.endpoint}\``,
    `요약: ${input.summary}`,
    input.failure ? `막힌 이유: ${input.failure}` : "",
    "",
    nestedReport,
  ];
  return lines.filter((line) => line !== "").join("\n");
}

const reportOnlyCommandChoreographyPattern = /(^|[^\w/])\/(?:plan|go|approve|now|check)\b/;

function stripReportOnlyCommandChoreography(report: string): string {
  const lines = report.split("\n").filter((line) => !reportOnlyCommandChoreographyPattern.test(line));
  while (lines.at(-1)?.trim() === "") lines.pop();
  if (lines.at(-1)?.trim() === "다음 액션:") lines.pop();
  return lines.join("\n");
}

async function appendAutopilotEvidence(input: {
  args: ParsedArgs;
  request: OrchestrationRequestRecord;
  plan?: OrchestratorPlanRecord;
  authorityGrant?: AuthorityGrantRecord;
  projectId?: string;
  scopeId?: string;
  resultMode?: "report";
  startedAt: string;
  transitions: AutopilotTransition[];
  endpoint: "result" | "bk_judgment" | "local_only_blocker";
  status: "completed" | "blocked" | "failed";
  actionIds?: string[];
  runIds?: string[];
  failure?: string;
  summary: string;
}): Promise<AutopilotEvidenceRecord> {
  const record = createAutopilotEvidence({
    requestId: input.request.id,
    planId: input.plan?.id,
    authorityGrantId: input.authorityGrant?.id,
    projectId: input.projectId,
    scopeId: input.scopeId,
    resultMode: input.resultMode,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    transitions: [...input.transitions, "record_autopilot_evidence"],
    endpoint: input.endpoint,
    status: input.status,
    actionIds: input.actionIds,
    runIds: input.runIds,
    failure: input.failure,
    summary: input.summary,
  });
  await new AutopilotEvidenceStore(autopilotEvidencePath(input.args)).append(record);
  return record;
}

async function tryRunRemoteReportOnlyAutopilot(input: {
  args: ParsedArgs;
  request: OrchestrationRequestRecord;
  receivedAt: string;
  requestedProjectId?: string;
}): Promise<string | undefined> {
  if (input.request.source !== "remote") return undefined;

  const startedAt = input.receivedAt;
  const transitions: AutopilotTransition[] = ["remote_intake", "classify_request"];
  const classification = classifyRemoteRequest(input.request.text);
  const projectId = input.requestedProjectId ?? selectedProjectIdFromAncestry(input.request.ancestry);
  if (!projectId) return undefined;

  const project = await loadProjectProfile(projectProfilesDir(input.args), projectId);
  const scope = selectProjectRemoteScope(project, { requestText: input.request.text });
  const authority = checkAuthorityGrant(
    await new AuthorityGrantStore(authorityGrantsPath(input.args)).listWithBaseline(),
    {
      surface: "remote",
      projectId,
      scopeId: scope?.id,
      classification,
      requiredActions: REPORT_ONLY_AUTOPILOT_ACTIONS,
      at: startedAt,
    },
  );
  if (!authority.allowed || !authority.grant) return undefined;

  const requestAdmission = input.request.admission;
  if (requestAdmission?.decision && requestAdmission.decision !== "accept") {
    const admissionReason = requestAdmission.reason.replace(/^recovery blockers=(\d+)$/, "복구 확인 필요 ($1건)");
    const failure = `request admission ${requestAdmission.decision}: ${admissionReason}`;
    const evidence = await appendAutopilotEvidence({
      args: input.args,
      request: input.request,
      authorityGrant: authority.grant,
      projectId,
      scopeId: scope?.id,
      resultMode: "report",
      startedAt,
      transitions,
      endpoint: "local_only_blocker",
      status: "blocked",
      failure,
      summary: "Report-only autopilot stopped because request admission did not accept.",
    });
    return autopilotResultReport({
      request: input.request,
      authorityGrant: authority.grant,
      evidence,
      status: "blocked",
      endpoint: "local_only_blocker",
      summary: "Report-only autopilot stopped at local queue admission.",
      planReport: remoteReportOnlyAutopilotAdmissionBlockedReport({
        decision: requestAdmission.decision,
        pressureClass: requestAdmission.pressureClass,
        reason: admissionReason,
      }),
      failure,
    });
  }

  const planned = await createOrchestratorPlanForRequest({
    args: input.args,
    request: input.request,
    receivedAt: input.receivedAt,
    requestedProjectId: projectId,
    requestedScopeId: scope?.id,
    ensureDecision: false,
  });
  transitions.push("run_readonly_plan");
  if (planned.report) {
    const evidence = await appendAutopilotEvidence({
      args: input.args,
      request: input.request,
      authorityGrant: authority.grant,
      projectId,
      scopeId: scope?.id,
      resultMode: "report",
      startedAt,
      transitions,
      endpoint: "local_only_blocker",
      status: "blocked",
      failure: "queue admission blocked planning",
      summary: "Autopilot stopped before planning because admission did not accept the request.",
    });
    return autopilotResultReport({
      request: input.request,
      authorityGrant: authority.grant,
      evidence,
      status: "blocked",
      endpoint: "local_only_blocker",
      summary: "Autopilot stopped before planning.",
      planReport: planned.report,
      failure: "queue admission blocked planning",
    });
  }
  if (!planned.plan || !planned.request) return undefined;

  const planReport = orchestratorPlanReport({ request: planned.request, plan: planned.plan, blocker: planned.blocker });
  if (planned.plan.status === "failed" || planned.blocker || planned.plan.status === "questions") {
    if (!planned.blocker) {
      await ensureDecisionForOrchestratorPlan({
        args: input.args,
        plan: planned.plan,
        request: planned.request,
        createdAt: planned.plan.completedAt ?? input.receivedAt,
      });
    }
    const endpoint = planned.plan.status === "questions" ? "bk_judgment" : "local_only_blocker";
    const evidence = await appendAutopilotEvidence({
      args: input.args,
      request: planned.request,
      plan: planned.plan,
      authorityGrant: authority.grant,
      projectId,
      scopeId: scope?.id,
      resultMode: "report",
      startedAt,
      transitions,
      endpoint,
      status: planned.plan.status === "failed" ? "failed" : "blocked",
      failure: planned.plan.failure ?? planned.blocker?.violations.join("; "),
      summary: "Autopilot stopped after planning.",
    });
    return autopilotResultReport({
      request: planned.request,
      authorityGrant: authority.grant,
      evidence,
      status: evidence.status,
      endpoint,
      summary: "Autopilot stopped after planning.",
      planReport,
      failure: evidence.failure,
    });
  }

  const materialized = await previewOrchestratorPlanMaterialization({
    args: input.args,
    plan: planned.plan,
    createdAt: input.receivedAt,
    commandId: `autopilot-${planned.plan.id}`,
  });
  if (!materialized.ok) {
    const evidence = await appendAutopilotEvidence({
      args: input.args,
      request: planned.request,
      plan: planned.plan,
      authorityGrant: authority.grant,
      projectId,
      scopeId: scope?.id,
      resultMode: "report",
      startedAt,
      transitions,
      endpoint: "local_only_blocker",
      status: "blocked",
      failure: materialized.violations.join("; "),
      summary: "Autopilot stopped because report-only materialization failed.",
    });
    return autopilotResultReport({
      request: planned.request,
      authorityGrant: authority.grant,
      evidence,
      status: "blocked",
      endpoint: "local_only_blocker",
      summary: "Autopilot stopped before report execution.",
      planReport: orchestratorGoBlockedReport({
        plan: planned.plan,
        violations: materialized.violations,
        blocker: createOrchestratorPlanBlocker({ plan: planned.plan, violations: materialized.violations }),
      }),
      failure: evidence.failure,
    });
  }

  const agents = await loadAgentProfilesById(input.args, materialized.tasks.map((task) => task.targetAgent));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const unsafeTask = materialized.tasks.find((task) => task.resultMode !== "report" || agentsById.get(task.targetAgent)?.writerClass !== "non-writer");
  if (unsafeTask) {
    await ensureDecisionForOrchestratorPlan({
      args: input.args,
      plan: planned.plan,
      request: planned.request,
      createdAt: planned.plan.completedAt ?? input.receivedAt,
    });
    const evidence = await appendAutopilotEvidence({
      args: input.args,
      request: planned.request,
      plan: planned.plan,
      authorityGrant: authority.grant,
      projectId,
      scopeId: scope?.id,
      resultMode: "report",
      startedAt,
      transitions,
      endpoint: "bk_judgment",
      status: "blocked",
      failure: `plan proposed non-report or writer task: ${unsafeTask.id}`,
      summary: "Autopilot stopped for BK approval because the plan exceeded report-only authority.",
    });
    return autopilotResultReport({
      request: planned.request,
      authorityGrant: authority.grant,
      evidence,
      status: "blocked",
      endpoint: "bk_judgment",
      summary: "Plan needs BK approval before execution.",
      planReport,
      failure: evidence.failure,
    });
  }

  const actionAdmission = await queueAdmissionFor({
    args: input.args,
    subjectKind: "action",
    projectId,
    budgetContext: { ...budgetContextFromAncestry(planned.plan.ancestry), projectId },
  });
  if (actionAdmission.decision !== "accept") {
    const evidence = await appendAutopilotEvidence({
      args: input.args,
      request: planned.request,
      plan: planned.plan,
      authorityGrant: authority.grant,
      projectId,
      scopeId: scope?.id,
      resultMode: "report",
      startedAt,
      transitions,
      endpoint: "local_only_blocker",
      status: "blocked",
      failure: `action admission ${actionAdmission.decision}: ${actionAdmission.reason}`,
      summary: "Autopilot stopped before report execution because action admission did not accept.",
    });
    return autopilotResultReport({
      request: planned.request,
      authorityGrant: authority.grant,
      evidence,
      status: "blocked",
      endpoint: "local_only_blocker",
      summary: "Autopilot stopped before report execution.",
      planReport: formatQueueAdmissionDecision(actionAdmission),
      failure: evidence.failure,
    });
  }

  const taskStore = new TaskStore(tasksPath(input.args));
  const actionStore = new RemoteActionStore(remoteActionsPath(input.args));
  for (const task of materialized.tasks) await taskStore.append(task);
  const materializedActions: RemoteActionRecord[] = [];
  for (const action of materialized.actions) {
    const admittedAction = {
      ...action,
      admission: queueAdmissionRecord({ decidedAt: input.receivedAt, result: actionAdmission }),
    };
    await actionStore.append(admittedAction);
    materializedActions.push(
      admittedAction.status === "pending" ? await actionStore.markApproved(admittedAction.id, input.receivedAt) : admittedAction,
    );
  }
  transitions.push("materialize_report_task");
  const materializedPlan = await new OrchestratorPlanStore(orchestratorPlansPath(input.args)).markMaterialized(planned.plan.id, {
    approvedAt: input.receivedAt,
    materializedAt: new Date().toISOString(),
    taskIds: materialized.tasks.map((task) => task.id),
    actionIds: materializedActions.map((action) => action.id),
  });

  const finalActions = await runAutopilotReportActions(input.args, materializedActions.map((action) => action.id));
  transitions.push("dispatch_report_task");
  const latestPlan = await new OrchestratorPlanStore(orchestratorPlansPath(input.args)).find(materializedPlan.id);
  const resultReport = latestPlan ? await buildAndRecordOrchestratorPlanResultReport(input.args, latestPlan) : undefined;
  const runIds = finalActions.map((action) => action.result?.runId).filter((runId): runId is string => Boolean(runId));
  const failedAction = finalActions.find((action) => action.status === "failed" || action.result?.pass === false);
  const evidence = await appendAutopilotEvidence({
    args: input.args,
    request: planned.request,
    plan: latestPlan ?? materializedPlan,
    authorityGrant: authority.grant,
    projectId,
    scopeId: scope?.id,
    resultMode: "report",
    startedAt,
    transitions,
    endpoint: failedAction ? "local_only_blocker" : "result",
    status: failedAction ? "failed" : "completed",
    actionIds: finalActions.map((action) => action.id),
    runIds,
    failure: failedAction?.result?.failure,
    summary: failedAction ? "Report-only autopilot ran and failed." : "Report-only autopilot completed from one remote input.",
  });

  return autopilotResultReport({
    request: planned.request,
    authorityGrant: authority.grant,
    evidence,
    status: evidence.status,
    endpoint: evidence.endpoint,
    summary: evidence.summary,
    resultReport: resultReport ?? planReport,
    failure: evidence.failure,
  });
}

async function prepareDispatchActionForTask(input: {
  args: ParsedArgs;
  taskId: string;
  commandId?: string;
  receivedAt?: string;
}): Promise<{ action?: RemoteActionRecord; report?: string }> {
  const task = await new TaskStore(tasksPath(input.args)).find(input.taskId);
  if (!task) throw new Error(`task not found: ${input.taskId}`);
  if (task.status !== "pending") throw new Error(`task must be pending to dispatch: ${task.status}`);
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const admission = await queueAdmissionFor({
    args: input.args,
    subjectKind: "action",
    projectId: selectedProjectIdFromAncestry(task.ancestry) ?? task.projectId,
    budgetContext: budgetContextForTask(task),
  });
  if (admission.decision !== "accept") return { report: formatQueueAdmissionDecision(admission) };
  const agent = await loadAgentProfile(input.args, task.targetAgent);
  const plan = validateDispatch(task, agent, undefined, await governanceDecisions(input.args));
  if (!plan.mayDispatch) {
    throw new Error(`dispatch blocked:\n${plan.violations.join("\n")}`);
  }

  const action = createRemoteDispatchAction({
    task,
    repoRoot: task.repoRoot ? resolve(task.repoRoot) : remoteDispatchRepoRoot(input.args),
    createdAt: receivedAt,
    source: "remote",
    commandId: input.commandId,
    allocate: agent.worktreePolicy === "per-task",
    admission: queueAdmissionRecord({ decidedAt: receivedAt, result: admission }),
  });
  await new RemoteActionStore(remoteActionsPath(input.args)).append(action);
  return { action };
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

async function createOrchestratorPlanForRequest(input: {
  args: ParsedArgs;
  request: OrchestrationRequestRecord;
  receivedAt: string;
  requestedProjectId?: string;
  requestedScopeId?: string;
  ensureDecision: boolean;
}): Promise<{
  plan?: OrchestratorPlanRecord;
  request?: OrchestrationRequestRecord;
  blocker?: OrchestratorPlanBlocker;
  report?: string;
}> {
  const requestAdmission = await queueAdmissionFor({
    args: input.args,
    subjectKind: input.request.recoveryOfPlanId ? "recovery_request" : "request",
    projectId: input.requestedProjectId ?? selectedProjectIdFromAncestry(input.request.ancestry),
    budgetContext: {
      ...budgetContextFromAncestry(input.request.ancestry),
      projectId: input.requestedProjectId ?? selectedProjectIdFromAncestry(input.request.ancestry),
    },
    excludeRequestId: input.request.id,
  });
  if (requestAdmission.decision !== "accept") return { report: formatQueueAdmissionDecision(requestAdmission) };

  const projectProfiles = await loadProjectProfiles(projectProfilesDir(input.args));
  const planAncestry = ancestryForPlan({
    request: input.request,
    projectProfiles,
    requestedProjectId: input.requestedProjectId,
  });
  const planRequest: OrchestrationRequestRecord = {
    ...input.request,
    ancestry: planAncestry,
  };
  const planningMemory = await planningMemoryForRequest({
    args: input.args,
    request: planRequest,
    projectProfiles,
    generatedAt: input.receivedAt,
  });
  const result = await runOrchestratorPlan({
    request: planRequest,
    agent: await loadAgentProfile(input.args, "codex-orchestrator"),
    repoRoot: orchestratorRepoRoot(input.args),
    projectProfiles,
    requestedProjectId: input.requestedProjectId,
    requestedScopeId: input.requestedScopeId,
    planningMemory,
    codexBin: codexBin(input.args),
  });
  const plan: OrchestratorPlanRecord = {
    schemaVersion: 1,
    id: buildOrchestratorPlanId({ requestId: input.request.id, createdAt: input.receivedAt }),
    ancestry: planAncestry,
    routineTriggerId: input.request.routineTriggerId,
    routineFingerprint: input.request.routineFingerprint,
    requestId: input.request.id,
    status: result.status,
    createdAt: input.receivedAt,
    completedAt: new Date().toISOString(),
    command: result.command,
    rawOutput: result.rawOutput,
    payload: result.payload,
    classification: result.classification,
    failure: result.failure,
  };
  await new OrchestratorPlanStore(orchestratorPlansPath(input.args)).append(plan);
  const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(input.args));
  const reportedRequest =
    plan.status === "failed" ? input.request : await requestStore.markPlanned(input.request.id, plan.completedAt ?? input.receivedAt, { ancestry: planAncestry });
  const blocker = await blockerForOrchestratorPlan({
    args: input.args,
    plan,
    createdAt: plan.completedAt ?? input.receivedAt,
    commandId: `plan-preflight-${plan.id}`,
  });
  if (input.ensureDecision && !blocker) {
    await ensureDecisionForOrchestratorPlan({
      args: input.args,
      plan,
      request: reportedRequest,
      createdAt: plan.completedAt ?? input.receivedAt,
    });
  }
  return { plan, request: reportedRequest, blocker };
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
  const [runs, tasks, actions, proposals, drafts, orchestrationRequests, orchestratorPlans, decisions, ops, lifecycles, reports, governanceEvents, budgetObservations, budgetPolicies] = await Promise.all([
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
    new BudgetPolicyStore(budgetPoliciesPath(args)).list(),
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
    budgetPolicies,
  });
}

async function loadCeoStatusSnapshot(args: ParsedArgs): Promise<CeoStatusSnapshot> {
  const [runs, tasks, taskDrafts, decisions, actions, orchestrationRequests, orchestratorPlans, ops, lifecycles, reports, governanceEvents, budgetObservations, budgetPolicies] = await Promise.all([
    new RunIndex(runsPath(args)).list(),
    new TaskStore(tasksPath(args)).list(),
    new TaskDraftStore(taskDraftsPath(args)).list(),
    new DecisionStore(decisionsPath(args)).list(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    collectOps(args),
    new RunLifecycleStore(runLifecyclePath(args)).list(),
    new CeoReportStore(ceoReportsPath(args)).list(),
    new GovernanceEventStore(governanceEventsPath(args)).list(),
    new CostBudgetAuditStore(costBudgetAuditPath(args)).list(),
    new BudgetPolicyStore(budgetPoliciesPath(args)).list(),
  ]);
  const projectId = flag(args, "project", "") || undefined;

  return buildCeoStatusSnapshot({
    projectId,
    runs,
    tasks,
    taskDrafts,
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
    budgetPolicies,
  });
}

async function queueAdmissionFor(input: {
  args: ParsedArgs;
  subjectKind: QueueAdmissionDecisionResult["subjectKind"];
  projectId?: string;
  budgetContext?: BudgetEvaluationContext;
  excludeActionId?: string;
  excludeActionIds?: string[];
  excludeRequestId?: string;
  excludePlanId?: string;
}): Promise<QueueAdmissionDecisionResult> {
  const [
    requests,
    plans,
    decisions,
    taskDrafts,
    tasks,
    actions,
    runs,
    lifecycles,
    budgetObservations,
    budgetPolicies,
    governanceEvents,
    ops,
  ] = await Promise.all([
    new OrchestrationRequestStore(orchestrationRequestsPath(input.args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(input.args)).list(),
    new DecisionStore(decisionsPath(input.args)).list(),
    new TaskDraftStore(taskDraftsPath(input.args)).list(),
    new TaskStore(tasksPath(input.args)).list(),
    new RemoteActionStore(remoteActionsPath(input.args)).list(),
    new RunIndex(runsPath(input.args)).list(),
    new RunLifecycleStore(runLifecyclePath(input.args)).list(),
    new CostBudgetAuditStore(costBudgetAuditPath(input.args)).list(),
    new BudgetPolicyStore(budgetPoliciesPath(input.args)).list(),
    new GovernanceEventStore(governanceEventsPath(input.args)).list(),
    collectOps(input.args),
  ]);
  const excludedActionIds = new Set([
    ...(input.excludeActionId ? [input.excludeActionId] : []),
    ...(input.excludeActionIds ?? []),
  ]);
  const pressurePlans = input.excludePlanId ? plans.filter((plan) => plan.id !== input.excludePlanId) : plans;
  const pressure = buildQueuePressureSnapshot({
    requests: input.excludeRequestId ? requests.filter((request) => request.id !== input.excludeRequestId) : requests,
    plans: pressurePlans,
    decisions,
    taskDrafts,
    tasks,
    actions: excludedActionIds.size > 0 ? actions.filter((action) => !excludedActionIds.has(action.id)) : actions,
    runs,
    lifecycles,
    budgetObservations,
    budgetPolicies,
    governanceEvents,
    orchestratorPlanBlockers: await orchestratorPlanBlockersForReport(input.args, pressurePlans),
    ops: withoutActiveInboxCommand(ops),
  }, { projectId: input.projectId, budgetContext: input.budgetContext });
  const admission = decideQueueAdmission({ pressure, subjectKind: input.subjectKind });
  if (
    admission.decision !== "accept" &&
    pressure.budget &&
    (pressure.budget.state === "defer" || pressure.budget.state === "block" || pressure.budget.state === "needs_bk")
  ) {
    const policy = findBudgetPolicyForGate({
      policies: budgetPolicies,
      decision: pressure.budget,
      context: { projectId: input.projectId, ...input.budgetContext },
      observations: budgetObservations,
    });
    if (policy) {
      await new GovernanceEventStore(governanceEventsPath(input.args)).create({
        timestamp: new Date().toISOString(),
        actor: "samantha",
        source: { kind: "budget_policy", id: policy.id },
        subject: { type: "budget", id: policy.id },
        kind: "transition_blocked",
        riskClass: "low",
        summary: `Budget gate ${pressure.budget.state} for ${input.subjectKind}: ${admission.reason}`,
        dedupeKey: `budget-gate:${input.subjectKind}:${input.projectId ?? "global"}:${pressure.budget.state}:${policy.id}`,
      });
    }
  }
  return admission;
}

async function queuePressureForReport(args: ParsedArgs, ops: Awaited<ReturnType<typeof collectOps>>, projectId?: string) {
  const [requests, plans, decisions, taskDrafts, tasks, actions, runs, lifecycles, budgetObservations, budgetPolicies, governanceEvents] = await Promise.all([
    new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    new DecisionStore(decisionsPath(args)).list(),
    new TaskDraftStore(taskDraftsPath(args)).list(),
    new TaskStore(tasksPath(args)).list(),
    new RemoteActionStore(remoteActionsPath(args)).list(),
    new RunIndex(runsPath(args)).list(),
    new RunLifecycleStore(runLifecyclePath(args)).list(),
    new CostBudgetAuditStore(costBudgetAuditPath(args)).list(),
    new BudgetPolicyStore(budgetPoliciesPath(args)).list(),
    new GovernanceEventStore(governanceEventsPath(args)).list(),
  ]);
  return buildQueuePressureSnapshot({
    requests,
    plans,
    decisions,
    taskDrafts,
    tasks,
    actions,
    runs,
    lifecycles,
    budgetObservations,
    budgetPolicies,
    governanceEvents,
    orchestratorPlanBlockers: await orchestratorPlanBlockersForReport(args, plans),
    ops,
  }, { projectId });
}

function csvFlag(value: string): string[] | undefined {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

async function selectRoutineTriggerForObserve(input: {
  args: ParsedArgs;
  routineId?: string;
  triggerId?: string;
  projectId?: string;
}): Promise<RoutineTriggerRecord> {
  const routineId = input.routineId ?? "";
  const triggerId = input.triggerId ?? "";
  const projectId = input.projectId;
  const store = new RoutineTriggerStore(routineTriggersPath(input.args));

  if (routineId) {
    const routine = await store.find(routineId);
    if (!routine) throw new Error(`routine trigger not found: ${routineId}`);
    if (projectId && routine.projectId !== projectId) {
      throw new Error(`routine trigger project mismatch: ${routine.projectId} != ${projectId}`);
    }
    return routine;
  }

  if (!triggerId) throw new Error("usage: routine:observe <routine-id> --text=<request> or --trigger-id=<id> [--project=<id>] --text=<request>");
  const matches = (await store.list()).filter((routine) =>
    routine.triggerId === triggerId && (!projectId || routine.projectId === projectId)
  );
  if (matches.length === 0) throw new Error(`routine trigger not found: ${triggerId}`);
  if (matches.length > 1) throw new Error(`routine trigger is ambiguous: ${triggerId}`);
  return matches[0];
}

async function routineActiveWork(args: ParsedArgs) {
  return {
    requests: await new OrchestrationRequestStore(orchestrationRequestsPath(args)).list(),
    plans: await new OrchestratorPlanStore(orchestratorPlansPath(args)).list(),
    tasks: await new TaskStore(tasksPath(args)).list(),
    actions: await new RemoteActionStore(remoteActionsPath(args)).list(),
    decisions: await new DecisionStore(decisionsPath(args)).list(),
  };
}

async function observeRoutineTrigger(input: {
  args: ParsedArgs;
  routineId?: string;
  triggerId?: string;
  projectId?: string;
  text: string;
  observedAt: string;
  sourceEvidence?: string[];
  requestId?: string;
  source?: OrchestrationRequestRecord["source"];
  senderId?: string;
}): Promise<{ observation: Awaited<ReturnType<RoutineTriggerObservationStore["observe"]>>; request?: OrchestrationRequestRecord }> {
  const trigger = await selectRoutineTriggerForObserve(input);
  const activationDecision = trigger.activationDecisionId
    ? await new DecisionStore(decisionsPath(input.args)).find(trigger.activationDecisionId)
    : undefined;
  const activation = routineActivationPolicy({
    routine: trigger,
    approvalEvidence: activationDecision ? [activationDecision] : [],
  });
  if (!activation.mayProceed) {
    throw new Error(`routine activation is not approved: ${activation.blockedReason ?? "unknown reason"}`);
  }
  const admission = await queueAdmissionFor({
    args: input.args,
    subjectKind: "routine_trigger",
    projectId: trigger.projectId,
    budgetContext: { projectId: trigger.projectId },
  });
  const observation = await new RoutineTriggerObservationStore(routineTriggerObservationsPath(input.args)).observe({
    trigger,
    observedAt: input.observedAt,
    sourceEvidence: input.sourceEvidence,
    activeWork: await routineActiveWork(input.args),
    admission: queueAdmissionRecord({ decidedAt: input.observedAt, result: admission }),
  });
  const request = routineObservationToOrchestrationRequest({
    trigger,
    observation,
    requestText: input.text,
    createdAt: input.observedAt,
    requestId: input.requestId,
    source: input.source,
    senderId: input.senderId,
  });
  if (request) await new OrchestrationRequestStore(orchestrationRequestsPath(input.args)).append(request);
  return { observation, request };
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

function budgetContextFromAncestry(ancestry: TaskSpec["ancestry"] | RemoteActionRecord["ancestry"] | OrchestrationRequestRecord["ancestry"] | OrchestratorPlanRecord["ancestry"]): BudgetEvaluationContext {
  if (ancestry?.mode !== "assigned") return {};
  return {
    projectId: ancestry.projectId,
    goalId: ancestry.goalId,
    workItemId: ancestry.workItemId,
  };
}

function budgetContextForTask(task: TaskSpec): BudgetEvaluationContext {
  return {
    ...budgetContextFromAncestry(task.ancestry),
    projectId: selectedProjectIdFromAncestry(task.ancestry) ?? task.projectId,
  };
}

function budgetContextForAction(action: RemoteActionRecord): BudgetEvaluationContext {
  return {
    ...budgetContextFromAncestry(action.ancestry),
    actionId: action.id,
  };
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

function projectScopedRemoteCommand(command: string, projectId: string): string {
  if (command === "/plan") return `/plan ${projectId}`;
  if (command === "/answer") return `/answer project:${projectId} <답변>`;
  if (command === "/revise") return `/revise project:${projectId} <피드백>`;
  return `${command} project:${projectId}`;
}

function projectExamplesForRecords(
  records: Array<{ ancestry?: OrchestratorPlanRecord["ancestry"] }>,
  command: string,
): string[] {
  const seen = new Set<string>();
  const examples: string[] = [];
  for (const record of records) {
    const projectId = selectedProjectIdFromAncestry(record.ancestry);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    examples.push(projectScopedRemoteCommand(command, projectId));
  }
  return examples;
}

function projectIdForPlanDecision(decision: DecisionItem, plans: OrchestratorPlanRecord[]): string | undefined {
  const decisionProjectId = selectedProjectIdFromAncestry(decision.ancestry);
  if (decisionProjectId) return decisionProjectId;
  if (decision.subject?.type !== "orchestrator_plan") return undefined;
  const plan = plans.find((item) => item.id === decision.subject?.id);
  return selectedProjectIdFromAncestry(plan?.ancestry);
}

function projectExamplesForPlanDecisions(
  decisions: DecisionItem[],
  plans: OrchestratorPlanRecord[],
  command: string,
): string[] {
  const seen = new Set<string>();
  const examples: string[] = [];
  for (const decision of decisions) {
    const projectId = projectIdForPlanDecision(decision, plans);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    examples.push(projectScopedRemoteCommand(command, projectId));
  }
  return examples;
}

function requestCreatedAtMs(request: OrchestrationRequestRecord): number {
  return Date.parse(request.createdAt) || 0;
}

function isRecoveryPendingRequest(request: OrchestrationRequestRecord): boolean {
  return Boolean(request.recoveryOfPlanId);
}

function latestRequest(requests: OrchestrationRequestRecord[]): OrchestrationRequestRecord | undefined {
  return requests
    .slice()
    .sort((a, b) => requestCreatedAtMs(b) - requestCreatedAtMs(a))
    .at(0);
}

function pendingProjectRequestMatches(request: OrchestrationRequestRecord, projectId: string): boolean {
  return selectedProjectIdFromAncestry(request.ancestry) === projectId;
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
        example: input.requestedProjectId ? input.example : undefined,
        examples: input.requestedProjectId ? undefined : projectExamplesForRecords(candidates, input.command),
      }),
    };
  }
  return { plan: candidates[0] };
}

async function selectPendingRequestForPlan(input: {
  args: ParsedArgs;
  requestedProjectId?: string;
  requestedScopeId?: string;
}): Promise<{ request?: OrchestrationRequestRecord; report?: string; staleDuplicateCount?: number }> {
  await validateRemoteProjectContext(input);
  const [requests, projectProfiles] = await Promise.all([
    new OrchestrationRequestStore(orchestrationRequestsPath(input.args)).list(),
    loadProjectProfiles(projectProfilesDir(input.args)),
  ]);
  const pending = requests
    .filter((request) => request.status === "pending_plan")
    .filter((request) => {
      if (!input.requestedProjectId) return !isRecoveryPendingRequest(request);
      return !isRecoveryPendingRequest(request) && pendingProjectRequestMatches(request, input.requestedProjectId);
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
          examples: projectProfiles.map((project) => projectScopedRemoteCommand("/plan", project.id)),
        }),
      };
    }
    return { request };
  }

  if (input.requestedProjectId && pending.length > 1) {
    return { request: latestRequest(pending), staleDuplicateCount: pending.length - 1 };
  }

  if (pending.length > 1) {
    return {
      report: remoteProjectAmbiguityReport({
        command: "/plan",
        reason: "두 개 이상의 현재 작업 요청이 계획 대상이 될 수 있습니다. 프로젝트별 명령으로 최신 요청을 계획하거나 오래된 중복을 정리하세요.",
        example: input.requestedProjectId ? undefined : "/plan <project>",
        examples: input.requestedProjectId ? undefined : projectExamplesForRecords(pending, "/plan"),
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
    decision.kind !== "routine_change" &&
    decision.kind !== "memory_change" &&
    decision.kind !== "budget_change"
  ) return;
  if (!decision.subject) throw new Error(`${decision.kind} decisions require a subject`);
  if (!decision.risk) throw new Error(`${decision.kind} decisions require a risk class`);
  const subjectType =
    decision.subject.type === "agent_profile" ||
      decision.subject.type === "capability" ||
      decision.subject.type === "routine" ||
      decision.subject.type === "policy" ||
      decision.subject.type === "memory" ||
      decision.subject.type === "budget"
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
        example: requestedProjectId ? (resolution === "approved" ? "/approve project:<project>" : "/cancel project:<project>") : undefined,
        examples: requestedProjectId
          ? undefined
          : projectExamplesForPlanDecisions(candidates, plans, resolution === "approved" ? "/approve" : "/cancel"),
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
        example: requestedProjectId ? "/answer project:<project> <답변>" : undefined,
        examples: requestedProjectId ? undefined : projectExamplesForPlanDecisions(candidates, plans, "/answer"),
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

interface CeoTurnContext {
  projectProfiles: ProjectProfile[];
  inferredProjectId?: string;
  projectAmbiguity?: CeoTurnProjectAmbiguity;
  snapshot: CeoStatusSnapshot;
  requests: OrchestrationRequestRecord[];
  plans: OrchestratorPlanRecord[];
  decisions: DecisionItem[];
  actions: RemoteActionRecord[];
  tasks: TaskSpec[];
  runs: RunSummary[];
  reports: CeoReportRecord[];
  conversationMemory: CeoConversationMemoryReadResult;
  relevantRecords: ContextSearchResult[];
}

interface CeoTurnProcessResult {
  response: string;
  detectedIntent: CeoTurnDetectedIntent;
  responseBoundary: CeoTurnResponseBoundary;
  linkedStateIds: CeoTurnLinkedStateIds;
}

interface CeoTurnProjectAmbiguity {
  reason: string;
  projectIds: string[];
}

function naturalTurnSource(value: unknown): CeoTurnSource {
  return value === "local" || value === "system" ? value : "remote";
}

function naturalTurnActor(value: unknown): CeoTurnActor {
  return value === "operator" || value === "system" ? value : "bk";
}

function ceoTurnProjectAmbiguityFromError(err: unknown): CeoTurnProjectAmbiguity | undefined {
  const reason = errorMessage(err);
  const match = /^ambiguous project profile match: (.+); specify project id$/.exec(reason);
  if (!match) return undefined;
  return {
    reason,
    projectIds: match[1].split(",").map((item) => item.trim()).filter(Boolean),
  };
}

async function loadCeoTurnContext(input: {
  args: ParsedArgs;
  text: string;
  generatedAt: string;
  requestedProjectId?: string;
}): Promise<CeoTurnContext> {
  const [
    runs,
    tasks,
    taskDrafts,
    decisions,
    actions,
    requests,
    plans,
    ops,
    lifecycles,
    reports,
    governanceEvents,
    budgetObservations,
    budgetPolicies,
    projectProfiles,
    activeMemory,
    conversationMemory,
  ] = await Promise.all([
    new RunIndex(runsPath(input.args)).list(),
    new TaskStore(tasksPath(input.args)).list(),
    new TaskDraftStore(taskDraftsPath(input.args)).list(),
    new DecisionStore(decisionsPath(input.args)).list(),
    new RemoteActionStore(remoteActionsPath(input.args)).list(),
    new OrchestrationRequestStore(orchestrationRequestsPath(input.args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(input.args)).list(),
    collectOps(input.args),
    new RunLifecycleStore(runLifecyclePath(input.args)).list(),
    new CeoReportStore(ceoReportsPath(input.args)).list(),
    new GovernanceEventStore(governanceEventsPath(input.args)).list(),
    new CostBudgetAuditStore(costBudgetAuditPath(input.args)).list(),
    new BudgetPolicyStore(budgetPoliciesPath(input.args)).list(),
    loadProjectProfiles(projectProfilesDir(input.args)),
    new GovernedMemoryStore(memoryPath(input.args), new GovernanceEventStore(governanceEventsPath(input.args))).listActive(),
    readCeoConversationMemory(conversationMemoryPath(input.args)),
  ]);
  let inferredProject: ProjectProfile | undefined;
  let projectAmbiguity: CeoTurnProjectAmbiguity | undefined;
  if (!input.requestedProjectId) {
    try {
      inferredProject = inferProjectProfile(projectProfiles, { requestText: input.text });
    } catch (err) {
      projectAmbiguity = ceoTurnProjectAmbiguityFromError(err);
      if (!projectAmbiguity) throw err;
    }
  }
  const projectId = input.requestedProjectId ?? inferredProject?.id;
  const blockers = await orchestratorPlanBlockersForReport(input.args, plans);
  const snapshot = buildCeoStatusSnapshot({
    projectId,
    generatedAt: input.generatedAt,
    runs,
    tasks,
    taskDrafts,
    decisions,
    actions,
    orchestrationRequests: requests,
    orchestratorPlans: plans,
    orchestratorPlanBlockers: blockers,
    ops,
    lifecycles,
    reports,
    governanceEvents,
    budgetObservations,
    budgetPolicies,
  });
  const projectBriefRead = projectId
    ? await new ProjectBriefStore(projectBriefsPath(input.args), { profiles: projectProfiles }).readProjectBrief(projectId)
    : undefined;
  const decisionSummary = buildDecisionHistorySummary({
    decisions,
    governanceEvents,
    reports,
    plans,
    generatedAt: input.generatedAt,
    scope: projectId ? { projectId } : undefined,
  });
  const relevantRecords = searchContext({
    ceoReports: reports,
    decisionSummaries: [decisionSummary],
    projectBriefReads: projectBriefRead ? [projectBriefRead] : [],
    memoryRecords: activeMemory,
    conversationMemory: [conversationMemory],
    governanceEvents,
  }, { text: input.text, projectId, limit: 8 }).results;

  return {
    projectProfiles,
    inferredProjectId: projectId,
    projectAmbiguity,
    snapshot,
    requests,
    plans,
    decisions,
    actions,
    tasks,
    runs,
    reports,
    conversationMemory,
    relevantRecords,
  };
}

function normalizeTurnText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function isCeoStatusRequest(text: string): boolean {
  const normalized = normalizeTurnText(text);
  if (!normalized) return false;
  const hasStatusSignal =
    /(상태|현황|진행 상황|어디까지|막힌|막혔|막힘|블로커|문제|위험|지금 뭐|현재 뭐|what.*status|status|blocked|progress|summary)/i
      .test(normalized);
  if (!hasStatusSignal) return false;

  const asksForNewWork =
    /(구현|수정|고쳐|바꿔|추가|생성|작성|계획 보고|계획서|review|spec|evaluate|implementation|recover|recovery|복구)/i
      .test(normalized);
  if (/막힌|막혔|막힘|상태|현황|progress|status|blocked/i.test(normalized)) return true;
  return !asksForNewWork;
}

function isNaturalApprovalAttempt(text: string): boolean {
  const normalized = normalizeTurnText(text);
  if (!normalized) return false;
  if (/[?？]/.test(normalized)) return false;
  if (/(승인하지|진행하지|실행하지|하지 마|하지마|보류|취소|거절|수정|don't|do not|not approve|not approved|hold|wait|cancel|reject|revise)/i.test(normalized)) {
    return false;
  }
  return (
    /(^|\s)(승인|승인해|승인합니다|승인할게|승인하자|승인해줘|승인 완료)(\s|[.!。]|$)/.test(normalized) ||
    /(계획|plan).{0,16}승인/.test(normalized) ||
    /승인.{0,16}(계획|plan)/.test(normalized) ||
    /(진행|실행)(해|하자|해줘|하세요|시켜)(\s|[.!。]|$)/.test(normalized) ||
    /\b(i approve|approve it|approve the plan|approved|approval granted|go ahead|proceed|proceed with it|greenlight|green light)\b/i.test(normalized) ||
    /^go[.!。]?$/.test(normalized)
  );
}

function isNonApprovalDecisionFeedback(text: string): boolean {
  const normalized = normalizeTurnText(text);
  if (!normalized || isNaturalApprovalAttempt(text)) return false;
  return /^(좋아|좋네|좋아 보|괜찮|오케이|ㅇㅋ|ok|okay|yes|응|그래|sounds good|looks good|nice|good)(\s|[.!。]|$)/i.test(normalized);
}

function isMemoryOnlyCeoTurn(text: string): boolean {
  const normalized = normalizeTurnText(text);
  if (!normalized) return false;
  const hasMemorySignal =
    /\b(decision|decided|product direction|roadmap|north star|target product|primary surface|command bot|natural ceo|ceo conversation|rejected path|reject|rejected|avoid|abandon)\b|결정|정했다|하기로|제품 방향|로드맵|북극성|자연어 CEO|CEO 대화|명령봇|거절|폐기|버린다|피하/i
      .test(normalized);
  if (!hasMemorySignal) return false;
  const asksForWork =
    /(구현|수정|고쳐|바꿔|추가|생성|작성|작업|계획 보고|작업 계획|보고해|검토해|분석해|평가해|승인|진행해|실행|복구|\b(?:implement|fix|build|add|change|write|review|evaluate|plan|report|approve|proceed|recover|recovery)\b)/i
      .test(normalized);
  return !asksForWork;
}

function statusBoundaryKind(snapshot: CeoStatusSnapshot): CeoTurnResponseBoundary["kind"] {
  const latestDecision = snapshot.needsDecision[0];
  if (latestDecision?.decisionKind === "orchestrator_plan_approval") return "approval_boundary";
  if (latestDecision) return "blocker";
  if (snapshot.overall === "blocked" || snapshot.overall === "failed" || snapshot.overall === "needs_recovery") return "blocker";
  if (snapshot.active.length > 0 || snapshot.nextAction.kind !== "none") return "next_safe_action";
  return "result";
}

function lineItem(input: { title: string; status: string; detail?: string; id?: string }): string {
  const detail = input.detail ? ` - ${compactLine(input.detail)}` : "";
  const audit = input.id ? ` [${input.id}]` : "";
  return `- ${compactLine(input.title)} (${input.status})${detail}${audit}`;
}

function formatLimitedSection<T>(
  title: string,
  items: T[],
  format: (item: T) => string,
  limit = 3,
): string[] {
  if (items.length === 0) return [];
  const clipped = items.slice(0, limit).map(format);
  return [
    `${title}:`,
    ...clipped,
    items.length > limit ? `- 외 ${items.length - limit}건` : "",
    "",
  ].filter(Boolean);
}

function naturalNextSafeAction(snapshot: CeoStatusSnapshot): string {
  const action = snapshot.nextAction;
  if (action.kind === "none") return "지금 BK가 새로 결정할 일은 없습니다.";
  if (action.kind === "plan") return "대기 중인 요청은 계획 생성이 다음 안전 단계입니다.";
  if (action.kind === "review_plan") return "현재 계획은 검토, 수정, 또는 취소 같은 BK 판단 경계에 있습니다.";
  if (action.kind === "answer_questions") return "계획 질문에 대한 BK 답변이 필요합니다.";
  if (action.kind === "resolve_decision") return "pending 결정 항목을 BK가 명시적으로 판단해야 합니다.";
  if (action.kind === "approve_action") return "worker action 승인은 deterministic approval gate 뒤에 멈춰 있습니다.";
  if (action.kind === "watch_action") return "이미 준비되었거나 실행 중인 action은 Samantha 런타임이 계속 추적해야 합니다.";
  if (action.kind === "recover") return "복구가 필요하지만 이 턴에서는 복구 실행을 시작하지 않았습니다.";
  if (action.kind === "diagnose") return "운영 진단이 다음 안전 행동입니다.";
  return action.reason;
}

function formatNaturalStatusResponse(input: {
  snapshot: CeoStatusSnapshot;
  relevantRecords: ContextSearchResult[];
  nonApprovalFeedback?: boolean;
}): string {
  const view = buildOperatingSurfaceView(input.snapshot);
  const boundary = statusBoundaryKind(input.snapshot);
  const headline = input.nonApprovalFeedback
    ? "피드백은 확인했지만 명시 승인 문구가 아니어서 decision을 resolve하지 않았습니다."
    : boundary === "result"
      ? "정리하면, 지금 BK가 직접 붙잡고 있어야 할 현재 작업은 없습니다."
      : "정리하면, Samantha는 현재 상태를 확인했고 다음 경계가 분명합니다.";
  const lines = [
    headline,
    "",
    `현재 경계: ${boundary}`,
    `상태: ${input.snapshot.overall}`,
    `요약: ${view.summary}`,
    "",
    ...formatLimitedSection("BK 결정 필요", input.snapshot.needsDecision, (item) =>
      lineItem({ title: item.title, status: item.status, detail: item.reason, id: `decision:${item.id}` }),
    ),
    ...formatLimitedSection("진행 중", input.snapshot.active, (item) =>
      lineItem({ title: item.title, status: item.status, detail: item.detail, id: `${item.kind}:${item.id}` }),
    ),
    ...formatLimitedSection("막힌 항목", input.snapshot.blocked, (item) =>
      lineItem({ title: item.title, status: item.status, detail: item.detail, id: `${item.kind}:${item.id}` }),
    ),
    ...formatLimitedSection("최근 완료", input.snapshot.completed, (item) =>
      lineItem({ title: item.title, status: item.status, detail: item.detail, id: `${item.kind}:${item.id}` }),
    ),
    input.snapshot.risks.length ? "위험:" : "",
    ...input.snapshot.risks.slice(0, 3).map((risk) => `- ${compactLine(risk)}`),
    input.snapshot.risks.length ? "" : "",
    `다음 안전 행동: ${naturalNextSafeAction(input.snapshot)}`,
    input.relevantRecords.length
      ? `참조한 deterministic context: ${input.relevantRecords.slice(0, 3).map((record) => `${record.kind}:${record.id}`).join(", ")}`
      : "",
  ];
  return stripCeoTurnCommandChoreography(lines.filter((line) => line !== "").join("\n"));
}

function formatProjectAmbiguityResponse(ambiguity: CeoTurnProjectAmbiguity): string {
  const projects = ambiguity.projectIds.length ? ambiguity.projectIds.join(", ") : "unknown";
  const lines = [
    "프로젝트를 확정하지 못해서 요청을 실행하지 않았습니다.",
    "",
    "현재 경계: blocker",
    `막힌 이유: 자연어가 여러 project profile에 걸립니다: ${projects}.`,
    "확인 질문: 어느 프로젝트 기준으로 처리할까요?",
    "경계: 잘못된 프로젝트에 request, plan, task, action, decision, recovery를 만들지 않았습니다.",
  ];
  return stripCeoTurnCommandChoreography(lines.join("\n"));
}

function formatMemoryOnlyCeoTurnResponse(): string {
  const lines = [
    "기억 후보로만 남겼습니다. 이 내용은 실행 요청이 아니라 CEO conversation memory 후보입니다.",
    "",
    "현재 경계: result",
    "요약: 제품 방향, 결정, 또는 rejected path를 future planning context 후보로 처리했습니다.",
    "경계: orchestration request, plan, task, action, decision, recovery 실행, memory write를 만들지 않았습니다.",
  ];
  return stripCeoTurnCommandChoreography(lines.join("\n"));
}

function addLinkedId(target: CeoTurnLinkedStateIds, field: keyof CeoTurnLinkedStateIds, id: string | undefined): void {
  if (!id) return;
  const existing = target[field] ?? [];
  if (!existing.includes(id)) target[field] = [...existing, id] as string[] | undefined;
}

function mergeLinkedStateIds(...items: CeoTurnLinkedStateIds[]): CeoTurnLinkedStateIds {
  const merged: CeoTurnLinkedStateIds = {};
  for (const item of items) {
    for (const [field, ids] of Object.entries(item) as [keyof CeoTurnLinkedStateIds, string[] | undefined][]) {
      for (const id of ids ?? []) addLinkedId(merged, field, id);
    }
  }
  return merged;
}

function linkedStateFromContext(context: CeoTurnContext): CeoTurnLinkedStateIds {
  const linked: CeoTurnLinkedStateIds = {};
  for (const request of context.requests.filter((request) => request.status === "pending_plan")) {
    addLinkedId(linked, "requestIds", request.id);
  }
  for (const plan of context.plans.filter((plan) => plan.status === "planned" || plan.status === "questions" || plan.status === "failed")) {
    addLinkedId(linked, "planIds", plan.id);
  }
  for (const decision of context.decisions.filter((decision) => decision.status === "pending")) {
    addLinkedId(linked, "decisionIds", decision.id);
  }
  for (const task of context.tasks.filter((task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked")) {
    addLinkedId(linked, "taskIds", task.id);
  }
  for (const action of context.actions.filter((action) => action.status === "pending" || action.status === "approved" || action.status === "running" || action.status === "waiting")) {
    addLinkedId(linked, "actionIds", action.id);
  }
  for (const run of context.runs.slice(-3)) addLinkedId(linked, "runIds", run.runId);
  for (const report of context.reports.slice(-3)) addLinkedId(linked, "reportIds", report.id);
  for (const result of context.relevantRecords) {
    for (const citation of result.citations) {
      if (citation.kind === "decision") addLinkedId(linked, "decisionIds", citation.id);
      if (citation.kind === "orchestrator_plan") addLinkedId(linked, "planIds", citation.id);
      if (citation.kind === "task") addLinkedId(linked, "taskIds", citation.id);
      if (citation.kind === "remote_action") addLinkedId(linked, "actionIds", citation.id);
      if (citation.kind === "run_log") addLinkedId(linked, "runIds", citation.id);
      if (citation.kind === "ceo_report") addLinkedId(linked, "reportIds", citation.id);
      if (citation.kind === "memory") addLinkedId(linked, "memoryIds", citation.id);
      if (citation.kind === "governance_event") addLinkedId(linked, "governanceEventIds", citation.id);
    }
  }
  return linked;
}

function linkedStateForPlanningResult(input: {
  context: CeoTurnContext;
  request?: OrchestrationRequestRecord;
  plan?: OrchestratorPlanRecord;
  decision?: DecisionItem;
}): CeoTurnLinkedStateIds {
  const linked = linkedStateFromContext(input.context);
  addLinkedId(linked, "requestIds", input.request?.id);
  addLinkedId(linked, "planIds", input.plan?.id);
  addLinkedId(linked, "decisionIds", input.decision?.id);
  for (const taskId of input.plan?.taskIds ?? []) addLinkedId(linked, "taskIds", taskId);
  for (const actionId of input.plan?.actionIds ?? []) addLinkedId(linked, "actionIds", actionId);
  return linked;
}

function latestMatchingRequest(input: {
  requests: OrchestrationRequestRecord[];
  requestId: string;
  text: string;
  projectId?: string;
}): OrchestrationRequestRecord | undefined {
  const exact = input.requests.find((request) => request.id === input.requestId);
  if (exact) return exact;
  return input.requests
    .slice()
    .reverse()
    .find((request) => {
      if (request.text.trim() !== input.text.trim()) return false;
      if (!input.projectId) return true;
      return selectedProjectIdFromAncestry(request.ancestry) === input.projectId;
    });
}

function boundaryForPlannedTurn(input: {
  plan?: OrchestratorPlanRecord;
  blocker?: OrchestratorPlanBlocker;
  decision?: DecisionItem;
  failure?: string;
}): CeoTurnResponseBoundary["kind"] {
  if (input.failure || !input.plan) return "blocker";
  if (input.plan.status === "failed" || input.plan.status === "questions" || input.blocker) return "blocker";
  if (input.decision?.status === "pending") return "approval_boundary";
  return "next_safe_action";
}

function formatPlanningResponse(input: {
  request?: OrchestrationRequestRecord;
  plan?: OrchestratorPlanRecord;
  blocker?: OrchestratorPlanBlocker;
  decision?: DecisionItem;
  failure?: string;
  relevantRecords: ContextSearchResult[];
}): string {
  const boundary = boundaryForPlannedTurn(input);
  const plan = input.plan;
  const payload = plan?.payload;
  const taskLines = payload?.tasks.slice(0, 4).map((task) =>
    `- ${compactLine(task.title)} (${task.targetAgent}, ${task.resultMode ?? "write"})`,
  ) ?? [];
  const questionLines = payload?.questions.slice(0, 3).map((question) => `- ${compactLine(question)}`) ?? [];
  const blockerLines = [
    ...(payload?.prerequisites ?? []),
    ...(payload?.blockers ?? []),
    ...(input.blocker?.violations ?? []),
  ].slice(0, 5).map((item) => `- ${compactLine(item)}`);
  const riskLines = payload?.risks.slice(0, 3).map((risk) => `- ${compactLine(risk)}`) ?? [];

  const headline =
    input.failure
      ? "요청을 처리하려 했지만 deterministic planning boundary에서 막혔습니다."
      : boundary === "approval_boundary"
        ? "계획은 만들었습니다. 실행은 BK의 명시 판단과 deterministic materialization gate 뒤에 멈춰 있습니다."
        : boundary === "blocker"
          ? "요청은 처리했지만 바로 안전하게 진행할 수 없는 blocker가 있습니다."
          : "요청을 처리했고 다음 안전 행동이 정리됐습니다.";

  const lines = [
    headline,
    "",
    `현재 경계: ${boundary}`,
    input.request ? `요청 기록: ${input.request.id}` : "",
    plan ? `계획 기록: ${plan.id}` : "",
    plan ? `계획 상태: ${plan.status}` : "",
    payload?.summary ? `요약: ${compactLine(payload.summary)}` : "",
    input.failure ? `막힌 이유: ${compactLine(input.failure)}` : "",
    "",
    questionLines.length ? "BK에게 필요한 판단:" : "",
    ...questionLines,
    questionLines.length ? "" : "",
    blockerLines.length ? "막힌 이유:" : "",
    ...blockerLines,
    blockerLines.length ? "" : "",
    taskLines.length ? "선택된 계획 경로:" : "",
    ...taskLines,
    taskLines.length ? "" : "",
    riskLines.length ? "위험:" : "",
    ...riskLines,
    riskLines.length ? "" : "",
    input.decision && boundary === "approval_boundary"
      ? `승인 경계: ${input.decision.title}. 이 턴에서는 승인, task 생성, action 승인, dispatch를 하지 않았습니다.`
      : "",
    boundary === "blocker"
      ? "다음 안전 행동: BK 판단이나 계획 수정이 필요합니다. Samantha가 임의로 승인하거나 실행하지 않습니다."
      : boundary === "approval_boundary"
        ? "다음 안전 행동: BK가 계획을 승인하거나 수정 방향을 줘야 합니다. 그 전까지 실행 상태는 바뀌지 않습니다."
        : "다음 안전 행동: 기존 deterministic queue와 safety gate가 계속 소유합니다.",
    input.relevantRecords.length
      ? `참조한 deterministic context: ${input.relevantRecords.slice(0, 3).map((record) => `${record.kind}:${record.id}`).join(", ")}`
      : "",
  ];
  return stripCeoTurnCommandChoreography(lines.filter((line) => line !== "").join("\n"));
}

function isReportOnlyCeoAutopilotCandidate(input: {
  source: CeoTurnSource;
  classification: ReturnType<typeof classifyRemoteRequest>;
}): boolean {
  return (
    input.source === "remote" &&
    input.classification.resultMode === "report" &&
    input.classification.safeHandling === "report_only"
  );
}

function latestAutopilotEvidenceForRequest(
  evidence: AutopilotEvidenceRecord[],
  requestId: string,
): AutopilotEvidenceRecord | undefined {
  return evidence.slice().reverse().find((record) => record.requestId === requestId);
}

async function loadCeoReportOnlyAutopilotState(input: {
  args: ParsedArgs;
  requestId: string;
}): Promise<{
  request?: OrchestrationRequestRecord;
  plan?: OrchestratorPlanRecord;
  evidence?: AutopilotEvidenceRecord;
  decisions: DecisionItem[];
  actions: RemoteActionRecord[];
  runs: RunSummary[];
}> {
  const [requests, plans, decisions, actions, runs, evidence] = await Promise.all([
    new OrchestrationRequestStore(orchestrationRequestsPath(input.args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(input.args)).list(),
    new DecisionStore(decisionsPath(input.args)).list(),
    new RemoteActionStore(remoteActionsPath(input.args)).list(),
    new RunIndex(runsPath(input.args)).list(),
    new AutopilotEvidenceStore(autopilotEvidencePath(input.args)).list(),
  ]);
  const request = requests.find((item) => item.id === input.requestId);
  const latestEvidence = latestAutopilotEvidenceForRequest(evidence, input.requestId);
  const plan = latestEvidence?.planId
    ? plans.find((item) => item.id === latestEvidence.planId)
    : plans.slice().reverse().find((item) => item.requestId === input.requestId);
  const actionIds = new Set(latestEvidence?.actionIds ?? plan?.actionIds ?? []);
  const runIds = new Set(latestEvidence?.runIds ?? []);

  return {
    request,
    plan,
    evidence: latestEvidence,
    decisions,
    actions: actions.filter((action) => actionIds.has(action.id)),
    runs: runs.filter((run) => runIds.has(run.runId)),
  };
}

function ceoReportOnlyAutopilotBoundary(input: {
  evidence?: AutopilotEvidenceRecord;
  plan?: OrchestratorPlanRecord;
  decisions: DecisionItem[];
  failure?: string;
}): CeoTurnResponseBoundary["kind"] {
  if (input.evidence?.status === "completed" && input.evidence.endpoint === "result") return "result";
  const pendingPlanDecision = input.plan
    ? input.decisions
        .slice()
        .reverse()
        .find((decision) =>
          decision.subject?.type === "orchestrator_plan" &&
          decision.subject.id === input.plan?.id &&
          decision.status === "pending"
        )
    : undefined;
  if (pendingPlanDecision?.kind === "orchestrator_plan_approval") return "approval_boundary";
  if (input.evidence?.endpoint === "bk_judgment") return "blocker";
  return "blocker";
}

function linkedStateForCeoReportOnlyAutopilot(input: {
  context: CeoTurnContext;
  request?: OrchestrationRequestRecord;
  plan?: OrchestratorPlanRecord;
  decisions: DecisionItem[];
  actions: RemoteActionRecord[];
  runs: RunSummary[];
}): CeoTurnLinkedStateIds {
  const linked = linkedStateFromContext(input.context);
  addLinkedId(linked, "requestIds", input.request?.id);
  addLinkedId(linked, "planIds", input.plan?.id);
  for (const decision of input.decisions) {
    if (
      input.plan &&
      decision.status === "pending" &&
      decision.subject?.type === "orchestrator_plan" &&
      decision.subject.id === input.plan.id
    ) {
      addLinkedId(linked, "decisionIds", decision.id);
    }
  }
  for (const taskId of input.plan?.taskIds ?? []) addLinkedId(linked, "taskIds", taskId);
  for (const action of input.actions) addLinkedId(linked, "actionIds", action.id);
  for (const run of input.runs) addLinkedId(linked, "runIds", run.runId);
  return linked;
}

function formatCeoReportOnlyAutopilotResponse(input: {
  request?: OrchestrationRequestRecord;
  plan?: OrchestratorPlanRecord;
  evidence?: AutopilotEvidenceRecord;
  decisions: DecisionItem[];
  actions: RemoteActionRecord[];
  runs: RunSummary[];
  failure?: string;
}): string {
  const boundary = ceoReportOnlyAutopilotBoundary(input);
  const completed = input.evidence?.status === "completed" && input.evidence.endpoint === "result";
  const synthesis = input.plan?.synthesis;
  const summary = compactLine(
    synthesis?.summary ??
      synthesis?.userMessage ??
      input.evidence?.summary ??
      input.plan?.payload?.summary ??
      input.failure ??
      "report-only CEO turn reached a deterministic boundary.",
  );
  const failure = compactLine(input.failure ?? input.evidence?.failure ?? input.plan?.failure ?? input.plan?.synthesisFailure ?? "");
  const refs = [
    input.request ? `request:${input.request.id}` : "",
    input.plan ? `plan:${input.plan.id}` : "",
    input.evidence ? `evidence:${input.evidence.id}` : "",
    ...input.actions.slice(0, 3).map((action) => `action:${action.id}`),
    ...input.runs.slice(0, 3).map((run) => `run:${run.runId}`),
  ].filter(Boolean);
  const completedActions = input.actions.filter((action) => action.status === "completed" && action.result?.pass !== false).length;
  const risks = synthesis?.risks.slice(0, 3) ?? input.plan?.payload?.risks.slice(0, 3) ?? [];

  const lines = [
    completed
      ? "완료했습니다. Samantha가 report-only CEO 요청을 내부 planning, report 실행, synthesis까지 처리했습니다."
      : "처리 가능한 범위까지 진행했고 deterministic boundary에서 멈췄습니다.",
    "",
    `현재 경계: ${boundary}`,
    input.evidence ? `상태: ${input.evidence.status}` : "상태: blocked",
    `요약: ${summary}`,
    failure ? `막힌 이유: ${failure}` : "",
    input.actions.length ? `report action: ${completedActions}/${input.actions.length} 완료` : "",
    risks.length ? "위험:" : "",
    ...risks.map((risk) => `- ${compactLine(risk)}`),
    risks.length ? "" : "",
    refs.length ? `근거: ${refs.join(", ")}` : "",
    "경계: writer 작업, 복구 실행, merge, push, cleanup, approval은 이 턴에서 실행하지 않았습니다.",
  ];

  return stripCeoTurnCommandChoreography(lines.filter((line) => line !== "").join("\n"));
}

async function processCeoTurnReportOnlyAutopilot(input: {
  args: ParsedArgs;
  command: InboxCommand;
  text: string;
  receivedAt: string;
  senderId?: string;
  source: CeoTurnSource;
  context: CeoTurnContext;
  requestedProjectId?: string;
  classification: ReturnType<typeof classifyRemoteRequest>;
}): Promise<CeoTurnProcessResult | undefined> {
  if (!isReportOnlyCeoAutopilotCandidate({ source: input.source, classification: input.classification })) {
    return undefined;
  }

  const requestedProjectId = input.requestedProjectId ?? input.context.inferredProjectId;
  const requestId = buildOrchestrationRequestId(input.receivedAt, `${input.command.id ?? "ceo-turn"}-request`);
  const detectedIntent = {
    kind: input.classification.intent,
    summary: `${input.classification.safeHandling}: ${input.classification.reasons.join("; ") || "classified CEO report-only turn"}`,
  };

  try {
    await handleInboxCommand({
      id: `${input.command.id ?? "ceo-turn"}-request`,
      type: "orchestrator:add-request",
      args: {
        requestId,
        text: input.text,
        senderId: input.senderId,
        source: "remote",
        receivedAt: input.receivedAt,
        ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
      },
    }, input.args);

    const requests = await new OrchestrationRequestStore(orchestrationRequestsPath(input.args)).list();
    const request = latestMatchingRequest({ requests, requestId, text: input.text, projectId: requestedProjectId });
    const projectId = requestedProjectId ?? selectedProjectIdFromAncestry(request?.ancestry);
    if (!request || !projectId) {
      const failure = request?.ancestry?.mode === "unassigned"
        ? `project boundary: ${request.ancestry.reason}`
        : "project boundary: no project profile was selected for this report-only turn";
      const state = request
        ? await loadCeoReportOnlyAutopilotState({ args: input.args, requestId: request.id })
        : { decisions: [], actions: [], runs: [] };
      return {
        response: formatCeoReportOnlyAutopilotResponse({
          request,
          plan: "plan" in state ? state.plan : undefined,
          evidence: "evidence" in state ? state.evidence : undefined,
          decisions: state.decisions,
          actions: state.actions,
          runs: state.runs,
          failure,
        }),
        detectedIntent,
        responseBoundary: {
          kind: "blocker",
          summary: failure,
          respondedAt: input.receivedAt,
        },
        linkedStateIds: linkedStateForCeoReportOnlyAutopilot({
          context: input.context,
          request,
          plan: "plan" in state ? state.plan : undefined,
          decisions: state.decisions,
          actions: state.actions,
          runs: state.runs,
        }),
      };
    }

    const autopilotReport = await tryRunRemoteReportOnlyAutopilot({
      args: input.args,
      request,
      receivedAt: input.receivedAt,
      requestedProjectId: projectId,
    });
    const state = await loadCeoReportOnlyAutopilotState({ args: input.args, requestId: request.id });
    const failure = autopilotReport
      ? undefined
      : "report-only authority boundary: deterministic policy did not allow autopilot progress for this turn";
    const boundaryKind = ceoReportOnlyAutopilotBoundary({ ...state, failure });

    return {
      response: formatCeoReportOnlyAutopilotResponse({
        ...state,
        failure,
      }),
      detectedIntent,
      responseBoundary: {
        kind: boundaryKind,
        summary: state.evidence?.summary ?? failure ?? "Report-only CEO turn progressed through deterministic autopilot.",
        responseId: state.evidence?.id,
        respondedAt: input.receivedAt,
      },
      linkedStateIds: linkedStateForCeoReportOnlyAutopilot({
        context: input.context,
        ...state,
      }),
    };
  } catch (err) {
    const failure = errorMessage(err);
    return {
      response: formatCeoReportOnlyAutopilotResponse({
        decisions: [],
        actions: [],
        runs: [],
        failure,
      }),
      detectedIntent,
      responseBoundary: {
        kind: "blocker",
        summary: failure,
        respondedAt: input.receivedAt,
      },
      linkedStateIds: linkedStateFromContext(input.context),
    };
  }
}

const ceoTurnCommandChoreographyPattern = /(^|[^\w/])\/(?:plan|plan_current|go|approve|now|check)\b/;

function stripCeoTurnCommandChoreography(report: string): string {
  const lines = report.split("\n").filter((line) => !ceoTurnCommandChoreographyPattern.test(line));
  while (lines.at(-1)?.trim() === "") lines.pop();
  return lines.join("\n");
}

async function processCeoTurnPlanningRequest(input: {
  args: ParsedArgs;
  command: InboxCommand;
  text: string;
  receivedAt: string;
  senderId?: string;
  source: CeoTurnSource;
  context: CeoTurnContext;
  requestedProjectId?: string;
}): Promise<CeoTurnProcessResult> {
  const classification = classifyRemoteRequest(input.text);
  const reportOnlyAutopilot = await processCeoTurnReportOnlyAutopilot({
    ...input,
    classification,
  });
  if (reportOnlyAutopilot) return reportOnlyAutopilot;

  const requestedProjectId = input.requestedProjectId ?? input.context.inferredProjectId;
  const requestId = buildOrchestrationRequestId(input.receivedAt, `${input.command.id ?? "ceo-turn"}-request`);

  try {
    await handleInboxCommand({
      id: `${input.command.id ?? "ceo-turn"}-request`,
      type: "orchestrator:add-request",
      args: {
        requestId,
        text: input.text,
        senderId: input.senderId,
        source: input.source === "local" ? "local" : "remote",
        receivedAt: input.receivedAt,
        ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
      },
    }, input.args);
    await handleInboxCommand({
      id: `${input.command.id ?? "ceo-turn"}-plan`,
      type: "orchestrator:plan-latest",
      args: {
        source: input.source,
        receivedAt: input.receivedAt,
        ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
      },
    }, input.args);
  } catch (err) {
    const failure = errorMessage(err);
    return {
      response: formatPlanningResponse({
        failure,
        relevantRecords: input.context.relevantRecords,
      }),
      detectedIntent: {
        kind: classification.intent,
        summary: `${classification.safeHandling}: ${classification.reasons.join("; ") || "classified CEO turn"}`,
      },
      responseBoundary: {
        kind: "blocker",
        summary: failure,
        respondedAt: input.receivedAt,
      },
      linkedStateIds: linkedStateFromContext(input.context),
    };
  }

  const [requests, plans, decisions] = await Promise.all([
    new OrchestrationRequestStore(orchestrationRequestsPath(input.args)).list(),
    new OrchestratorPlanStore(orchestratorPlansPath(input.args)).list(),
    new DecisionStore(decisionsPath(input.args)).list(),
  ]);
  const request = latestMatchingRequest({ requests, requestId, text: input.text, projectId: requestedProjectId });
  const plan = request
    ? await new OrchestratorPlanStore(orchestratorPlansPath(input.args)).latestForRequest(request.id)
    : undefined;
  const blocker = plan
    ? await blockerForOrchestratorPlan({
        args: input.args,
        plan,
        createdAt: input.receivedAt,
        commandId: `${input.command.id ?? "ceo-turn"}-preflight`,
      })
    : undefined;
  const decision = plan
    ? decisions
        .slice()
        .reverse()
        .find((item) => item.subject?.type === "orchestrator_plan" && item.subject.id === plan.id && item.status === "pending")
    : undefined;
  const boundaryKind = boundaryForPlannedTurn({ plan, blocker, decision });

  return {
    response: formatPlanningResponse({
      request,
      plan,
      blocker,
      decision,
      relevantRecords: input.context.relevantRecords,
    }),
    detectedIntent: {
      kind: classification.intent,
      summary: `${classification.safeHandling}: ${classification.reasons.join("; ") || "classified CEO turn"}`,
    },
    responseBoundary: {
      kind: boundaryKind,
      summary: plan?.payload?.summary ?? plan?.failure ?? "CEO turn planning request processed.",
      respondedAt: input.receivedAt,
    },
    linkedStateIds: mergeLinkedStateIds(
      linkedStateFromContext(input.context),
      linkedStateForPlanningResult({ context: input.context, request, plan, decision }),
    ),
  };
}

async function storeLearningCandidates(
  args: ParsedArgs,
  candidates: LearningCandidateRecord[],
): Promise<LearningCandidateRecord[]> {
  if (candidates.length === 0) return [];
  const store = new LearningCandidateStore(learningCandidatesPath(args));
  const stored: LearningCandidateRecord[] = [];
  for (const candidate of candidates) {
    const existing = await store.find(candidate.id);
    stored.push(existing ?? await store.append(candidate));
  }
  return stored;
}

interface NaturalApprovalCandidate {
  decision: DecisionItem;
  plan?: OrchestratorPlanRecord;
  projectId?: string;
}

function naturalApprovalCandidates(input: {
  context: CeoTurnContext;
  projectId?: string;
}): NaturalApprovalCandidate[] {
  return input.context.decisions
    .filter((decision) =>
      decisionIsCurrentPlanApproval(decision, input.context.plans) &&
      decisionMatchesProject(decision, input.context.plans, input.projectId)
    )
    .map((decision) => {
      const plan = input.context.plans.find((item) => item.id === decision.subject?.id);
      return {
        decision,
        plan,
        projectId: projectIdForPlanDecision(decision, input.context.plans),
      };
    });
}

function decisionMatchesNaturalApprovalScope(input: {
  decision: DecisionItem;
  plans: OrchestratorPlanRecord[];
  projectId?: string;
}): boolean {
  if (!input.projectId) return true;
  const decisionProjectId = selectedProjectIdFromAncestry(input.decision.ancestry);
  if (decisionProjectId) return decisionProjectId === input.projectId;
  if (input.decision.subject?.type === "orchestrator_plan") {
    return decisionMatchesProject(input.decision, input.plans, input.projectId);
  }
  return true;
}

function naturalApprovalLikeCandidates(input: {
  context: CeoTurnContext;
  projectId?: string;
}): NaturalApprovalCandidate[] {
  return input.context.decisions
    .filter((decision) =>
      decision.status === "pending" &&
      decision.options.includes("approve") &&
      decisionHasCurrentPlanSubject(decision, input.context.plans) &&
      decisionMatchesNaturalApprovalScope({ decision, plans: input.context.plans, projectId: input.projectId })
    )
    .map((decision) => {
      const plan = decision.subject?.type === "orchestrator_plan"
        ? input.context.plans.find((item) => item.id === decision.subject?.id)
        : undefined;
      return {
        decision,
        plan,
        projectId: projectIdForPlanDecision(decision, input.context.plans),
      };
    });
}

function naturalApprovalCandidateLabel(candidate: NaturalApprovalCandidate): string {
  const title = compactLine(candidate.decision.title);
  return candidate.projectId ? `${candidate.projectId}: ${title}` : title;
}

function linkedStateForNaturalApproval(input: {
  context: CeoTurnContext;
  candidates?: NaturalApprovalCandidate[];
  decision?: DecisionItem;
  plan?: OrchestratorPlanRecord;
}): CeoTurnLinkedStateIds {
  const linked = linkedStateFromContext(input.context);
  addLinkedId(linked, "decisionIds", input.decision?.id);
  addLinkedId(linked, "planIds", input.plan?.id);
  for (const candidate of input.candidates ?? []) {
    addLinkedId(linked, "decisionIds", candidate.decision.id);
    addLinkedId(linked, "planIds", candidate.plan?.id);
  }
  return linked;
}

function formatNaturalApprovalResolvedResponse(input: {
  decision: DecisionItem;
  plan?: OrchestratorPlanRecord;
}): string {
  const lines = [
    "승인했습니다. 자연어 문구가 pending deterministic plan approval decision 하나와만 일치했습니다.",
    "",
    "현재 경계: next_safe_action",
    `승인한 결정: ${compactLine(input.decision.title)}`,
    input.plan?.payload?.summary ? `계획 요약: ${compactLine(input.plan.payload.summary)}` : "",
    "다음 안전 행동: 기존 materialization, queue, writer, project, risk gate가 계속 소유합니다. 이 턴에서는 task 생성, action 승인, dispatch, merge, push, cleanup, recovery, memory write를 하지 않았습니다.",
  ];
  return stripCeoTurnCommandChoreography(lines.filter(Boolean).join("\n"));
}

function formatNaturalApprovalAmbiguousResponse(input: {
  candidates: NaturalApprovalCandidate[];
  projectId?: string;
}): string {
  const labels = input.candidates.slice(0, 4).map(naturalApprovalCandidateLabel);
  const question = !input.projectId && input.candidates.some((candidate) => candidate.projectId)
    ? "어느 프로젝트의 계획을 승인할까요?"
    : "어느 계획을 승인할까요?";
  const lines = [
    "승인하지 않았습니다. 자연어 승인 문구가 여러 pending approval-capable deterministic decision에 걸립니다.",
    "",
    "현재 경계: approval_boundary",
    `확인 질문: ${question}`,
    labels.length ? `후보: ${labels.join(" / ")}` : "",
    input.candidates.length > labels.length ? `외 ${input.candidates.length - labels.length}건` : "",
    "경계: 잘못된 프로젝트나 계획 승인을 막기 위해 state를 변경하지 않았습니다.",
  ];
  return stripCeoTurnCommandChoreography(lines.filter(Boolean).join("\n"));
}

function formatNaturalApprovalNoMatchResponse(input: {
  snapshot: CeoStatusSnapshot;
  relevantRecords: ContextSearchResult[];
  projectId?: string;
}): string {
  const lines = [
    "승인하지 않았습니다. 자연어 승인 문구와 일치하는 current pending plan approval decision이 없습니다.",
    "",
    input.projectId ? `선택된 프로젝트: ${input.projectId}` : "",
    "경계: stale approval, manual/governance/memory/risk-only decision, merge, push, cleanup, recovery, and authority gates are not resolved by natural wording alone.",
    "",
    formatNaturalStatusResponse({
      snapshot: input.snapshot,
      relevantRecords: input.relevantRecords,
    }),
  ];
  return stripCeoTurnCommandChoreography(lines.filter(Boolean).join("\n"));
}

async function processCeoTurnNaturalApproval(input: {
  args: ParsedArgs;
  receivedAt: string;
  context: CeoTurnContext;
  requestedProjectId?: string;
}): Promise<CeoTurnProcessResult> {
  const projectId = input.requestedProjectId ?? input.context.inferredProjectId;
  const candidates = naturalApprovalCandidates({ context: input.context, projectId });
  const approvalLikeCandidates = naturalApprovalLikeCandidates({ context: input.context, projectId });

  if (candidates.length !== 1 || approvalLikeCandidates.length !== 1) {
    const ambiguousCandidates = approvalLikeCandidates.length > 1 ? approvalLikeCandidates : candidates;
    const response = ambiguousCandidates.length > 1
      ? formatNaturalApprovalAmbiguousResponse({ candidates: ambiguousCandidates, projectId })
      : formatNaturalApprovalNoMatchResponse({
          snapshot: input.context.snapshot,
          relevantRecords: input.context.relevantRecords,
          projectId,
        });
    return {
      response,
      detectedIntent: {
        kind: "natural_approval_attempt",
        summary: ambiguousCandidates.length > 1
          ? "Natural approval wording was ambiguous across pending approval-capable decisions; no decision was resolved."
          : "Natural approval wording had no matching current plan approval decision; no decision was resolved.",
      },
      responseBoundary: {
        kind: "approval_boundary",
        summary: ambiguousCandidates.length > 1
          ? "Multiple pending approval-capable decisions could match."
          : "No current plan approval decision matched natural approval wording.",
        respondedAt: input.receivedAt,
      },
      linkedStateIds: linkedStateForNaturalApproval({
        context: input.context,
        candidates: ambiguousCandidates,
      }),
    };
  }

  const candidate = candidates[0];
  const resolved = await new DecisionStore(decisionsPath(input.args)).resolve(candidate.decision.id, {
    resolvedAt: input.receivedAt,
    resolution: "approved",
    note: "Approved via natural CEO turn.",
  });

  return {
    response: formatNaturalApprovalResolvedResponse({
      decision: resolved,
      plan: candidate.plan,
    }),
    detectedIntent: {
      kind: "natural_approval_attempt",
      summary: "Natural approval wording resolved exactly one current plan approval decision.",
    },
    responseBoundary: {
      kind: "next_safe_action",
      summary: "Approved exactly one current deterministic plan approval decision; no execution was performed.",
      respondedAt: input.receivedAt,
    },
    linkedStateIds: linkedStateForNaturalApproval({
      context: input.context,
      decision: resolved,
      plan: candidate.plan,
    }),
  };
}

async function handleCeoTurn(command: InboxCommand, args: ParsedArgs): Promise<string> {
  const text = String(command.args?.text ?? "");
  if (!text.trim()) throw new Error("CEO turn text is required");
  const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
  const source = naturalTurnSource(command.args?.source);
  const actor = naturalTurnActor(command.args?.actor);
  const senderId = typeof command.args?.senderId === "string" ? command.args.senderId : undefined;
  const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
  const context = await loadCeoTurnContext({ args, text, generatedAt: receivedAt, requestedProjectId });
  const approvalAttempt = isNaturalApprovalAttempt(text);
  const hasPendingDecision = context.decisions.some((decision) =>
    decision.status === "pending" && decisionHasCurrentPlanSubject(decision, context.plans)
  );
  const nonApprovalFeedback = !approvalAttempt && hasPendingDecision && isNonApprovalDecisionFeedback(text);
  let result: CeoTurnProcessResult;
  if (context.projectAmbiguity) {
    const classification = classifyRemoteRequest(text);
    result = {
      response: formatProjectAmbiguityResponse(context.projectAmbiguity),
      detectedIntent: {
        kind: classification.intent,
        summary: `Project ambiguity blocked CEO turn before request creation: ${context.projectAmbiguity.reason}`,
      },
      responseBoundary: {
        kind: "blocker",
        summary: context.projectAmbiguity.reason,
        respondedAt: receivedAt,
      },
      linkedStateIds: {},
    };
  } else if (approvalAttempt) {
    result = await processCeoTurnNaturalApproval({
      args,
      receivedAt,
      context,
      requestedProjectId,
    });
  } else if (isCeoStatusRequest(text) || nonApprovalFeedback) {
    result = {
      response: formatNaturalStatusResponse({
        snapshot: context.snapshot,
        relevantRecords: context.relevantRecords,
        nonApprovalFeedback,
      }),
      detectedIntent: {
        kind: nonApprovalFeedback ? "decision_feedback" : "status_request",
        summary: nonApprovalFeedback
          ? "Natural feedback at a decision boundary was not explicit approval; no decision was resolved."
          : "Natural CEO status turn answered from deterministic state.",
      },
      responseBoundary: {
        kind: statusBoundaryKind(context.snapshot),
        summary: nonApprovalFeedback
          ? "Feedback was not explicit approval; no decision was resolved."
          : "Answered from deterministic CEO status context.",
        respondedAt: receivedAt,
      },
      linkedStateIds: linkedStateFromContext(context),
    };
  } else if (isMemoryOnlyCeoTurn(text)) {
    result = {
      response: formatMemoryOnlyCeoTurnResponse(),
      detectedIntent: {
        kind: "memory_capture",
        summary: "Natural CEO turn contained durable memory signals only; no orchestration request was created.",
      },
      responseBoundary: {
        kind: "result",
        summary: "Captured as learning candidates only; no execution state was created.",
        respondedAt: receivedAt,
      },
      linkedStateIds: {},
    };
  } else {
    result = await processCeoTurnPlanningRequest({
      args,
      command,
      text,
      receivedAt,
      senderId,
      source,
      context,
      requestedProjectId,
    });
  }

  const turn = createCeoTurnRecord({
    source,
    actor,
    text,
    detectedIntent: result.detectedIntent,
    responseBoundary: result.responseBoundary,
    linkedStateIds: result.linkedStateIds,
    createdAt: receivedAt,
    updatedAt: receivedAt,
  });
  const memoryCandidates = buildConversationMemoryCandidates({
    turn,
    conversationMemory: context.conversationMemory,
    responseText: result.response,
    projectId: requestedProjectId ?? context.inferredProjectId,
  });
  const storedMemoryCandidates = await storeLearningCandidates(args, memoryCandidates);
  await new CeoTurnStore(ceoTurnsPath(args)).append({
    ...turn,
    memoryCandidateRefs: storedMemoryCandidates.length
      ? storedMemoryCandidates.map((candidate) => candidate.id)
      : undefined,
  });
  return result.response;
}

async function writeCeoNotificationOutbox(
  args: ParsedArgs,
  snapshot: CeoStatusSnapshot,
  createdAt: string,
): Promise<{ file: string; path: string; record: CeoReportRecord }> {
  const report = ceoNotificationReport(snapshot);
  const throttleKey = buildNotificationThrottleKey(snapshot);
  const urgency = classifyNotificationUrgency(snapshot);
  const digestWindow = notificationDigestWindow({ generatedAt: createdAt });
  const store = new CeoReportStore(ceoReportsPath(args));
  const file = compactOutboxFileName({
    createdAt,
    kind: "ceo-notify",
    label: snapshot.overall,
    source: `${createdAt}-${ceoNotificationIdentity(snapshot)}`,
  });
  const dir = outboxDir(args);
  const path = join(dir, file);
  const throttleBase = {
    throttleKey,
    notificationUrgency: urgency.urgency,
    throttleDecision: "delivered" as const,
    throttleReason:
      urgency.urgency === "urgent"
        ? `urgent notification bypassed throttling: ${urgency.bypassReasons.join("; ")}`
        : "first low-risk notification in digest window",
    throttleBypassReasons: urgency.bypassReasons.length ? urgency.bypassReasons : undefined,
    digestWindowStartedAt: digestWindow.startedAt,
    digestWindowEndsAt: digestWindow.endsAt,
  };
  const record: CeoNotifyReportRecord = {
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
    ...throttleBase,
  };
  const existingRecord = await store.find(record.id);
  if (existingRecord) {
    if (existingRecord.kind === "ceo_notify") {
      return { file: existingRecord.outboxFile, path: existingRecord.outboxPath, record: existingRecord };
    }
    return { file, path, record: existingRecord };
  }
  const existingDelivered =
    urgency.urgency === "low_risk"
      ? await store.findDeliveredInDigestWindow({ throttleKey, generatedAt: createdAt })
      : undefined;
  if (existingDelivered) {
    const digestRecord: CeoReportRecord = {
      schemaVersion: 1,
      id: buildNotificationDigestId({
        generatedAt: createdAt,
        sourceReportId: existingDelivered.id,
        throttleKey,
      }),
      kind: "notification_digest",
      generatedAt: createdAt,
      sourceReportId: existingDelivered.id,
      sourceOutboxFile: existingDelivered.outboxFile,
      coalescedCount: (await store.countDigestsForSource(existingDelivered.id)) + 1,
      overall: snapshot.overall,
      nextActionKind: snapshot.nextAction.kind,
      decisionCount: snapshot.needsDecision.length,
      activeCount: snapshot.active.length,
      blockedCount: snapshot.blocked.length,
      riskCount: snapshot.risks.length,
      throttleKey,
      notificationUrgency: "low_risk",
      throttleDecision: "coalesced_digest",
      throttleReason: `coalesced with ${existingDelivered.outboxFile} in ${digestWindow.startedAt}..${digestWindow.endsAt}`,
      digestWindowStartedAt: digestWindow.startedAt,
      digestWindowEndsAt: digestWindow.endsAt,
    };
    const persistedDigest = await store.append(digestRecord);
    return { file: existingDelivered.outboxFile, path: existingDelivered.outboxPath, record: persistedDigest };
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
    normalized.includes("telegram reply failed") ||
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
  if (command.type === "ceo:turn") {
    return handleCeoTurn(command, args);
  }
  if (command.type === "status:show") {
    const runs = await new RunIndex(runsPath(args)).list();
    const ops = withoutActiveInboxCommand(await collectOps(args));
    return statusReport({
      runs,
      heartbeat: ops.health.heartbeat,
      pendingInboxCount: ops.queues.pendingInboxCount,
      ops,
      mode: "compact",
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
      budgetPolicies: await new BudgetPolicyStore(budgetPoliciesPath(args)).list(),
      projectId: typeof command.args?.projectId === "string" ? command.args.projectId : undefined,
    });
  }
  if (command.type === "ops:now") {
    return nowReportForInbox(args);
  }
  if (command.type === "ops:doctor") {
    const ops = withoutActiveInboxCommand(await collectOps(args));
    return doctorReport(ops, { pressure: await queuePressureForReport(args, ops) });
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
  if (command.type === "routine:observe") {
    const observedAt = String(command.args?.observedAt ?? command.args?.receivedAt ?? new Date().toISOString());
    const text = String(command.args?.text ?? "");
    if (!text.trim()) throw new Error("routine observation text is required");
    const result = await observeRoutineTrigger({
      args,
      routineId: typeof command.args?.routineId === "string" ? command.args.routineId : undefined,
      triggerId: typeof command.args?.triggerId === "string" ? command.args.triggerId : undefined,
      projectId: typeof command.args?.projectId === "string" ? command.args.projectId : undefined,
      text,
      observedAt,
      sourceEvidence: Array.isArray(command.args?.sourceEvidence)
        ? command.args.sourceEvidence.map(String)
        : typeof command.args?.sourceEvidence === "string"
          ? csvFlag(command.args.sourceEvidence)
          : undefined,
      requestId: typeof command.args?.requestId === "string" ? command.args.requestId : undefined,
      source: command.args?.source === "remote" ? "remote" : "local",
      senderId: typeof command.args?.senderId === "string" ? command.args.senderId : undefined,
    });
    return result.request
      ? orchestrationRequestAddedReport(result.request)
      : [
          "# routine-observation",
          "",
          `Observation: ${result.observation.id}`,
          `Status: ${result.observation.status}`,
          result.observation.admission ? `Admission: ${result.observation.admission.decision} (${result.observation.admission.pressureClass})` : "",
          result.observation.coalescedWith?.length
            ? `Coalesced with: ${result.observation.coalescedWith.map((item) => `${item.kind}:${item.id}`).join(", ")}`
            : "",
          "",
          "No request, task, action, dispatch, merge, push, cleanup, recovery, or approval was performed.",
        ].filter(Boolean).join("\n");
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
    const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(args));
    const requestAncestry = ancestryForRequestIntake({
      requestId,
      requestText: text,
      projectProfiles,
      requestedProjectId,
    });
    const resolvedProjectId = selectedProjectIdFromAncestry(requestAncestry);
    const isRemoteReportOnlyAutopilot = command.args?.autopilot === "remote_report_only";
    if (resolvedProjectId) {
      const duplicate = (await requestStore.list()).find(
        (request) =>
          request.status === "pending_plan" &&
          !isRecoveryPendingRequest(request) &&
          pendingProjectRequestMatches(request, resolvedProjectId) &&
          request.text.trim() === text.trim(),
      );
      if (duplicate) {
        if (isRemoteReportOnlyAutopilot) {
          const admission = await queueAdmissionFor({
            args,
            subjectKind: "request",
            projectId: resolvedProjectId,
            budgetContext: budgetContextFromAncestry(duplicate.ancestry),
            excludeRequestId: duplicate.id,
          });
          const autopilotReport = await tryRunRemoteReportOnlyAutopilot({
            args,
            request: {
              ...duplicate,
              admission: queueAdmissionRecord({ decidedAt: receivedAt, result: admission }),
            },
            receivedAt,
            requestedProjectId: resolvedProjectId,
          });
          if (autopilotReport) return autopilotReport;
        }
        return remoteDuplicatePendingRequestReport({ projectId: resolvedProjectId });
      }
    }
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: requestId,
      ancestry: requestAncestry,
      source: command.args?.source === "local" ? "local" : "remote",
      senderId: typeof command.args?.senderId === "string" ? command.args.senderId : undefined,
      text,
      status: "pending_plan",
      createdAt: receivedAt,
    };
    const admission = await queueAdmissionFor({
      args,
      subjectKind: "request",
      projectId: selectedProjectIdFromAncestry(request.ancestry),
      budgetContext: budgetContextFromAncestry(request.ancestry),
    });
    request.admission = queueAdmissionRecord({ decidedAt: receivedAt, result: admission });
    if (!request.id) throw new Error("orchestration request id is required");
    await requestStore.append(request);
    if (isRemoteReportOnlyAutopilot) {
      const autopilotReport = await tryRunRemoteReportOnlyAutopilot({
        args,
        request,
        receivedAt,
        requestedProjectId,
      });
      if (autopilotReport) return autopilotReport;
    }
    return orchestrationRequestAddedReport(request);
  }
  if (command.type === "orchestrator:drop-pending") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const projectId = String(command.args?.projectId ?? "");
    const dropMode = String(command.args?.dropMode ?? "");
    if (dropMode !== "stale" && dropMode !== "all" && dropMode !== "recovery") {
      throw new Error("unsupported remote command");
    }
    await validateRemoteProjectContext({ args, requestedProjectId: projectId });
    const requestStore = new OrchestrationRequestStore(orchestrationRequestsPath(args));
    const projectPending = (await requestStore.list())
      .filter((request) => request.status === "pending_plan")
      .filter((request) => pendingProjectRequestMatches(request, projectId));
    const normalPending = projectPending.filter((request) => !isRecoveryPendingRequest(request));
    const latestNormal = latestRequest(normalPending);
    const targets =
      dropMode === "all"
        ? projectPending
        : dropMode === "recovery"
          ? projectPending.filter(isRecoveryPendingRequest)
          : normalPending.filter((request) => request.id !== latestNormal?.id);

    for (const request of targets) {
      await requestStore.markDiscarded(request.id, { discardedAt: receivedAt });
    }

    const remaining = (await requestStore.list())
      .filter((request) => request.status === "pending_plan")
      .filter((request) => pendingProjectRequestMatches(request, projectId));
    return remoteDropPendingRequestsReport({
      mode: dropMode,
      projectId,
      discardedCount: targets.length,
      keptCount: remaining.length,
    });
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
        example: requestedProjectId ? "/recover project:<project>" : undefined,
        examples: requestedProjectId ? undefined : projectExamplesForRecords(recoverableCandidates.map((candidate) => candidate.plan), "/recover"),
      });
    }
    const recoverable = recoverableCandidates[0];
    if (!recoverable) return nowReportForInbox(args);
    const recoveryProjectId = selectedProjectIdFromAncestry(recoverable.plan.ancestry);
    if (recoveryProjectId) {
      const existingRecovery = (await new OrchestrationRequestStore(orchestrationRequestsPath(args)).list()).find(
        (request) =>
          request.status === "pending_plan" &&
          request.recoveryOfPlanId === recoverable.plan.id &&
          pendingProjectRequestMatches(request, recoveryProjectId),
      );
      if (existingRecovery) return remoteDuplicateRecoveryPendingRequestReport({ projectId: recoveryProjectId });
    }
    const recoveryProject = recoveryProjectId
      ? await loadProjectProfile(projectProfilesDir(args), recoveryProjectId)
      : undefined;

    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: String(command.args?.requestId ?? buildOrchestrationRequestId(receivedAt, `recover-${recoverable.plan.id}`)),
      ancestry: recoverable.plan.ancestry,
      routineTriggerId: recoverable.plan.routineTriggerId,
      routineFingerprint: recoverable.plan.routineFingerprint,
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
    const admission = await queueAdmissionFor({
      args,
      subjectKind: "recovery_request",
      projectId: selectedProjectIdFromAncestry(request.ancestry),
      budgetContext: budgetContextFromAncestry(request.ancestry),
    });
    request.admission = queueAdmissionRecord({ decidedAt: receivedAt, result: admission });
    await new OrchestrationRequestStore(orchestrationRequestsPath(args)).append(request);
    return orchestratorRecoveryRequestReport({
      request,
      sourcePlan: recoverable.plan,
      failedActions: recoverable.failedActions,
    });
  }
  if (command.type === "orchestrator:unblock-current") {
    return handleRemoteUnblock({
      args,
      receivedAt: String(command.args?.receivedAt ?? new Date().toISOString()),
      requestedProjectId: typeof command.args?.projectId === "string" ? command.args.projectId : undefined,
      reason: typeof command.args?.reason === "string" ? command.args.reason : undefined,
      command: "/unblock",
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
      routineTriggerId: plan.routineTriggerId ?? originalRequest?.routineTriggerId,
      routineFingerprint: plan.routineFingerprint ?? originalRequest?.routineFingerprint,
      source: command.args?.source === "local" ? "local" : "remote",
      senderId: typeof command.args?.senderId === "string" ? command.args.senderId : undefined,
      text: revisionRequestText({ plan, request: originalRequest, feedback }),
      status: "pending_plan",
      createdAt: receivedAt,
    };
    const admission = await queueAdmissionFor({
      args,
      subjectKind: "request",
      projectId: selectedProjectIdFromAncestry(request.ancestry),
      budgetContext: budgetContextFromAncestry(request.ancestry),
      excludePlanId: plan.id,
    });
    request.admission = queueAdmissionRecord({ decidedAt: receivedAt, result: admission });
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
    const requestedProjectId = typeof command.args?.projectId === "string" ? command.args.projectId : undefined;
    const requestedScopeId = typeof command.args?.scopeId === "string" ? command.args.scopeId : undefined;
    const selectedRequest = await selectPendingRequestForPlan({ args, requestedProjectId, requestedScopeId });
    if (selectedRequest.report) return selectedRequest.report;
    const request = selectedRequest.request;
    if (!request) return nowReportForInbox(args);
    const planned = await createOrchestratorPlanForRequest({
      args,
      request,
      receivedAt,
      requestedProjectId,
      requestedScopeId,
      ensureDecision: true,
    });
    if (planned.report) return planned.report;
    if (!planned.plan || !planned.request) return nowReportForInbox(args);
    const report = orchestratorPlanReport({ request: planned.request, plan: planned.plan, blocker: planned.blocker });
    return selectedRequest.staleDuplicateCount
      ? `${report}\n\n보류 중인 이전 요청 ${selectedRequest.staleDuplicateCount}개는 실행하지 않았습니다. 정리: \`/drop stale project:${requestedProjectId}\``
      : report;
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
    const prepared = await prepareDispatchActionForTask({
      args,
      taskId,
      receivedAt: String(command.args?.receivedAt ?? new Date().toISOString()),
      commandId: command.id,
    });
    if (prepared.report) return prepared.report;
    return remoteActionPreparedReport(prepared.action!);
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
    const prepared = await prepareDispatchActionForTask({
      args,
      taskId: task.id,
      receivedAt: String(command.args?.receivedAt ?? new Date().toISOString()),
      commandId: command.id,
    });
    if (prepared.report) return prepared.report;
    return remoteActionPreparedReport(prepared.action!);
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
          example: requestedProjectId ? "/go project:<project>" : undefined,
          examples: requestedProjectId ? undefined : projectExamplesForPlanDecisions(blockerClarificationCandidates, currentPlans, "/go"),
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
      const actionAdmission = await queueAdmissionFor({
        args,
        subjectKind: "action",
        projectId: requestedProjectId ?? selectedProjectIdFromAncestry(orchestratorPlan.ancestry),
        budgetContext: {
          ...budgetContextFromAncestry(orchestratorPlan.ancestry),
          projectId: requestedProjectId ?? selectedProjectIdFromAncestry(orchestratorPlan.ancestry),
        },
      });
      if (actionAdmission.decision !== "accept") return formatQueueAdmissionDecision(actionAdmission);

      const taskStore = new TaskStore(tasksPath(args));
      const actionStore = new RemoteActionStore(remoteActionsPath(args));

      for (const task of materialized.tasks) {
        await taskStore.append(task);
      }
      const materializedActions: RemoteActionRecord[] = [];
      for (const action of materialized.actions) {
        const admittedAction = {
          ...action,
          admission: queueAdmissionRecord({ decidedAt: receivedAt, result: actionAdmission }),
        };
        await actionStore.append(admittedAction);
        materializedActions.push(
          admittedAction.status === "pending" ? await actionStore.markApproved(admittedAction.id, receivedAt) : admittedAction,
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
    const action = await store.find(id);
    if (!action) throw new Error(`remote action not found: ${id}`);
    const admission = await queueAdmissionFor({
      args,
      subjectKind: "action",
      projectId: selectedProjectIdFromAncestry(action.ancestry),
      budgetContext: budgetContextForAction(action),
      excludeActionId: action.id,
    });
    if (admission.decision !== "accept") return formatQueueAdmissionDecision(admission);
    const approved = await store.markApproved(id, String(command.args?.receivedAt ?? new Date().toISOString()));
    return remoteActionApprovedReport(approved);
  }
  if (command.type === "actions:approve-latest") {
    const action = (await new RemoteActionStore(remoteActionsPath(args)).list())
      .slice()
      .reverse()
      .find((item) => item.status === "pending");
    if (!action) return nowReportForInbox(args);
    const admission = await queueAdmissionFor({
      args,
      subjectKind: "action",
      projectId: selectedProjectIdFromAncestry(action.ancestry),
      budgetContext: budgetContextForAction(action),
      excludeActionId: action.id,
    });
    if (admission.decision !== "accept") return formatQueueAdmissionDecision(admission);
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

  if (args.command === "routine:observe") {
    const text = flag(args, "text", "");
    if (!text.trim()) throw new Error("usage: routine:observe <routine-id> --text=<request>");
    const observedAt = flag(args, "observed-at", new Date().toISOString());
    printJson(
      await observeRoutineTrigger({
        args,
        routineId: args.positionals[0] || flag(args, "routine-id", "") || undefined,
        triggerId: flag(args, "trigger-id", "") || undefined,
        projectId: flag(args, "project", "") || undefined,
        text,
        observedAt,
        sourceEvidence: csvFlag(flag(args, "source-evidence", "")),
        requestId: flag(args, "request-id", "") || undefined,
        source: flag(args, "source", "local") === "remote" ? "remote" : "local",
        senderId: flag(args, "sender-id", "") || undefined,
      }),
    );
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

  if (args.command === "backup:manifest") {
    const manifest = await buildBackupManifest({
      root,
      generatedAt: flag(args, "generated-at", new Date().toISOString()),
      stateDir: stateDir(args),
      runsDir: logDir(args),
      inboxDir: resolve(flag(args, "inbox-dir", join(root, "inbox"))),
      outboxDir: outboxDir(args),
      archiveInboxDir: resolve(flag(args, "archive-dir", join(root, "archive", "inbox"))),
      dashboardDir: resolve(flag(args, "dashboard-dir", join(root, "dashboard"))),
      projectProfilesDir: projectProfilesDir(args),
    });
    const out = flag(args, "out", "");
    if (out) {
      await mkdir(dirname(resolve(out)), { recursive: true });
      await writeFile(resolve(out), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      printJson({ out: resolve(out), entries: manifest.entries.length });
    } else {
      printJson(manifest);
    }
    return;
  }

  if (args.command === "restore:validate") {
    const result = await validateRestore({
      root,
      manifestPath: args.flags.has("manifest") ? backupManifestPath(args) : undefined,
      currentHostId: flag(args, "current-host-id", process.env.SAMANTHA_HOST_ID ?? "") || undefined,
      checkedAt: flag(args, "checked-at", new Date().toISOString()),
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "migration:validate") {
    const oldHostOwnershipPath = flag(args, "old-host-ownership", "");
    const newHostOwnershipPath = flag(args, "new-host-ownership", "");
    const targetHostId = flag(args, "target-host-id", process.env.SAMANTHA_HOST_ID ?? "");
    if (!oldHostOwnershipPath || !newHostOwnershipPath || !targetHostId) {
      throw new Error("usage: migration:validate --old-host-ownership=<path> --new-host-ownership=<path> --target-host-id=<id>");
    }
    const result = await validateHostMigration({
      oldHostOwnershipPath: resolve(oldHostOwnershipPath),
      newHostOwnershipPath: resolve(newHostOwnershipPath),
      targetHostId,
      checkedAt: flag(args, "checked-at", new Date().toISOString()),
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
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

  if (args.command === "host:claim" || args.command === "host:client") {
    await writeHostOwnership(args, args.command === "host:claim" ? "active_automation_host" : "client_machine");
    return;
  }

  if (args.command === "doctor" || args.command === "ops:doctor") {
    const snapshot = await collectOps(args);
    if (args.flags.get("json") === true) {
      printJson(snapshot);
    } else {
      console.log(doctorReport(snapshot, { pressure: await queuePressureForReport(args, snapshot) }));
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
      "  routine:observe <routine-id> --text=<request>",
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
      "  doctor [--json] [--local-only] [--host-id=<id>] [--host-ownership-path=<path>] [--max-pending-inbox-age-ms=300000]",
      "  health:check [--max-age-ms=15000]",
      "  host:claim --host-id=<id> [--expires-at=<iso>]",
      "  host:client --host-id=<id>",
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
      "  backup:manifest [--out=<manifest.json>] [--generated-at=<iso>]",
      "  restore:validate [--manifest=<manifest.json>] [--current-host-id=<id>]",
      "  migration:validate --old-host-ownership=<path> --new-host-ownership=<path> --target-host-id=<id>",
      "  tasks:add <task.json>",
      "  tasks:list [--include-archived]",
      "  tasks:show <task-id>",
      "  tasks:archive <task-id> --reason=<text>",
      "  tasks:dispatch <task-id> --repo-root=<repo> [--execute] [--live-log] [--tmux]",
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
