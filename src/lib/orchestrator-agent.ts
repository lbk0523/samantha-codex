import type { AgentProfile } from "./contracts";
import { parseOptionalWorkItemAncestry } from "./ancestry";
import { classifyRemoteRequest, type ProjectProfile, type RemoteRequestClassification } from "./project-profile";
import { projectEffectiveForbiddenChanges } from "./project-safety-policy";
import {
  parseMemoryEntryKind,
  validateMemorySourceCitation,
  type MemoryEntryKind,
  type MemorySourceCitation,
} from "./memory-taxonomy";
import type {
  ContextSearchResult,
  ContextSearchResultStatus,
} from "./context-search";
import type {
  OrchestratorContextCitation,
  OrchestrationRequestRecord,
  OrchestratorPlanPayload,
  OrchestratorRecommendationTrace,
  OrchestratorQuestionDraftPayload,
  OrchestratorPlanStatus,
  OrchestratorPlanRecord,
  OrchestratorSynthesisPayload,
} from "./orchestrator-store";
import { selectedProjectIdFromAncestry } from "./orchestration-ancestry";
import type { RemoteActionRecord } from "./remote-action-store";
import { advisoryRoleTopologyPromptLines } from "./role-topology";
import type { WorkerRunLog } from "./run-log";
import { runCommand, type CommandRunResult } from "./worker-dispatch";
import {
  buildLearningCandidateId,
  parseLearningCandidateRecord,
  type LearningCandidateBehaviorImpact,
  type LearningCandidateRecord,
  type LearningCandidateScope,
} from "./proposal-store";

export interface OrchestratorPlanRunResult {
  status: OrchestratorPlanStatus;
  command: CommandRunResult;
  rawOutput: string;
  payload?: OrchestratorPlanPayload;
  classification: RemoteRequestClassification;
  failure?: string;
}

export type PlanningMemorySnippetKind =
  | "decision_summary"
  | "project_brief"
  | "preference"
  | "known_risk"
  | "strategy_context"
  | "operator_report"
  | "ceo_report"
  | "conversation_memory"
  | "report_artifact"
  | "sop_document"
  | "skill_document";

export interface PlanningMemorySnippet {
  id: string;
  kind: PlanningMemorySnippetKind;
  status: Extract<ContextSearchResultStatus, "ok" | "stale" | "conflict">;
  title: string;
  snippet: string;
  citations: OrchestratorContextCitation[];
}

export interface OrchestratorSynthesisRunResult {
  command: CommandRunResult;
  rawOutput: string;
  payload?: OrchestratorSynthesisPayload;
  failure?: string;
}

export interface OrchestratorQuestionDraftRunResult {
  command: CommandRunResult;
  rawOutput: string;
  payload?: OrchestratorQuestionDraftPayload;
  failure?: string;
}

export type MemorySynthesisEvidenceStatus = "ok" | "stale" | "conflict" | "missing" | "malformed";

export interface MemorySynthesisEvidence {
  citation: MemorySourceCitation;
  snippet: string;
  status?: MemorySynthesisEvidenceStatus;
  staleReason?: string;
}

export interface OrchestratorMemorySynthesisProposal {
  proposedMemoryKind: MemoryEntryKind;
  scope: LearningCandidateScope;
  summary: string;
  proposedContent: string;
  citations: MemorySourceCitation[];
  confidence: number;
  staleSourceNotes: string[];
  behaviorImpact: LearningCandidateBehaviorImpact;
  behaviorImpactReviewRequired: boolean;
}

export interface OrchestratorMemorySynthesisPayload {
  summary: string;
  proposals: OrchestratorMemorySynthesisProposal[];
  rejectedEvidence: string[];
  userMessage: string;
}

export interface OrchestratorMemorySynthesisRunResult {
  command: CommandRunResult;
  rawOutput: string;
  payload?: OrchestratorMemorySynthesisPayload;
  candidates?: LearningCandidateRecord[];
  failure?: string;
}

