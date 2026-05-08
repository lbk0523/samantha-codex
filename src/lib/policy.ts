import type { AgentProfile, AgentRole, DispatchPlan, SafetyPolicy, TaskSpec } from "./contracts";

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  writerCap: 1,
  requiredForbiddenChanges: true,
  requiredTargetFilesForWriters: true,
  blockedSkillNames: [
    "using-git-worktrees",
    "dispatching-parallel-agents",
    "subagent-driven-development",
  ],
};

const KNOWN_AGENT_ROLES: AgentRole[] = [
  "writer",
  "reviewer",
  "evaluator",
  "spec",
  "researcher",
  "content",
  "operations",
];

export function validateAgentProfile(
  agent: AgentProfile,
  policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
): string[] {
  const violations: string[] = [];
  const role = String((agent as { role?: unknown }).role ?? "");
  const writerClass = String((agent as { writerClass?: unknown }).writerClass ?? "");
  const blockedSkills = Array.isArray(agent.skillPolicy?.blockedSkills) ? agent.skillPolicy.blockedSkills : [];

  if (!KNOWN_AGENT_ROLES.includes(role as AgentRole)) {
    violations.push(`agent profile role is unknown: ${role || "(empty)"}`);
  }

  if (writerClass !== "writer" && writerClass !== "non-writer") {
    violations.push(`agent profile writerClass is unknown: ${writerClass || "(empty)"}`);
  }

  if (writerClass === "writer" && agent.id !== "codex-worker") {
    violations.push("only codex-worker may be a writer profile");
  }
  if (agent.id === "codex-worker" && writerClass !== "writer") {
    violations.push("codex-worker must be the production writer profile");
  }
  if (writerClass === "writer" && role !== "writer") {
    violations.push("writer profiles must use writer role");
  }
  if (writerClass === "non-writer" && role === "writer") {
    violations.push("non-writer profiles must not use writer role");
  }

  if (writerClass === "writer") {
    if (agent.worktreePolicy !== "per-task") {
      violations.push("writer agents must use per-task worktrees");
    }
    if (agent.mergePolicy !== "samantha-controlled") {
      violations.push("writer agents must use Samantha-controlled merge");
    }
  }

  if (writerClass === "non-writer") {
    if (agent.worktreePolicy !== "none") {
      violations.push("non-writer agents must not allocate worktrees");
    }
    if (agent.mergePolicy !== "none") {
      violations.push("non-writer agents must not use merge policy");
    }
  }

  const missingBlockedSkills = policy.blockedSkillNames.filter((skillName) => !blockedSkills.includes(skillName));
  for (const skillName of missingBlockedSkills) {
    violations.push(`agent profile must block skill: ${skillName}`);
  }

  return violations;
}

export function validateDispatch(
  task: TaskSpec,
  agent: AgentProfile,
  policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
): DispatchPlan {
  const violations: string[] = [];
  violations.push(...validateAgentProfile(agent, policy));

  if (task.targetAgent !== agent.id) {
    violations.push(`task targets ${task.targetAgent}, but profile is ${agent.id}`);
  }

  if (agent.writerClass === "writer") {
    if (policy.requiredTargetFilesForWriters && task.resultMode !== "report" && task.targetFiles.length === 0) {
      violations.push("writer tasks must declare targetFiles");
    }
    if (policy.requiredForbiddenChanges && task.forbiddenChanges.length === 0) {
      violations.push("writer tasks must declare forbiddenChanges");
    }
  }
  if (agent.writerClass === "non-writer") {
    if (task.resultMode !== "report") {
      violations.push("non-writer tasks must use report resultMode");
    }
    if (task.targetFiles.length > 0) {
      violations.push("non-writer report tasks must not declare targetFiles");
    }
  }

  return {
    task,
    agent,
    mayDispatch: violations.length === 0,
    violations,
  };
}
