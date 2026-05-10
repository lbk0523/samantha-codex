import type { WorkItemAncestry } from "./ancestry";
import type { AgentRole, TaskResultMode } from "./contracts";

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function agentRoleForId(agentId: string | undefined): AgentRole | undefined {
  if (agentId === "codex-reviewer") return "reviewer";
  if (agentId === "codex-evaluator") return "evaluator";
  if (agentId === "codex-spec" || agentId === "codex-orchestrator") return "spec";
  if (agentId === "codex-researcher") return "researcher";
  if (agentId === "codex-content") return "content";
  if (agentId === "codex-operations") return "operations";
  if (agentId === "codex-worker") return "writer";
  return undefined;
}

export function agentRoleLabel(agentId: string | undefined, role = agentRoleForId(agentId)): string {
  if (role === "reviewer") return "Reviewer";
  if (role === "evaluator") return "Evaluator";
  if (role === "spec") return "Spec";
  if (role === "researcher") return "Researcher";
  if (role === "content") return "Content";
  if (role === "operations") return "Operations";
  if (role === "writer") return "Writer";
  return "Agent";
}

export function resultModeLabel(mode: TaskResultMode | string | undefined): string {
  return mode === "report" ? "계획/보고" : "구현/수정";
}

export function ancestryDisplay(ancestry: WorkItemAncestry | undefined): string {
  if (ancestry?.mode === "assigned") return `project=${ancestry.projectId} goal=${ancestry.goalId}`;
  if (ancestry?.mode === "unassigned") return "project=unassigned";
  if (ancestry?.mode === "legacy") return "project=legacy";
  return "";
}

export function roleContribution(role: AgentRole | undefined): { checked: string; reducedRisk: string } {
  if (role === "reviewer") return { checked: "quality and regressions", reducedRisk: "bad change approval" };
  if (role === "researcher") return { checked: "source context", reducedRisk: "stale assumptions" };
  if (role === "evaluator") return { checked: "verification evidence", reducedRisk: "false pass" };
  if (role === "spec") return { checked: "scope and requirements", reducedRisk: "scope drift" };
  if (role === "content") return { checked: "user-facing wording", reducedRisk: "unclear operator message" };
  if (role === "operations") return { checked: "runtime and operational state", reducedRisk: "unsafe dispatch" };
  if (role === "writer") return { checked: "implementation output", reducedRisk: "unintegrated change through gated merge" };
  return { checked: "assigned work", reducedRisk: "unreviewed outcome" };
}

export function roleOutcomeSummary(input: {
  agentId?: string;
  role?: AgentRole;
  title: string;
  mode?: TaskResultMode | string;
  outcome: string;
  ancestry?: WorkItemAncestry;
  includeContribution?: boolean;
}): string {
  const role = input.role ?? agentRoleForId(input.agentId);
  const contribution = roleContribution(role);
  const ancestry = ancestryDisplay(input.ancestry);
  const ancestryText = ancestry ? ` [${ancestry}]` : "";
  const contributionText = input.includeContribution
    ? `; checked ${contribution.checked}; reduced ${contribution.reducedRisk} risk`
    : "";
  return `${agentRoleLabel(input.agentId, role)}${ancestryText}: ${oneLine(input.title)}: ${input.outcome} (${resultModeLabel(input.mode)})${contributionText}`;
}
