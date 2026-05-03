import type { AgentProfile, TaskSpec } from "./contracts";

export interface PreparedCodexDispatch {
  prompt: string;
  command: string[];
}

export function buildCodexWorkerPrompt(task: TaskSpec, agent: AgentProfile): string {
  return [
    `You are ${agent.id}, a Codex-only Samantha worker agent.`,
    "",
    "Samantha owns orchestration, worktree allocation, merge, push, and safety gates.",
    "Do not create worktrees. Do not dispatch subagents. Do not push. Do not modify files outside targetFiles.",
    "",
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    "",
    "Instructions:",
    task.instructions,
    "",
    "Target files:",
    ...task.targetFiles.map((file) => `- ${file}`),
    "",
    "Forbidden changes:",
    ...task.forbiddenChanges.map((glob) => `- ${glob}`),
    "",
    "Verify commands:",
    ...task.verifyCommands.map((cmd) => `- ${cmd}`),
    "",
    task.expectedCommitSubject
      ? `Commit subject: ${task.expectedCommitSubject}`
      : "Commit subject: use a concise subject that matches the task.",
    "",
    "Before final response, run the verify commands if you changed files.",
    "Final response must include:",
    'HARNESS_RESULT: {"status":"pass|rework|blocked","note":"short","commit":"<hash-or-empty>"}',
  ].join("\n");
}

export function buildCodexExecCommand(input: {
  agent: AgentProfile;
  worktreePath: string;
  prompt: string;
}): string[] {
  const command = [
    "codex",
    "exec",
    "--cd",
    input.worktreePath,
    "--sandbox",
    "workspace-write",
    "--json",
  ];

  if (input.agent.model) {
    command.push("--model", input.agent.model);
  }
  if (input.agent.codexProfile) {
    command.push("--profile", input.agent.codexProfile);
  }

  command.push(input.prompt);
  return command;
}

export function prepareCodexDispatch(
  task: TaskSpec,
  agent: AgentProfile,
  worktreePath: string,
): PreparedCodexDispatch {
  const prompt = buildCodexWorkerPrompt(task, agent);
  return {
    prompt,
    command: buildCodexExecCommand({ agent, worktreePath, prompt }),
  };
}
