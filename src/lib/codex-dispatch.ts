import type { AgentProfile, TaskSpec } from "./contracts";

export interface PreparedCodexDispatch {
  prompt: string;
  command: string[];
}

export function buildCodexWorkerPrompt(task: TaskSpec, agent: AgentProfile): string {
  const writeBoundary =
    agent.writerClass === "writer"
      ? "Do not create worktrees. Do not dispatch subagents. Do not push. Do not modify files outside targetFiles."
      : "This is a non-writer task. Do not edit, create, delete, format, commit, push, or move files.";
  const targetFiles =
    task.targetFiles.length > 0
      ? task.targetFiles.map((file) => `- ${file}`)
      : ["- (none; read-only task)"];
  const forbiddenChanges =
    task.forbiddenChanges.length > 0
      ? task.forbiddenChanges.map((glob) => `- ${glob}`)
      : ["- (none declared)"];
  const verifyCommands =
    task.verifyCommands.length > 0
      ? task.verifyCommands.map((cmd) => `- ${cmd}`)
      : ["- (none)"];

  return [
    `You are ${agent.id}, a Codex-only Samantha worker agent.`,
    "",
    "Samantha owns orchestration, worktree allocation, merge, push, and safety gates.",
    writeBoundary,
    "",
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    "",
    "Instructions:",
    task.instructions,
    "",
    "Target files:",
    ...targetFiles,
    "",
    "Forbidden changes:",
    ...forbiddenChanges,
    "",
    "Verify commands:",
    ...verifyCommands,
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
  gitMetadataDir?: string;
}): string[] {
  const command = [
    "codex",
    "exec",
    "--cd",
    input.worktreePath,
    "--sandbox",
    "workspace-write",
  ];

  if (input.gitMetadataDir) {
    command.push("--add-dir", input.gitMetadataDir);
  }

  command.push("--json");

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
  options: { gitMetadataDir?: string } = {},
): PreparedCodexDispatch {
  const prompt = buildCodexWorkerPrompt(task, agent);
  return {
    prompt,
    command: buildCodexExecCommand({
      agent,
      worktreePath,
      prompt,
      gitMetadataDir: options.gitMetadataDir,
    }),
  };
}