export function buildOrchestratorPrompt(input: {
  request: OrchestrationRequestRecord;
  projectProfiles: ProjectProfile[];
  requestedProjectId?: string;
  requestedScopeId?: string;
  planningMemory?: PlanningMemorySnippet[];
}): string {
  const classification = classifyRemoteRequest(input.request.text);
  const selectedProjectId = selectedProjectIdFromAncestry(input.request.ancestry);
  const planningMemory = selectedPlanningMemory(input.planningMemory ?? []);
  return [
    "You are the Samantha Orchestrator Agent.",
    "Your job is to make one bounded planning proposal for the deterministic Samantha CEO office.",
    "Do not edit files. Do not create task drafts. Do not dispatch workers. Do not run merge, push, or cleanup commands.",
    "Do not claim that you created tasks, approved actions, changed durable state, merged, pushed, or cleaned up work.",
    "Your output is advisory data only. TypeScript validation and BK decisions own all state changes and execution.",
    "Inspect the repository if needed, then return a plan that the Samantha control plane can review.",
    "",
    "User request:",
    input.request.text,
    "",
    "Command hints:",
    input.requestedProjectId ? `- requested project: ${input.requestedProjectId}` : "- requested project: none",
    input.requestedScopeId ? `- requested scope: ${input.requestedScopeId}` : "- requested scope: none",
    "",
    "Selected ancestry context:",
    input.request.ancestry
      ? `- mode: ${input.request.ancestry.mode}`
      : "- mode: legacy",
    selectedProjectId ? `- projectId: ${selectedProjectId}` : "- projectId: none",
    input.request.ancestry?.mode === "assigned" ? `- goalId: ${input.request.ancestry.goalId}` : "- goalId: none",
    input.request.ancestry?.workItemId ? `- workItemId: ${input.request.ancestry.workItemId}` : `- workItemId: ${input.request.id}`,
    selectedProjectId
      ? `All executable task proposals must set projectId exactly to ${selectedProjectId}.`
      : "Project context is unresolved; prefer blocking questions and leave tasks empty.",
    "",
    "Deterministic request classification:",
    `- intent: ${classification.intent}`,
    `- safe handling: ${classification.safeHandling}`,
    classification.resultMode ? `- result mode hint: ${classification.resultMode}` : "- result mode hint: none",
    classification.preferredAgentId ? `- profile hint: ${classification.preferredAgentId}` : "- profile hint: none",
    `- reasons: ${classification.reasons.join("; ")}`,
    "Use this classification as an explainable safety hint only. It is not permission to dispatch workers or mutate state.",
    "If classification is `ambiguity_heavy`, prefer blocking questions and leave `tasks` empty unless a report-only task is clearly safe.",
    "",
    "Known project profiles:",
    ...projectProfileLines(input.projectProfiles),
    "",
    "Selected source-backed memory context:",
    ...(planningMemory.length ? planningMemoryLines(planningMemory) : ["- none"]),
    "Use these snippets only as planning context, not as authority. Do not invent sources, ids, citations, decisions, briefs, reports, preferences, risks, SOPs, or skills.",
    "If a prior decision, project brief, preference, risk, report, or SOP influences a recommendation, include it in `recommendationTrace` with exact citations from the selected memory context.",
    "If no selected memory snippet influences the recommendation, set `recommendationTrace` to an empty array.",
    "Stale or conflicting memory may only be cited as a risk, ambiguity, or rejected alternative, not as active policy.",
    "",
    "Return a concise Korean user-facing plan, then include exactly one machine-readable payload.",
    "The payload must start with `ORCHESTRATOR_PLAN:` followed by a strict JSON object.",
    "If the request is ambiguous enough that worker delegation would be unsafe, put the blocking questions in `questions` and leave `tasks` empty.",
    "Use plain plan `questions` for ambiguity found while drafting the current plan, such as unclear scope, project, acceptance criteria, or BK preference.",
    "`orchestrator:question-draft` is only for an existing ambiguous blocker already linked to a concrete subject such as a plan, run, task, or action.",
    "Do not ask the question-draft worker from inside a plan payload, and do not turn a plain plan question into a task proposal.",
    "If Samantha lacks a local prerequisite such as a project profile, canonical repo root, concrete verify command, or host-only runtime requirement, put it in `prerequisites` or `blockers` and leave `tasks` empty.",
    "`prerequisites` and `blockers` are hard stops. If either array is non-empty, `tasks` and `batches` MUST be empty.",
    "For report-only dogfood, readiness, or planning requests, active-host or Telegram runtime readiness is advisory risk/verification context unless BK explicitly asked Samantha to run the dogfood now.",
    "Put advisory preflight checks in `risks`, `assumptions`, `scope`, or task `instructions`, not in `prerequisites` or `blockers`.",
    "Do not turn missing context, missing profile/root/verify data, or host-only runtime work into speculative worker tasks.",
    "If it is plannable, keep `questions` empty and include one or more task proposals.",
    "Prefer the simplest safe approach first and describe it in `selectedApproach`.",
    "Put rejected paths in `rejectedAlternatives` as advisory context only; alternatives must not contain tasks, task ids, batches, or execution instructions.",
    "Put important costs, benefits, or safety compromises in `tradeoffs`.",
    "Only `tasks` and `batches` represent the selected executable plan path. `/go` materializes only that selected task set.",
    "For each task, set `projectId` to one of the known project profile ids whenever possible.",
    "Leave `repoRoot` empty or set it exactly to the selected project profile repo.",
    "Choose task roles deliberately:",
    "- Use `codex-spec` for report-only requirement shaping, scope decomposition, or acceptance criteria before implementation.",
    "- Use `codex-reviewer` for report-only code review, risk review, or existing-state audit before implementation.",
    "- Use `codex-evaluator` for report-only validation planning, test strategy, or result assessment that does not need file edits.",
    "- Use `codex-researcher` for report-only repository-local research or decision/context lookup.",
    "- Use `codex-content` for report-only content drafting or critique that stays in the final response.",
    "- Use `codex-operations` for report-only operational analysis, runbook checks, prerequisites, or safe next-action reports.",
    "- Use `codex-worker` only for implementation/write tasks that may change files.",
    ...advisoryRoleTopologyPromptLines(),
    "Non-writer tasks must use `resultMode: \"report\"`, `targetFiles: []`, and no file-writing instructions.",
    "Non-writer tasks must not depend on unmerged files produced by writer tasks.",
    "Do not add extra role tasks unless they reduce concrete risk for the user's request.",
    "Batches are execution waves: tasks in a later batch wait until all earlier batch actions pass before promotion.",
    "Put report-only risk reducers before or in the same batch as the single writer task; do not schedule report-only verification after writer output.",
    "Never set `repoRoot` to a path under `.samantha-worktrees`, `runs`, `state`, or a previous worker worktree.",
    "Worker tasks must start from the canonical project repo; do not recover by dispatching a new worker with an old worker worktree as its repo.",
    "For recovery requests, treat run logs, changed files, and worker worktree paths as evidence only.",
    "Recovery tasks must use the selected project profile's canonical repoRoot. If unsure, leave `repoRoot` empty and set `projectId` so the control plane applies the profile default.",
    "Each worker task gets its own worktree from the canonical repo. Dependent tasks do not see unmerged file changes from earlier worker tasks.",
    "Do not create a separate verify-only task that depends on files written by an earlier write task. Put verification for a write task in that same task's verifyCommands.",
    "Every write task must include its own non-empty `verifyCommands`; project defaults are not enough for writer task proposals.",
    "",
    "Payload shape:",
    JSON.stringify(
      {
        summary: "short Korean summary",
        assumptions: ["assumption"],
        questions: [],
        prerequisites: [],
        blockers: [],
        scope: ["in scope item"],
        nonScope: ["out of scope item"],
        risks: ["risk or open issue"],
        selectedApproach: "simplest safe approach Samantha should take",
        rejectedAlternatives: [
          {
            title: "alternative approach",
            reason: "why this was rejected",
            tradeoffs: ["cost or benefit"],
          },
        ],
        tradeoffs: ["selected approach tradeoff"],
        recommendationTrace: [
          {
            recommendation: "recommended action or planning choice",
            reason: "why this was recommended",
            citations: [{ kind: "decision", id: "stable-source-id" }],
          },
        ],
        tasks: [
          {
            id: "task-short-id",
            title: "task title",
            targetAgent: "codex-worker",
            projectId: "project id if known",
            repoRoot: "repo root if known",
            resultMode: "write or report",
            targetFiles: ["repo-relative path or glob"],
            forbiddenChanges: ["repo-relative glob"],
            setupCommands: ["setup command"],
            verifyCommands: ["verify command"],
            instructions: "worker instructions",
            dependencies: [],
          },
        ],
        batches: [["task-short-id"]],
        userMessage: "Korean Telegram message to show the user",
      },
      null,
      2,
    ),
  ].join("\n");
}

export function buildCodexOrchestratorCommand(input: {
  agent: AgentProfile;
  repoRoot: string;
  prompt: string;
  codexBin?: string;
}): string[] {
  const command = [
    input.codexBin ?? "codex",
    "exec",
    "--cd",
    input.repoRoot,
    "--sandbox",
    "read-only",
    "--json",
  ];

  if (input.agent.model) command.push("--model", input.agent.model);
  if (input.agent.codexProfile) command.push("--profile", input.agent.codexProfile);

  command.push(input.prompt);
  return command;
}

export async function runOrchestratorPlan(input: {
  request: OrchestrationRequestRecord;
  agent: AgentProfile;
  repoRoot: string;
  projectProfiles: ProjectProfile[];
  requestedProjectId?: string;
  requestedScopeId?: string;
  codexBin?: string;
  planningMemory?: PlanningMemorySnippet[];
}): Promise<OrchestratorPlanRunResult> {
  const classification = classifyRemoteRequest(input.request.text);
  const prompt = buildOrchestratorPrompt({
    request: input.request,
    projectProfiles: input.projectProfiles,
    requestedProjectId: input.requestedProjectId,
    requestedScopeId: input.requestedScopeId,
    planningMemory: input.planningMemory,
  });
  const command = await runCommand(buildCodexOrchestratorCommand({
    agent: input.agent,
    repoRoot: input.repoRoot,
    prompt,
    codexBin: input.codexBin,
  }));
  const rawOutput = [command.stdout, command.stderr].filter(Boolean).join("\n");

  if (command.exitCode !== 0) {
    return {
      status: "failed",
      command,
      rawOutput,
      classification,
      failure: `orchestrator command failed with exit ${command.exitCode}`,
    };
  }

  try {
    const payload = parseOrchestratorPlanPayload(rawOutput);
    return {
      status: payload.questions.length ? "questions" : "planned",
      command,
      rawOutput,
      payload,
      classification,
    };
  } catch (err) {
    return {
      status: "failed",
      command,
      rawOutput,
      classification,
      failure: err instanceof Error ? err.message : String(err),
    };
  }
}

