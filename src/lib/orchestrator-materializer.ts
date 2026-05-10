import { resolve } from "node:path";
import type { AgentProfile, TaskSpec } from "./contracts";
import { selectedProjectIdFromAncestry } from "./orchestration-ancestry";
import { hostOnlyRuntimeViolations, planPayloadBlockerViolations } from "./orchestrator-blockers";
import type { OrchestratorPlanRecord, OrchestratorTaskProposal } from "./orchestrator-store";
import type { ProjectProfile } from "./project-profile";
import { createRemoteDispatchAction, type RemoteActionRecord } from "./remote-action-store";
import { validateTaskTargetFiles } from "./task-draft-store";
import { validateDispatch } from "./policy";
import { sanitizeTaskId } from "./worktree";

export interface OrchestratorMaterializationResult {
  ok: boolean;
  violations: string[];
  tasks: TaskSpec[];
  actions: RemoteActionRecord[];
}

export function taskIdFromOrchestratorProposal(id: string): string {
  const token = sanitizeTaskId(id);
  return token.startsWith("task-") ? token : `task-${token}`;
}

export function materializeOrchestratorPlan(input: {
  plan: OrchestratorPlanRecord;
  agents: AgentProfile[];
  projects: ProjectProfile[];
  existingTaskIds?: string[];
  existingActionIds?: string[];
  createdAt: string;
  commandId?: string;
}): OrchestratorMaterializationResult {
  const violations: string[] = [];
  const tasks: TaskSpec[] = [];
  const actions: RemoteActionRecord[] = [];
  const payload = input.plan.payload;
  const existingTaskIds = new Set(input.existingTaskIds ?? []);
  const existingActionIds = new Set(input.existingActionIds ?? []);
  const plannedTaskIds = new Set<string>();
  const plannedActionIds = new Set<string>();
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const canonicalProjectRoots = new Set(input.projects.map((project) => normalizePath(project.repoRoot)));
  const selectedProjectId = selectedProjectIdFromAncestry(input.plan.ancestry);

  if (input.plan.status !== "planned") violations.push(`orchestrator plan must be planned: ${input.plan.status}`);
  if (input.plan.ancestry && input.plan.ancestry.mode !== "assigned") {
    violations.push(`orchestrator plan must have assigned ancestry before materialization: ${input.plan.ancestry.mode}`);
  }
  if (!payload) {
    violations.push("orchestrator plan payload is missing");
    return { ok: false, violations, tasks, actions };
  }
  const payloadBlockerViolations = planPayloadBlockerViolations(input.plan);
  violations.push(...payloadBlockerViolations.map((violation) => `orchestrator plan has ${violation}`));
  if (payload.questions.length > 0) violations.push("orchestrator plan still has open questions");
  if (payload.tasks.length === 0 && payload.questions.length === 0 && payloadBlockerViolations.length === 0) {
    violations.push("orchestrator plan must contain at least one task");
  }

  const proposalIds = new Set(payload.tasks.map((task) => task.id));
  const proposalTaskIds = new Map<string, string>();
  const proposalActionIds = new Map<string, string>();
  const proposalBatchIndex = new Map<string, number>();

  for (const [batchIndex, batch] of payload.batches.entries()) {
    const writerTaskIds = batch.filter((id) => {
      const proposal = payload.tasks.find((task) => task.id === id);
      return proposal ? isWriteProducingProposal(proposal, input.agents) : false;
    });
    if (writerTaskIds.length > 1) {
      violations.push(
        `batches[${batchIndex}] exceeds writer cap 1: ${writerTaskIds.join(", ")}`,
      );
    }
    for (const id of batch) {
      if (!proposalIds.has(id)) violations.push(`batches[${batchIndex}] references unknown task proposal: ${id}`);
      if (proposalBatchIndex.has(id)) violations.push(`task proposal ${id}: appears in multiple batches`);
      proposalBatchIndex.set(id, batchIndex);
    }
  }
  for (const proposal of payload.tasks) {
    if (!proposalBatchIndex.has(proposal.id)) violations.push(`task proposal ${proposal.id}: missing from batches`);
  }
  for (const proposal of payload.tasks) {
    const taskId = taskIdFromOrchestratorProposal(proposal.id);
    proposalTaskIds.set(proposal.id, taskId);
    proposalActionIds.set(
      proposal.id,
      createRemoteDispatchAction({
        task: { ...taskFromProposal(proposal, input.projects, input.plan.ancestry), id: taskId },
        repoRoot: proposal.repoRoot || input.projects.find((project) => project.id === proposal.projectId)?.repoRoot || "",
        createdAt: input.createdAt,
        source: "remote",
        commandId: `${input.commandId ?? input.plan.id}-${taskId}`,
        ancestry: input.plan.ancestry,
      }).id,
    );
  }
  violations.push(...validateDependencyGraph(payload.tasks, proposalIds, proposalBatchIndex));
  violations.push(...validateUnmergedWriterDependencies(payload.tasks, input.agents, proposalBatchIndex));

  for (const proposal of payload.tasks) {
    const task = taskFromProposal(proposal, input.projects, input.plan.ancestry);
    const taskPrefix = `task proposal ${proposal.id}`;
    if (plannedTaskIds.has(task.id)) violations.push(`${taskPrefix} produces duplicate task id: ${task.id}`);
    if (existingTaskIds.has(task.id)) violations.push(`${taskPrefix} conflicts with existing task: ${task.id}`);
    plannedTaskIds.add(task.id);

    violations.push(...validateProposalRepoRoot(taskPrefix, proposal, projectsById, canonicalProjectRoots));
    violations.push(...validateProposalProjectContext(taskPrefix, proposal, selectedProjectId));
    const fieldViolations = validateTaskProposal(taskPrefix, proposal, task, input.agents);
    violations.push(...fieldViolations);

    const dependsOnActionIds = dependencyProposalIds(proposal, payload.tasks, proposalBatchIndex)
      .map((proposalId) => proposalActionIds.get(proposalId))
      .filter((actionId): actionId is string => Boolean(actionId));
    const action = createRemoteDispatchAction({
      task,
      repoRoot: task.repoRoot ?? "",
      createdAt: input.createdAt,
      source: "remote",
      commandId: `${input.commandId ?? input.plan.id}-${task.id}`,
      status: dependsOnActionIds.length ? "waiting" : "pending",
      orchestratorPlanId: input.plan.id,
      orchestratorTaskId: proposal.id,
      dependsOnActionIds,
      ancestry: input.plan.ancestry,
    });
    if (plannedActionIds.has(action.id)) violations.push(`${taskPrefix} produces duplicate action id: ${action.id}`);
    if (existingActionIds.has(action.id)) violations.push(`${taskPrefix} conflicts with existing action: ${action.id}`);
    plannedActionIds.add(action.id);

    tasks.push(task);
    actions.push(action);
  }

  return { ok: violations.length === 0, violations, tasks, actions };
}

