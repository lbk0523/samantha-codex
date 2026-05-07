import type { AgentProfile, DispatchPlan, SafetyPolicy, TaskSpec } from "./contracts";

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

export function validateDispatch(
  task: TaskSpec,
  agent: AgentProfile,
  policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
): DispatchPlan {
  const violations: string[] = [];

  if (task.targetAgent !== agent.id) {
    violations.push(`task targets ${task.targetAgent}, but profile is ${agent.id}`);
  }

  if (agent.writerClass === "writer") {
    if (agent.worktreePolicy !== "per-task") {
      violations.push("writer agents must use per-task worktrees");
    }
    if (agent.mergePolicy !== "samantha-controlled") {
      violations.push("writer agents must use Samantha-controlled merge");
    }
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
    if (agent.worktreePolicy !== "none") {
      violations.push("non-writer agents must not allocate worktrees");
    }
    if (agent.mergePolicy !== "none") {
      violations.push("non-writer agents must not use merge policy");
    }
    if (task.targetFiles.length > 0) {
      violations.push("non-writer report tasks must not declare targetFiles");
    }
  }

  const missingBlockedSkills = policy.blockedSkillNames.filter(
    (skillName) => !agent.skillPolicy.blockedSkills.includes(skillName),
  );
  for (const skillName of missingBlockedSkills) {
    violations.push(`agent profile must block skill: ${skillName}`);
  }

  return {
    task,
    agent,
    mayDispatch: violations.length === 0,
    violations,
  };
}