export function planningMemoryFromContextResults(
  results: ContextSearchResult[],
  options: { projectId?: string; limit?: number } = {},
): PlanningMemorySnippet[] {
  const limit = options.limit ?? 6;
  const snippets: PlanningMemorySnippet[] = [];
  for (const result of results) {
    if (snippets.length >= limit) break;
    if (result.status === "missing" || result.status === "malformed") continue;
    if (options.projectId && !resultMatchesProject(result, options.projectId)) continue;
    const citations = result.citations.map((citation) => ({
      kind: citation.kind as OrchestratorContextCitation["kind"],
      id: citation.id,
      ancestry: citation.ancestry,
    }));
    if (citations.length === 0) continue;
    snippets.push({
      id: result.id,
      kind: planningMemoryKind(result),
      status: result.status,
      title: oneLine(result.title),
      snippet: oneLine(result.snippet),
      citations,
    });
  }
  return snippets;
}

export async function runOrchestratorSynthesis(input: {
  plan: OrchestratorPlanRecord;
  request?: OrchestrationRequestRecord;
  actions: RemoteActionRecord[];
  runLogs: WorkerRunLog[];
  agent: AgentProfile;
  repoRoot: string;
  codexBin?: string;
}): Promise<OrchestratorSynthesisRunResult> {
  const prompt = buildOrchestratorSynthesisPrompt(input);
  const command = await runCommand(buildCodexOrchestratorCommand({
    agent: input.agent,
    repoRoot: input.repoRoot,
    prompt,
    codexBin: input.codexBin,
  }));
  const rawOutput = [command.stdout, command.stderr].filter(Boolean).join("\n");

  if (command.exitCode !== 0) {
    return { command, rawOutput, failure: `orchestrator synthesis command failed with exit ${command.exitCode}` };
  }

  try {
    return { command, rawOutput, payload: parseOrchestratorSynthesisPayload(rawOutput) };
  } catch (err) {
    return { command, rawOutput, failure: err instanceof Error ? err.message : String(err) };
  }
}

export function buildOrchestratorQuestionDraftPrompt(input: {
  blocker: string;
  context?: string;
  subject?: { type: string; id: string };
}): string {
  return [
    "You are the Samantha Orchestrator Agent in bounded question-drafting mode.",
    "Draft one concise BK decision question for an ambiguous blocker that Samantha already linked to a concrete subject.",
    "If ambiguity is still inside an unmaterialized plan, plain ORCHESTRATOR_PLAN.questions are sufficient; do not use question-draft for that case.",
    "Do not edit files. Do not create tasks. Do not dispatch workers. Do not run merge, push, or cleanup commands.",
    "Do not claim that you changed durable state. The deterministic CEO office may validate your draft and store it as a decision item.",
    "Do not choose an option, resolve the blocker, approve execution, or advance work.",
    "Keep the title under 80 characters, the prompt under 240 characters, and ask exactly one subject-linked question.",
    "Use 2 or 3 concise options. Options must not be approve/go/proceed/execute/dispatch/materialize/merge/push instructions.",
    "Include the concrete risk of leaving the blocker unresolved.",
    "",
    `Blocker: ${input.blocker}`,
    input.context ? `Context: ${input.context}` : "Context: none",
    input.subject ? `Subject: ${input.subject.type}:${input.subject.id}` : "Subject: none",
    "",
    "Return a concise Korean explanation, then include exactly one machine-readable payload.",
    "The payload must start with `ORCHESTRATOR_QUESTION_DRAFT:` followed by a strict JSON object.",
    "",
    "Payload shape:",
    JSON.stringify(
      {
        title: "short decision title",
        prompt: "single question BK can answer",
        options: ["answer option", "revise", "cancel"],
        risk: "risk if BK does not decide",
        userMessage: "Korean message to show BK",
      },
      null,
      2,
    ),
  ].join("\n");
}

export async function runOrchestratorQuestionDraft(input: {
  blocker: string;
  context?: string;
  subject?: { type: string; id: string };
  agent: AgentProfile;
  repoRoot: string;
  codexBin?: string;
}): Promise<OrchestratorQuestionDraftRunResult> {
  const prompt = buildOrchestratorQuestionDraftPrompt(input);
  const command = await runCommand(buildCodexOrchestratorCommand({
    agent: input.agent,
    repoRoot: input.repoRoot,
    prompt,
    codexBin: input.codexBin,
  }));
  const rawOutput = [command.stdout, command.stderr].filter(Boolean).join("\n");

  if (command.exitCode !== 0) {
    return { command, rawOutput, failure: `orchestrator question draft command failed with exit ${command.exitCode}` };
  }

  try {
    return { command, rawOutput, payload: parseOrchestratorQuestionDraftPayload(rawOutput) };
  } catch (err) {
    return { command, rawOutput, failure: err instanceof Error ? err.message : String(err) };
  }
}