function isWriteProducingProposal(proposal: OrchestratorTaskProposal, agents: AgentProfile[]): boolean {
  if (proposal.resultMode === "report") return false;
  return agents.find((agent) => agent.id === proposal.targetAgent)?.writerClass === "writer";
}

function normalizePath(path: string): string {
  return resolve(path);
}

function isSamanthaWorkerWorktree(path: string): boolean {
  return normalizePath(path).split("/").includes(".samantha-worktrees");
}

function validateProposalRepoRoot(
  prefix: string,
  proposal: OrchestratorTaskProposal,
  projectsById: Map<string, ProjectProfile>,
  canonicalProjectRoots: Set<string>,
): string[] {
  const violations: string[] = [];
  const proposedRoot = proposal.repoRoot ? normalizePath(proposal.repoRoot) : undefined;
  const project = proposal.projectId ? projectsById.get(proposal.projectId) : undefined;

  if (proposal.projectId && !project) {
    violations.push(`${prefix}: projectId is unknown: ${proposal.projectId}`);
  }
  if (proposedRoot && isSamanthaWorkerWorktree(proposedRoot)) {
    violations.push(`${prefix}: repoRoot must not point to a Samantha worker worktree`);
  }
  if (project && proposedRoot && proposedRoot !== normalizePath(project.repoRoot)) {
    violations.push(`${prefix}: repoRoot must match project profile repoRoot for project ${project.id}`);
  }
  if (!project && proposedRoot && canonicalProjectRoots.size > 0 && !canonicalProjectRoots.has(proposedRoot)) {
    violations.push(`${prefix}: repoRoot must match a known project profile repoRoot`);
  }

  return violations;
}

function dependencyProposalIds(
  proposal: OrchestratorTaskProposal,
  proposals: OrchestratorTaskProposal[],
  batchIndexByProposalId: Map<string, number>,
): string[] {
  const dependencies = new Set(proposal.dependencies ?? []);
  const ownBatchIndex = batchIndexByProposalId.get(proposal.id);
  if (ownBatchIndex !== undefined) {
    for (const candidate of proposals) {
      const candidateBatchIndex = batchIndexByProposalId.get(candidate.id);
      if (candidateBatchIndex !== undefined && candidateBatchIndex < ownBatchIndex) dependencies.add(candidate.id);
    }
  }
  dependencies.delete(proposal.id);
  return [...dependencies].sort();
}

