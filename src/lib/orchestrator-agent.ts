import type { AgentProfile } from "./contracts";
import { classifyRemoteRequest, type ProjectProfile, type RemoteRequestClassification } from "./project-profile";
import type {
  OrchestrationRequestRecord,
  OrchestratorPlanPayload,
  OrchestratorQuestionDraftPayload,
  OrchestratorPlanStatus,
  OrchestratorPlanRecord,
  OrchestratorSynthesisPayload,
} from "./orchestrator-store";
import type { RemoteActionRecord } from "./remote-action-store";
import type { WorkerRunLog } from "./run-log";
import { runCommand, type CommandRunResult } from "./worker-dispatch";

export interface OrchestratorPlanRunResult {
  status: OrchestratorPlanStatus;
  command: CommandRunResult;
  rawOutput: string;
  payload?: OrchestratorPlanPayload;
  classification: RemoteRequestClassification;
  failure?: string;
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

export function buildOrchestratorPrompt(input: {
  request: OrchestrationRequestRecord;
  projectProfiles: ProjectProfile[];
  requestedProjectId?: string;
  requestedScopeId?: string;
}): string {
  const classification = classifyRemoteRequest(input.request.text);
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
    "Return a concise Korean user-facing plan, then include exactly one machine-readable payload.",
    "The payload must start with `ORCHESTRATOR_PLAN:` followed by a strict JSON object.",
    "If the request is ambiguous enough that worker delegation would be unsafe, put the blocking questions in `questions` and leave `tasks` empty.",
    "If Samantha lacks a local prerequisite such as a project profile, canonical repo root, concrete verify command, or host-only runtime requirement, put it in `prerequisites` or `blockers` and leave `tasks` empty.",
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
    "- Use `codex-worker` only for implementation/write tasks that may change files.",
    "Non-writer tasks must use `resultMode: \"report\"` and must not depend on unmerged files produced by writer tasks.",
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
}): Promise<OrchestratorPlanRunResult> {
  const classification = classifyRemoteRequest(input.request.text);
  const prompt = buildOrchestratorPrompt({
    request: input.request,
    projectProfiles: input.projectProfiles,
    requestedProjectId: input.requestedProjectId,
    requestedScopeId: input.requestedScopeId,
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
    "Draft one concise BK decision question for an ambiguous blocker.",
    "Do not edit files. Do not create tasks. Do not dispatch workers. Do not run merge, push, or cleanup commands.",
    "Do not claim that you changed durable state. The deterministic CEO office may validate your draft and store it as a decision item.",
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
        options: ["approve", "revise", "cancel"],
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

export function parseOrchestratorPlanPayload(output: string): OrchestratorPlanPayload {
  const messages = extractAgentMessages(output);
  const candidates = [...messages.slice().reverse(), output];
  let parseError: unknown;
  for (const candidate of candidates) {
    const json = extractMarkedJson(candidate, "ORCHESTRATOR_PLAN:");
    if (!json) continue;
    try {
      return validatePlanPayload(JSON.parse(json));
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
      return validateSynthesisPayload(JSON.parse(json));
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
      return validateQuestionDraftPayload(JSON.parse(json));
    } catch (err) {
      parseError = err;
    }
  }
  if (parseError) throw parseError;
  throw new Error("ORCHESTRATOR_QUESTION_DRAFT payload not found");
}

function projectProfileLines(profiles: ProjectProfile[]): string[] {
  if (profiles.length === 0) return ["- none"];
  return profiles.map((profile) => {
    const scopes = (profile.remoteScopes ?? [])
      .map((scope) => `${scope.id}:${scope.resultMode ?? "write"}:${scope.targetFiles.join(",")}`)
      .join("; ");
    return `- ${profile.id}: repo=${profile.repoRoot}; keywords=${(profile.keywords ?? []).join(",") || "none"}; scopes=${scopes || "none"}; forbidden=${profile.forbiddenChanges.join(",") || "none"}; verify=${profile.verifyCommands.join(",") || "none"}`;
  });
}

function buildOrchestratorSynthesisPrompt(input: {
  plan: OrchestratorPlanRecord;
  request?: OrchestrationRequestRecord;
  actions: RemoteActionRecord[];
  runLogs: WorkerRunLog[];
}): string {
  return [
    "You are the Samantha Orchestrator Agent in final synthesis mode.",
    "Do not edit files. Do not dispatch workers. Do not run merge, push, or cleanup commands.",
    "Do not claim that you changed durable state. Summarize only the evidence provided by Samantha.",
    "Summarize the completed worker team result for BK in Korean and recommend the next action.",
    "",
    `Request: ${input.request?.text ?? input.plan.requestId}`,
    `Plan: ${input.plan.id}`,
    input.plan.payload ? `Original plan summary: ${input.plan.payload.summary}` : "Original plan summary: missing",
    "",
    "Action results:",
    ...input.actions.map((action) => {
      const runLog = input.runLogs.find((log) => log.runId === action.result?.runId || log.task.id === action.taskId);
      const changedFiles = runLog?.result.evaluation?.changedFiles ?? runLog?.result.commit?.files ?? [];
      const harnessNote = runLog?.result.evaluation?.harness?.note ?? "";
      return `- ${action.taskId}: status=${action.status} pass=${String(action.result?.pass ?? false)} outcome=${action.result?.outcome ?? "unknown"} failure=${action.result?.failure ?? ""} note=${harnessNote} changed=${changedFiles.join(",") || "none"}`;
    }),
    "",
    "Return a concise Korean synthesis, then include exactly one machine-readable payload.",
    "The payload must start with `ORCHESTRATOR_SYNTHESIS:` followed by a strict JSON object.",
    "",
    "Payload shape:",
    JSON.stringify(
      {
        outcome: "pass|failed|mixed",
        summary: "short Korean summary",
        nextActions: ["next action"],
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
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
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
    if (char === '"') {
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
  if (outcome !== "pass" && outcome !== "failed" && outcome !== "mixed") {
    throw new Error("outcome must be pass, failed, or mixed");
  }
  return {
    outcome,
    summary: requiredString(value.summary, "summary"),
    nextActions: stringArray(value.nextActions, "nextActions"),
    risks: stringArray(value.risks, "risks"),
    userMessage: requiredString(value.userMessage, "userMessage"),
  };
}

function validateQuestionDraftPayload(raw: unknown): OrchestratorQuestionDraftPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ORCHESTRATOR_QUESTION_DRAFT must be an object");
  }
  const value = raw as Record<string, unknown>;
  const options = stringArray(value.options, "options");
  if (options.length === 0) throw new Error("options must not be empty");
  return {
    title: requiredString(value.title, "title"),
    prompt: requiredString(value.prompt, "prompt"),
    options,
    risk: optionalString(value.risk, "risk"),
    userMessage: requiredString(value.userMessage, "userMessage"),
  };
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