export function buildOrchestratorMemorySynthesisPrompt(input: {
  evidence: MemorySynthesisEvidence[];
  projectId?: string;
  goalId?: string;
  workItemId?: string;
}): string {
  const evidenceLines = input.evidence.flatMap((item, index) => {
    const ancestry = item.citation.ancestry?.mode === "assigned"
      ? ` project=${item.citation.ancestry.projectId} goal=${item.citation.ancestry.goalId} workItem=${item.citation.ancestry.workItemId}`
      : ` ancestry=${item.citation.ancestry?.mode ?? "none"}`;
    return [
      `- source[${index}]: kind=${item.citation.kind} id=${item.citation.id} status=${item.status ?? "ok"}${ancestry}`,
      item.staleReason ? `  staleReason=${item.staleReason}` : "",
      `  snippet=${oneLine(item.snippet) || "(empty)"}`,
    ].filter(Boolean);
  });

  return [
    "You are the Samantha Orchestrator Agent in bounded memory-synthesis mode.",
    "Your job is to propose concise memory review candidates from Samantha-provided source evidence only.",
    "Do not edit files. Do not write memory. Do not overwrite project briefs, SOPs, skills, profiles, policies, tasks, actions, runs, or reports.",
    "Do not dispatch workers. Do not run merge, push, cleanup, recovery, connector, secret, routine, budget, or policy commands.",
    "Do not claim any execution authority. Do not claim that memory was accepted, activated, approved, written, or promoted.",
    "The deterministic CEO office may validate your payload and store valid proposals only as pending_review candidates.",
    "A later deterministic memory write gate and explicit review must approve any durable memory update.",
    "Cite only the exact source kind/id pairs listed below. Do not invent sources, ids, citations, files, decisions, runs, or reports.",
    "If evidence is stale or conflicting, include a staleSourceNotes entry and keep confidence conservative.",
    "If a proposal changes future agent behavior, SOPs, skills, preferences, policy interpretation, or operating defaults, set behaviorImpact to `behavior_change` and behaviorImpactReviewRequired to true.",
    "Never propose loosening safety policy, writer caps, worktree allocation, dispatch, merge, push, cleanup, recovery, approval, project, connector, secret, routine, or budget gates.",
    "",
    "Requested synthesis scope:",
    input.projectId ? `- projectId: ${input.projectId}` : "- projectId: none",
    input.goalId ? `- goalId: ${input.goalId}` : "- goalId: none",
    input.workItemId ? `- workItemId: ${input.workItemId}` : "- workItemId: none",
    "",
    "Samantha-provided source evidence:",
    ...(evidenceLines.length ? evidenceLines : ["- none"]),
    "",
    "Return a concise Korean explanation, then include exactly one machine-readable payload.",
    "The payload must start with `ORCHESTRATOR_MEMORY_SYNTHESIS:` followed by a strict JSON object.",
    "Keep `proposals` empty if the evidence is insufficient.",
    "",
    "Payload shape:",
    JSON.stringify(
      {
        summary: "short Korean summary",
        proposals: [
          {
            proposedMemoryKind: "preference|strategy_context|known_risk|project_brief|decision_summary|artifact_reference|sop_document|skill_document",
            scope: { type: "project", projectId: "project id" },
            summary: "one-line candidate summary",
            proposedContent: "candidate text for human review",
            citations: [{ kind: "operator_report", id: "stable-source-id" }],
            confidence: 0.7,
            staleSourceNotes: [],
            behaviorImpact: "none|behavior_change",
            behaviorImpactReviewRequired: false,
          },
        ],
        rejectedEvidence: ["why evidence was not enough"],
        userMessage: "Korean message to show BK",
      },
      null,
      2,
    ),
  ].join("\n");
}

export async function runOrchestratorMemorySynthesis(input: {
  evidence: MemorySynthesisEvidence[];
  agent: AgentProfile;
  repoRoot: string;
  createdAt: string;
  projectId?: string;
  goalId?: string;
  workItemId?: string;
  synthesisRunId?: string;
  codexBin?: string;
}): Promise<OrchestratorMemorySynthesisRunResult> {
  const prompt = buildOrchestratorMemorySynthesisPrompt(input);
  const command = await runCommand(buildCodexOrchestratorCommand({
    agent: input.agent,
    repoRoot: input.repoRoot,
    prompt,
    codexBin: input.codexBin,
  }));
  const rawOutput = [command.stdout, command.stderr].filter(Boolean).join("\n");

  if (command.exitCode !== 0) {
    return { command, rawOutput, failure: `orchestrator memory synthesis command failed with exit ${command.exitCode}` };
  }

  try {
    const payload = parseOrchestratorMemorySynthesisPayload(rawOutput, { evidence: input.evidence });
    const candidates = memorySynthesisPayloadToLearningCandidates(payload, {
      agent: input.agent,
      createdAt: input.createdAt,
      synthesisRunId: input.synthesisRunId,
    });
    return { command, rawOutput, payload, candidates };
  } catch (err) {
    return { command, rawOutput, failure: err instanceof Error ? err.message : String(err) };
  }
}

export function parseOrchestratorPlanPayload(output: string): OrchestratorPlanPayload {
  const messages = extractAgentMessages(output);
  const candidates = [...messages.slice().reverse(), output];
  let parseError: unknown;
  for (const candidate of candidates) {
    const json = extractMarkedJson(candidate, "ORCHESTRATOR_PLAN:");
    if (!json) continue;
    try {
      return validatePlanPayload(parseMarkedJsonObject(json));
    } catch (err) {
      parseError = err;
    }
  }
  if (parseError) throw parseError;
  throw new Error("ORCHESTRATOR_PLAN payload not found");
}

export function parseOrchestratorSynthesisPayload(output: string): OrchestratorSynthesisPayload {
  const messages = extractAgentMessages(output);
  const candidates = [...messages.slice().reverse(), output];
  let parseError: unknown;
  for (const candidate of candidates) {
    const json = extractMarkedJson(candidate, "ORCHESTRATOR_SYNTHESIS:");
    if (!json) continue;
    try {
      return validateSynthesisPayload(parseMarkedJsonObject(json));
    } catch (err) {
      parseError = err;
    }
  }
  if (parseError) throw parseError;
  throw new Error("ORCHESTRATOR_SYNTHESIS payload not found");
}

export function parseOrchestratorQuestionDraftPayload(output: string): OrchestratorQuestionDraftPayload {
  const messages = extractAgentMessages(output);
  const candidates = [...messages.slice().reverse(), output];
  let parseError: unknown;
  for (const candidate of candidates) {
    const json = extractMarkedJson(candidate, "ORCHESTRATOR_QUESTION_DRAFT:");
    if (!json) continue;
    try {
      return validateQuestionDraftPayload(parseMarkedJsonObject(json));
    } catch (err) {
      parseError = err;
    }
  }
  if (parseError) throw parseError;
  throw new Error("ORCHESTRATOR_QUESTION_DRAFT payload not found");
}

export function parseOrchestratorMemorySynthesisPayload(
  output: string,
  options: { evidence: MemorySynthesisEvidence[] },
): OrchestratorMemorySynthesisPayload {
  const messages = extractAgentMessages(output);
  const candidates = [...messages.slice().reverse(), output];
  let parseError: unknown;
  for (const candidate of candidates) {
    const json = extractMarkedJson(candidate, "ORCHESTRATOR_MEMORY_SYNTHESIS:");
    if (!json) continue;
    try {
      return validateMemorySynthesisPayload(parseMarkedJsonObject(json), options);
    } catch (err) {
      parseError = err;
    }
  }
  if (parseError) throw parseError;
  throw new Error("ORCHESTRATOR_MEMORY_SYNTHESIS payload not found");
}

export function memorySynthesisPayloadToLearningCandidates(
  payload: OrchestratorMemorySynthesisPayload,
  input: { agent: AgentProfile; createdAt: string; synthesisRunId?: string },
): LearningCandidateRecord[] {
  return payload.proposals.map((proposal, index) => parseLearningCandidateRecord({
    schemaVersion: 1,
    id: buildLearningCandidateId({
      createdAt: input.createdAt,
      kind: "memory_synthesis",
      summary: proposal.summary,
      disambiguator: index + 1,
    }),
    kind: "memory_synthesis",
    proposedMemoryKind: proposal.proposedMemoryKind,
    claimKind: "llm_summary",
    scope: proposal.scope,
    summary: proposal.summary,
    proposedContent: proposal.proposedContent,
    evidence: proposal.citations,
    confidence: proposal.confidence,
    attribution: { kind: "llm", agentId: input.agent.id, model: input.agent.model },
    status: "pending_review",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    ...(proposal.staleSourceNotes.length ? { staleSourceNotes: proposal.staleSourceNotes } : {}),
    behaviorImpact: proposal.behaviorImpact,
    behaviorImpactReviewRequired: proposal.behaviorImpactReviewRequired,
    ...(input.synthesisRunId ? { synthesisRunId: input.synthesisRunId } : {}),
  }));
}