function validateDependencyGraph(
  proposals: OrchestratorTaskProposal[],
  proposalIds: Set<string>,
  batchIndexByProposalId: Map<string, number>,
): string[] {
  const violations: string[] = [];
  for (const proposal of proposals) {
    for (const dependency of proposal.dependencies ?? []) {
      if (!proposalIds.has(dependency)) violations.push(`task proposal ${proposal.id}: dependency references unknown task proposal: ${dependency}`);
      if (dependency === proposal.id) violations.push(`task proposal ${proposal.id}: dependency must not reference itself`);
    }
  }

  const dependenciesById = new Map(
    proposals.map((proposal) => [
      proposal.id,
      dependencyProposalIds(proposal, proposals, batchIndexByProposalId),
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      violations.push(`task proposal dependency cycle: ${[...path, id].join(" -> ")}`);
      return;
    }
    visiting.add(id);
    for (const dependency of dependenciesById.get(id) ?? []) {
      if (proposalIds.has(dependency)) visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const proposal of proposals) visit(proposal.id, []);
  return violations;
}

function validateUnmergedWriterDependencies(
  proposals: OrchestratorTaskProposal[],
  agents: AgentProfile[],
  batchIndexByProposalId: Map<string, number>,
): string[] {
  const violations: string[] = [];
  const writeProducingProposalIds = new Set(
    proposals.filter((proposal) => isWriteProducingProposal(proposal, agents)).map((proposal) => proposal.id),
  );

  for (const proposal of proposals) {
    const writeDependencies = dependencyProposalIds(proposal, proposals, batchIndexByProposalId).filter((dependency) =>
      writeProducingProposalIds.has(dependency),
    );
    for (const dependency of writeDependencies) {
      if (proposal.resultMode === "report") {
        violations.push(
          `task proposal ${proposal.id}: report-only tasks must not depend on unmerged writer output from ${dependency}; put verification in the writer task's verifyCommands`,
        );
      } else {
        violations.push(
          `task proposal ${proposal.id}: writer tasks must not depend on unmerged writer output from ${dependency}; combine dependent writes into one writer task or wait for merge`,
        );
      }
    }
  }

  return violations;
}

function taskFromProposal(proposal: OrchestratorTaskProposal, projects: ProjectProfile[], ancestry?: TaskSpec["ancestry"]): TaskSpec {
  const project = proposal.projectId ? projects.find((item) => item.id === proposal.projectId) : undefined;
  return {
    id: taskIdFromOrchestratorProposal(proposal.id),
    ancestry,
    title: proposal.title.trim(),
    targetAgent: proposal.targetAgent.trim(),
    projectId: proposal.projectId,
    repoRoot: proposal.repoRoot || project?.repoRoot,
    targetFiles: proposal.targetFiles,
    forbiddenChanges: proposal.forbiddenChanges.length ? proposal.forbiddenChanges : project?.forbiddenChanges ?? [],
    setupCommands: proposal.setupCommands ?? project?.setupCommands ?? [],
    verifyCommands: proposal.verifyCommands.length ? proposal.verifyCommands : project?.verifyCommands ?? [],
    instructions: proposal.instructions.trim(),
    resultMode: proposal.resultMode,
    status: "pending",
  };
}

function validateProposalProjectContext(prefix: string, proposal: OrchestratorTaskProposal, selectedProjectId: string | undefined): string[] {
  if (!selectedProjectId) return [];
  if (proposal.projectId !== selectedProjectId) {
    return [`${prefix}: projectId must match selected project context: ${proposal.projectId ?? "(missing)"} != ${selectedProjectId}`];
  }
  return [];
}

function validateTaskProposal(prefix: string, proposal: OrchestratorTaskProposal, task: TaskSpec, agents: AgentProfile[]): string[] {
  const violations: string[] = [];
  const agent = agents.find((item) => item.id === task.targetAgent);

  if (!task.title) violations.push(`${prefix}: title is required`);
  if (!task.instructions) violations.push(`${prefix}: instructions are required`);
  if (!task.targetAgent) violations.push(`${prefix}: targetAgent is required`);
  if (!task.repoRoot) violations.push(`${prefix}: repoRoot is required`);
  if (task.verifyCommands.length === 0) violations.push(`${prefix}: verifyCommands must not be empty`);
  violations.push(...validateTaskTargetFiles(task.targetFiles, task.forbiddenChanges).map((violation) => `${prefix}: ${violation}`));
  violations.push(...hostOnlyRuntimeViolations(proposal).map((violation) => `${prefix}: ${violation}`));

  if (!agent) {
    violations.push(`${prefix}: targetAgent is unknown: ${task.targetAgent || "(empty)"}`);
    return violations;
  }

  if (agent.writerClass === "writer" && task.resultMode !== "report" && proposal.verifyCommands.length === 0) {
    violations.push(`${prefix}: writer task proposals must include their own verifyCommands`);
  }

  const dispatch = validateDispatch(task, agent);
  violations.push(...dispatch.violations.map((violation) => `${prefix}: ${violation}`));
  return violations;
}