function projectProfileLines(profiles: ProjectProfile[]): string[] {
  if (profiles.length === 0) return ["- none"];
  return profiles.map((profile) => {
    const scopes = (profile.remoteScopes ?? [])
      .map((scope) => `${scope.id}:${scope.resultMode ?? "write"}:${scope.targetFiles.join(",")}`)
      .join("; ");
    const allowedScopes = profile.safetyPolicy?.allowedRemoteScopeIds?.join(",") || "all declared scopes";
    const dispatchPrerequisites = profile.safetyPolicy?.dispatchPrerequisites?.join(",") || "none";
    const hostOnly = profile.safetyPolicy?.hostOnlyVerificationNeeds?.join(",") || "none";
    return `- ${profile.id}: repo=${profile.repoRoot}; keywords=${(profile.keywords ?? []).join(",") || "none"}; scopes=${scopes || "none"}; allowedScopes=${allowedScopes}; forbidden=${projectEffectiveForbiddenChanges(profile).join(",") || "none"}; verify=${profile.verifyCommands.join(",") || "none"}; dispatchPrerequisites=${dispatchPrerequisites}; hostOnlyVerification=${hostOnly}`;
  });
}

function selectedPlanningMemory(snippets: PlanningMemorySnippet[]): PlanningMemorySnippet[] {
  const seen = new Set<string>();
  const selected: PlanningMemorySnippet[] = [];
  for (const snippet of snippets) {
    if (snippet.status !== "ok" && snippet.status !== "stale" && snippet.status !== "conflict") continue;
    if (!oneLine(snippet.snippet) || snippet.citations.length === 0) continue;
    const key = `${snippet.kind}:${snippet.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      ...snippet,
      title: oneLine(snippet.title),
      snippet: oneLine(snippet.snippet),
    });
    if (selected.length >= 6) break;
  }
  return selected;
}

function planningMemoryLines(snippets: PlanningMemorySnippet[]): string[] {
  return snippets.map((snippet, index) => {
    const citations = snippet.citations
      .map((citation) => `${citation.kind}:${citation.id}`)
      .join(", ");
    return `- memory[${index}] kind=${snippet.kind} status=${snippet.status} id=${snippet.id} title=${snippet.title} citations=${citations} snippet=${snippet.snippet}`;
  });
}

function resultMatchesProject(result: ContextSearchResult, projectId: string): boolean {
  if (result.sourceKind === "conversation_memory") return true;
  if (!result.ancestry || result.ancestry.mode !== "assigned") return false;
  return result.ancestry.projectId === projectId;
}

function planningMemoryKind(result: ContextSearchResult): PlanningMemorySnippetKind {
  if (result.kind === "conversation_memory") return "conversation_memory";
  if (result.memoryKind === "preference") return "preference";
  if (result.memoryKind === "known_risk") return "known_risk";
  if (result.memoryKind === "strategy_context") return "strategy_context";
  if (result.memoryKind === "sop_document") return "sop_document";
  if (result.memoryKind === "skill_document") return "skill_document";
  if (result.kind === "decision_summary") return "decision_summary";
  if (result.kind === "project_brief") return "project_brief";
  if (result.kind === "operator_report") return "operator_report";
  if (result.kind === "ceo_report") return "ceo_report";
  if (result.kind === "report_artifact") return "report_artifact";
  return "report_artifact";
}

function buildOrchestratorSynthesisPrompt(input: {
  plan: OrchestratorPlanRecord;
  request?: OrchestrationRequestRecord;
  actions: RemoteActionRecord[];
  runLogs: WorkerRunLog[];
}): string {
  const runLogForAction = (action: RemoteActionRecord) =>
    input.runLogs.find((log) => log.runId === action.result?.runId || log.task.id === action.taskId);
  const evidenceLines = input.actions.flatMap((action) => {
    const runLog = runLogForAction(action);
    const changedFiles = runLog?.result.evaluation?.changedFiles ?? runLog?.result.commit?.files ?? [];
    const reportArtifacts = runLog?.task.resultMode === "report" ? changedFiles : [];
    const failedVerify = runLog?.result.evaluation?.verifyResults
      .filter((result) => result.exitCode !== 0)
      .map((result) => `${result.command} exited ${result.exitCode}${result.stderr ? ` stderr=${result.stderr.replace(/\s+/g, " ").trim()}` : ""}`) ?? [];
    const harnessNote = runLog?.result.evaluation?.harness?.note ?? "";
    return [
      `- ${action.taskId}: status=${action.status} pass=${String(action.result?.pass ?? false)} outcome=${action.result?.outcome ?? "unknown"} failure=${action.result?.failure ?? ""}`,
      `  agent=${action.targetAgent} mode=${runLog?.task.resultMode ?? "unknown"} canonicalRepoRoot=${action.repoRoot}`,
      action.result?.runLogPath ? `  runLog=${action.result.runLogPath}` : "  runLog=none",
      harnessNote ? `  harnessNote=${harnessNote}` : "",
      changedFiles.length ? `  changedFiles=${changedFiles.join(",")}` : "  changedFiles=none",
      reportArtifacts.length ? `  reportArtifacts=${reportArtifacts.join(",")}` : "  reportArtifacts=none",
      failedVerify.length ? `  failedVerify=${failedVerify.join(" | ")}` : "  failedVerify=none",
    ].filter(Boolean);
  });

  return [
    "You are the Samantha Orchestrator Agent in final synthesis mode.",
    "Do not edit files. Do not dispatch workers. Do not run merge, push, or cleanup commands.",
    "Do not claim that you changed durable state. Summarize only the evidence provided by Samantha.",
    "Summarize the completed worker team result for BK in Korean and recommend the next action from Samantha evidence only.",
    "Do not invent changed files, report artifacts, verification results, run logs, commits, decisions, or statuses not listed below.",
    "",
    `Request: ${input.request?.text ?? input.plan.requestId}`,
    `Plan: ${input.plan.id}`,
    input.plan.ancestry?.mode === "assigned"
      ? `Ancestry: project=${input.plan.ancestry.projectId} goal=${input.plan.ancestry.goalId} workItem=${input.plan.ancestry.workItemId}`
      : `Ancestry: ${input.plan.ancestry?.mode ?? "legacy"}`,
    input.plan.payload ? `Original plan summary: ${input.plan.payload.summary}` : "Original plan summary: missing",
    "",
    "Samantha-provided evidence:",
    ...(evidenceLines.length ? evidenceLines : ["- none"]),
    "",
    "Return a concise Korean synthesis, then include exactly one machine-readable payload.",
    "The payload must start with `ORCHESTRATOR_SYNTHESIS:` followed by a strict JSON object.",
    "Set `outcome` to exactly one of `pass`, `mixed`, `failed`, `blocked`, or `needs-BK`.",
    "`nextActions` must contain exactly one supported safe Telegram command, such as `/now`, `/recover`, `/check`, or `/problems`.",
    "",
    "Payload shape:",
    JSON.stringify(
      {
        outcome: "pass|mixed|failed|blocked|needs-BK",
        summary: "short Korean summary",
        nextActions: ["텔레그램: /recover"],
        risks: ["risk or follow-up"],
        userMessage: "Korean Telegram message to show BK",
      },
      null,
      2,
    ),
  ].join("\n");
}

function extractAgentMessages(output: string): string[] {
  const messages: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const eventStart = trimmed.indexOf("{");
    if (eventStart === -1) continue;
    try {
      const event = JSON.parse(trimmed.slice(eventStart)) as {
        type?: string;
        text?: string;
        item?: { type?: string; text?: string };
      };
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        messages.push(event.item.text);
      } else if (event.type === "agent_message" && typeof event.text === "string") {
        messages.push(event.text);
      }
    } catch {
      // Codex may emit non-JSON text through stderr.
    }
  }
  return messages;
}

function parseMarkedJsonObject(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (err) {
    const decoded = decodeEscapedJsonFragment(json);
    if (decoded === undefined) throw err;
    return JSON.parse(decoded);
  }
}

function decodeEscapedJsonFragment(json: string): string | undefined {
  if (!json.includes('\\"') && !json.includes("\\n")) return undefined;
  try {
    const decoded = JSON.parse(`"${json}"`);
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function extractMarkedJson(text: string, marker: string): string | undefined {
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex === -1) return undefined;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = inString;
      continue;
    }
    if (char === '"' && text[index - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function validatePlanPayload(raw: unknown): OrchestratorPlanPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ORCHESTRATOR_PLAN must be an object");
  }
  const value = raw as Record<string, unknown>;
  const payload = {
    summary: requiredString(value.summary, "summary"),
    assumptions: stringArray(value.assumptions, "assumptions"),
    questions: stringArray(value.questions, "questions"),
    prerequisites: value.prerequisites === undefined ? undefined : stringArray(value.prerequisites, "prerequisites"),
    blockers: value.blockers === undefined ? undefined : stringArray(value.blockers, "blockers"),
    scope: stringArray(value.scope, "scope"),
    nonScope: stringArray(value.nonScope, "nonScope"),
    risks: stringArray(value.risks, "risks"),
    selectedApproach: optionalString(value.selectedApproach, "selectedApproach"),
    rejectedAlternatives: optionalRejectedAlternativeArray(value.rejectedAlternatives, "rejectedAlternatives"),
    tradeoffs: value.tradeoffs === undefined ? undefined : stringArray(value.tradeoffs, "tradeoffs"),
    recommendationTrace: optionalRecommendationTraceArray(value.recommendationTrace, "recommendationTrace"),
    tasks: taskArray(value.tasks, "tasks"),
    batches: batchArray(value.batches, "batches"),
    userMessage: requiredString(value.userMessage, "userMessage"),
  };
  validatePlanPayloadConsistency(payload);
  return payload;
}

function validateSynthesisPayload(raw: unknown): OrchestratorSynthesisPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ORCHESTRATOR_SYNTHESIS must be an object");
  }
  const value = raw as Record<string, unknown>;
  const outcome = requiredString(value.outcome, "outcome");
  if (outcome !== "pass" && outcome !== "mixed" && outcome !== "failed" && outcome !== "blocked" && outcome !== "needs-BK") {
    throw new Error("outcome must be pass, mixed, failed, blocked, or needs-BK");
  }
  const nextActions = stringArray(value.nextActions, "nextActions");
  validateSynthesisNextActions(nextActions);
  return {
    outcome,
    summary: requiredString(value.summary, "summary"),
    nextActions,
    risks: stringArray(value.risks, "risks"),
    userMessage: requiredString(value.userMessage, "userMessage"),
  };
}

const safeSynthesisTelegramCommands = new Set([
  "/now",
  "/plan",
  "/plan_current",
  "/go",
  "/recover",
  "/check",
  "/problems",
  "/approve",
  "/cancel",
]);

function validateSynthesisNextActions(nextActions: string[]): void {
  if (nextActions.length !== 1) throw new Error("nextActions must contain exactly one safe Telegram command");
  const commands = nextActions[0]?.match(/\/[A-Za-z0-9_-]+/g) ?? [];
  const uniqueCommands = Array.from(new Set(commands));
  if (uniqueCommands.length !== 1 || !safeSynthesisTelegramCommands.has(uniqueCommands[0])) {
    throw new Error("nextActions must contain exactly one safe Telegram command");
  }
}

function validateQuestionDraftPayload(raw: unknown): OrchestratorQuestionDraftPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ORCHESTRATOR_QUESTION_DRAFT must be an object");
  }
  const value = raw as Record<string, unknown>;
  const options = questionDraftOptions(stringArray(value.options, "options"));
  return {
    title: conciseString(value.title, "title", 80),
    prompt: conciseString(value.prompt, "prompt", 240),
    options,
    risk: conciseString(value.risk, "risk", 240),
    userMessage: conciseString(value.userMessage, "userMessage", 240),
  };
}

const memorySynthesisForbiddenMutationFields = new Set([
  "memory",
  "memoryWrite",
  "memoryPatch",
  "memoryMutation",
  "durableMemoryEntry",
  "projectBriefWrite",
  "projectBriefPatch",
  "sopWrite",
  "sopPatch",
  "skillWrite",
  "skillPatch",
  "profileWrite",
  "profilePatch",
  "policyWrite",
  "policyPatch",
  "connectorGrant",
  "secretGrant",
  "taskWrite",
  "taskPatch",
  "actionWrite",
  "actionPatch",
  "runWrite",
  "runPatch",
  "dispatch",
  "merge",
  "push",
  "cleanup",
]);

const behaviorChangingPatterns = [
  /\b(?:must|should|always|never|require|prefer)\b.*\b(?:agent|worker|sop|skill|profile|policy|dispatch|merge|push|cleanup|approval|default|gate)\b/i,
  /\b(?:agent|worker|sop|skill|profile|policy|dispatch|merge|push|cleanup|approval|default|gate)\b.*\b(?:must|should|always|never|require|prefer)\b/i,
  /(앞으로|항상|절대|기본값|정책|프로필|승인|게이트|디스패치|머지|푸시|클린업|SOP|스킬)/i,
];

const blockedExecutionAuthorityPatterns = [
  /\b(?:override|bypass|loosen|disable|skip)\b.*\b(?:safety|policy|approval|gate|writerCap|writer cap)\b/i,
  /\b(?:dispatch|merge|push|cleanup|recover|approve|activate|write memory|overwrite)\b.*\b(?:without|directly|automatically|no approval)\b/i,
  /(승인 없이|게이트 없이|직접 (?:디스패치|머지|푸시|클린업|복구|승인|활성화|메모리 쓰기)|안전 정책.*(?:우회|완화|무시))/i,
];

function validateMemorySynthesisPayload(
  raw: unknown,
  options: { evidence: MemorySynthesisEvidence[] },
): OrchestratorMemorySynthesisPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ORCHESTRATOR_MEMORY_SYNTHESIS must be an object");
  }
  const value = raw as Record<string, unknown>;
  const directMutation = forbiddenMemorySynthesisFields(value);
  if (directMutation.length > 0) throw new Error(directMutation[0]);
  const proposals = memorySynthesisProposalArray(value.proposals, "proposals", options);
  return {
    summary: requiredString(value.summary, "summary"),
    proposals,
    rejectedEvidence: stringArray(value.rejectedEvidence, "rejectedEvidence"),
    userMessage: requiredString(value.userMessage, "userMessage"),
  };
}

function memorySynthesisProposalArray(
  value: unknown,
  field: string,
  options: { evidence: MemorySynthesisEvidence[] },
): OrchestratorMemorySynthesisProposal[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => {
    const label = `${field}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label} must be an object`);
    }
    const proposal = item as Record<string, unknown>;
    const directMutation = forbiddenMemorySynthesisFields(proposal, label);
    if (directMutation.length > 0) throw new Error(directMutation[0]);
    const proposedMemoryKind = parseMemoryEntryKind(proposal.proposedMemoryKind);
    const citations = memorySynthesisCitations(proposal.citations, `${label}.citations`, options);
    const staleSourceNotes = stringArray(proposal.staleSourceNotes, `${label}.staleSourceNotes`).map(oneLine);
    const behaviorImpact = memorySynthesisBehaviorImpact(proposal.behaviorImpact, `${label}.behaviorImpact`);
    const behaviorImpactReviewRequired = proposal.behaviorImpactReviewRequired;
    if (typeof behaviorImpactReviewRequired !== "boolean") {
      throw new Error(`${label}.behaviorImpactReviewRequired must be a boolean`);
    }
    const confidence = memorySynthesisConfidence(proposal.confidence, `${label}.confidence`);
    const summary = requiredString(proposal.summary, `${label}.summary`);
    const proposedContent = requiredString(proposal.proposedContent, `${label}.proposedContent`);
    const scope = memorySynthesisScope(proposal.scope, `${label}.scope`);
    validateMemorySynthesisBehavior({
      label,
      proposedMemoryKind,
      summary,
      proposedContent,
      citations,
      staleSourceNotes,
      behaviorImpact,
      behaviorImpactReviewRequired,
      evidence: options.evidence,
    });

    return {
      proposedMemoryKind,
      scope,
      summary: oneLine(summary),
      proposedContent: oneLine(proposedContent),
      citations,
      confidence,
      staleSourceNotes,
      behaviorImpact,
      behaviorImpactReviewRequired,
    };
  });
}

function memorySynthesisCitations(
  value: unknown,
  label: string,
  options: { evidence: MemorySynthesisEvidence[] },
): MemorySourceCitation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must include at least one source citation`);
  }
  return value.map((citation, index) => {
    const citationLabel = `${label}[${index}]`;
    const violations = validateMemorySourceCitation(citation as MemorySourceCitation, citationLabel);
    if (violations.length > 0) throw new Error(violations[0]);
    const normalized = citation as MemorySourceCitation;
    if (!evidenceContainsCitation(options.evidence, normalized)) {
      throw new Error(`${citationLabel} was not provided by Samantha evidence: ${normalized.kind}:${normalized.id}`);
    }
    const source = options.evidence.find((item) => item.citation.kind === normalized.kind && item.citation.id === normalized.id);
    if (source?.status === "missing" || source?.status === "malformed") {
      throw new Error(`${citationLabel} cannot cite ${source.status} evidence: ${normalized.kind}:${normalized.id}`);
    }
    if (
      normalized.ancestry &&
      source?.citation.ancestry &&
      JSON.stringify(normalized.ancestry) !== JSON.stringify(source.citation.ancestry)
    ) {
      throw new Error(`${citationLabel}.ancestry must match Samantha-provided evidence`);
    }
    return {
      kind: normalized.kind,
      id: normalized.id,
      ancestry: normalized.ancestry,
    };
  });
}

function memorySynthesisScope(value: unknown, label: string): LearningCandidateScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const scope = value as Record<string, unknown>;
  if (scope.type === "project") {
    return { type: "project", projectId: requiredStableId(scope.projectId, `${label}.projectId`) };
  }
  if (scope.type === "cross_project") {
    if (!Array.isArray(scope.projectIds) || scope.projectIds.length === 0) {
      throw new Error(`${label}.projectIds must include at least one project id`);
    }
    const projectIds = scope.projectIds.map((projectId, index) => requiredStableId(projectId, `${label}.projectIds[${index}]`));
    if (new Set(projectIds).size !== projectIds.length) throw new Error(`${label}.projectIds must be unique`);
    return { type: "cross_project", projectIds: projectIds.slice().sort() };
  }
  throw new Error(`${label}.type is invalid: ${String(scope.type ?? "(empty)")}`);
}

const planningCitationKinds = new Set<OrchestratorContextCitation["kind"]>([
  "decision",
  "governance_event",
  "orchestrator_plan",
  "task",
  "remote_action",
  "run_lifecycle",
  "run_log",
  "recovery_context",
  "project_profile",
  "agent_profile",
  "safety_policy",
  "budget_observation",
  "ceo_status",
  "ceo_turn",
  "conversation_memory",
  "ceo_report",
  "operator_report",
  "dashboard_view",
  "telegram_summary",
  "report_artifact",
  "decision_history_summary",
  "project_brief",
  "memory",
]);

function optionalRecommendationTraceArray(value: unknown, field: string): OrchestratorRecommendationTrace[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => {
    const label = `${field}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} must be an object`);
    const trace = item as Record<string, unknown>;
    const citations = planningCitations(trace.citations, `${label}.citations`);
    return {
      recommendation: requiredString(trace.recommendation, `${label}.recommendation`),
      reason: requiredString(trace.reason, `${label}.reason`),
      citations,
    };
  });
}

function planningCitations(value: unknown, label: string): OrchestratorContextCitation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must include at least one source citation`);
  }
  return value.map((citation, index) => {
    const citationLabel = `${label}[${index}]`;
    if (!citation || typeof citation !== "object" || Array.isArray(citation)) {
      throw new Error(`${citationLabel} must be an object`);
    }
    const raw = citation as Record<string, unknown>;
    if (!planningCitationKinds.has(raw.kind as OrchestratorContextCitation["kind"])) {
      throw new Error(`${citationLabel}.kind is invalid: ${String(raw.kind ?? "(empty)")}`);
    }
    return {
      kind: raw.kind as OrchestratorContextCitation["kind"],
      id: requiredStableId(raw.id, `${citationLabel}.id`),
      ancestry: parseOptionalWorkItemAncestry(raw.ancestry),
    };
  });
}

function memorySynthesisBehaviorImpact(value: unknown, label: string): LearningCandidateBehaviorImpact {
  if (value === "none" || value === "behavior_change") return value;
  throw new Error(`${label} must be none or behavior_change`);
}

function memorySynthesisConfidence(value: unknown, label: string): number {
  if (typeof value !== "number" || value <= 0 || value > 1) {
    throw new Error(`${label} must be greater than 0 and less than or equal to 1`);
  }
  return value;
}

function validateMemorySynthesisBehavior(input: {
  label: string;
  proposedMemoryKind: MemoryEntryKind;
  summary: string;
  proposedContent: string;
  citations: MemorySourceCitation[];
  staleSourceNotes: string[];
  behaviorImpact: LearningCandidateBehaviorImpact;
  behaviorImpactReviewRequired: boolean;
  evidence: MemorySynthesisEvidence[];
}): void {
  const text = `${input.summary}\n${input.proposedContent}`;
  if (blockedExecutionAuthorityPatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${input.label} claims execution authority that memory synthesis cannot grant`);
  }
  const behaviorChanging =
    input.proposedMemoryKind === "sop_document" ||
    input.proposedMemoryKind === "skill_document" ||
    behaviorChangingPatterns.some((pattern) => pattern.test(text));
  if (behaviorChanging && (input.behaviorImpact !== "behavior_change" || input.behaviorImpactReviewRequired !== true)) {
    throw new Error(`${input.label} behavior-changing claims require behaviorImpact=behavior_change and behaviorImpactReviewRequired=true`);
  }
  if (input.behaviorImpact === "behavior_change" && input.behaviorImpactReviewRequired !== true) {
    throw new Error(`${input.label} behavior-changing claims require behaviorImpact=behavior_change and behaviorImpactReviewRequired=true`);
  }
  const staleCitations = input.citations.filter((citation) =>
    input.evidence.some((item) =>
      item.citation.kind === citation.kind &&
      item.citation.id === citation.id &&
      (item.status === "stale" || item.status === "conflict")
    )
  );
  if (staleCitations.length > 0 && input.staleSourceNotes.length === 0) {
    throw new Error(`${input.label}.staleSourceNotes must explain stale or conflicting source evidence`);
  }
}

function evidenceContainsCitation(evidence: MemorySynthesisEvidence[], citation: MemorySourceCitation): boolean {
  return evidence.some((item) => item.citation.kind === citation.kind && item.citation.id === citation.id);
}

function forbiddenMemorySynthesisFields(value: unknown, label = "memory synthesis payload"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenMemorySynthesisFields(item, `${label}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    const current = `${label}.${key}`;
    const violations = memorySynthesisForbiddenMutationFields.has(key)
      ? [`${current} is not allowed; memory synthesis can only produce review candidates`]
      : [];
    return [...violations, ...forbiddenMemorySynthesisFields(nested, current)];
  });
}

function requiredStableId(value: unknown, field: string): string {
  const text = requiredString(value, field);
  const normalized = oneLine(text);
  if (normalized !== text) throw new Error(`${field} must be normalized`);
  if (/[\\/]/.test(normalized)) throw new Error(`${field} must be a stable id, not a path`);
  return normalized;
}

function validatePlanPayloadConsistency(payload: OrchestratorPlanPayload): void {
  const proposalIds = new Set(payload.tasks.map((task) => task.id));
  const blockers = [...(payload.prerequisites ?? []), ...(payload.blockers ?? [])];
  if (proposalIds.size !== payload.tasks.length) throw new Error("task ids must be unique");
  if (payload.questions.length > 0 && payload.tasks.length > 0) {
    throw new Error("plans with questions must not include task proposals");
  }
  if (payload.questions.length > 0 && payload.batches.length > 0) {
    throw new Error("plans with questions must not include batches");
  }
  if (blockers.length > 0 && payload.tasks.length > 0) {
    throw new Error("plans with prerequisites or blockers must not include task proposals");
  }
  if (blockers.length > 0 && payload.batches.length > 0) {
    throw new Error("plans with prerequisites or blockers must not include batches");
  }
  if (payload.questions.length === 0 && payload.tasks.length === 0 && blockers.length === 0) {
    throw new Error("planned payloads must include at least one task, blocking questions, prerequisites, or blockers");
  }
  for (const [index, batch] of payload.batches.entries()) {
    for (const taskId of batch) {
      if (!proposalIds.has(taskId)) throw new Error(`batches[${index}] references unknown task proposal: ${taskId}`);
    }
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function conciseString(value: unknown, field: string, maxLength: number): string {
  const text = oneLine(requiredString(value, field));
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or less`);
  return text;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return value;
}

const executionAdvancingQuestionOptionPatterns = [
  /^\/?(?:approve|go)\b/i,
  /^(?:proceed|execute|dispatch|materialize|merge|push)\b/i,
  /^(승인|진행|실행|머지|푸시)(?:\s|$|[:：-])/i,
];

function questionDraftOptions(options: string[]): string[] {
  if (options.length < 2 || options.length > 3) throw new Error("options must contain 2 or 3 choices");

  const normalized = options.map(oneLine);
  if (normalized.some((option) => !option)) throw new Error("options must be non-empty strings");
  if (new Set(normalized).size !== normalized.length) throw new Error("options must be unique");
  if (normalized.some((option) => option.length > 48)) throw new Error("options must be 48 characters or less");
  if (normalized.some((option) => executionAdvancingQuestionOptionPatterns.some((pattern) => pattern.test(option)))) {
    throw new Error("options must not authorize execution");
  }

  return normalized;
}

function batchArray(value: unknown, field: string): string[][] {
  if (
    !Array.isArray(value) ||
    value.some((batch) => !Array.isArray(batch) || batch.some((item) => typeof item !== "string"))
  ) {
    throw new Error(`${field} must be a string array array`);
  }
  return value as string[][];
}

function optionalRejectedAlternativeArray(value: unknown, field: string): OrchestratorPlanPayload["rejectedAlternatives"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field}[${index}] must be an object`);
    }
    const alternative = item as Record<string, unknown>;
    if ("tasks" in alternative || "taskId" in alternative || "taskIds" in alternative || "batches" in alternative) {
      throw new Error(`${field}[${index}] must be advisory only and must not include task proposals or batches`);
    }
    return {
      title: requiredString(alternative.title, `${field}[${index}].title`),
      reason: requiredString(alternative.reason, `${field}[${index}].reason`),
      tradeoffs: alternative.tradeoffs === undefined ? undefined : stringArray(alternative.tradeoffs, `${field}[${index}].tradeoffs`),
    };
  });
}

function taskArray(value: unknown, field: string): OrchestratorPlanPayload["tasks"] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field}[${index}] must be an object`);
    }
    const task = item as Record<string, unknown>;
    const resultMode = optionalString(task.resultMode, `${field}[${index}].resultMode`);
    if (resultMode !== undefined && resultMode !== "write" && resultMode !== "report") {
      throw new Error(`${field}[${index}].resultMode must be write or report`);
    }
    return {
      id: requiredString(task.id, `${field}[${index}].id`),
      title: requiredString(task.title, `${field}[${index}].title`),
      targetAgent: requiredString(task.targetAgent, `${field}[${index}].targetAgent`),
      projectId: optionalString(task.projectId, `${field}[${index}].projectId`),
      repoRoot: optionalString(task.repoRoot, `${field}[${index}].repoRoot`),
      resultMode,
      targetFiles: stringArray(task.targetFiles, `${field}[${index}].targetFiles`),
      forbiddenChanges: stringArray(task.forbiddenChanges, `${field}[${index}].forbiddenChanges`),
      setupCommands: task.setupCommands === undefined ? undefined : stringArray(task.setupCommands, `${field}[${index}].setupCommands`),
      verifyCommands: stringArray(task.verifyCommands, `${field}[${index}].verifyCommands`),
      instructions: requiredString(task.instructions, `${field}[${index}].instructions`),
      dependencies: task.dependencies === undefined ? undefined : stringArray(task.dependencies, `${field}[${index}].dependencies`),
    };
  });
}
