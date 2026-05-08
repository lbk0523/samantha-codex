import type { AgentProfile, TaskSpec } from "./contracts";

export interface PreparedCodexDispatch {
  prompt: string;
  command: string[];
}

function roleReportContract(agent: AgentProfile): string[] {
  if (agent.writerClass !== "non-writer") return [];

  const common = [
    "Produce the report artifact in your final response. Do not create report files.",
    "Ground conclusions in repository evidence, explicit task instructions, or stated assumptions.",
  ];

  if (agent.role === "spec") {
    return [
      "Role contract: shape requirements, scope boundaries, acceptance criteria, and unresolved questions.",
      ...common,
    ];
  }
  if (agent.role === "reviewer") {
    return [
      "Role contract: review existing code, plan risk, regressions, and safety issues with file/line references when possible.",
      ...common,
    ];
  }
  if (agent.role === "evaluator") {
    return [
      "Role contract: assess validation strategy, test coverage, result evidence, and remaining release risk.",
      ...common,
    ];
  }
  if (agent.role === "researcher") {
    return [
      "Role contract: research repository-local facts, prior decisions, and technical context without changing files.",
      ...common,
    ];
  }
  if (agent.role === "content") {
    return [
      "Role contract: draft or critique content in the final response without writing files.",
      ...common,
    ];
  }
  if (agent.role === "operations") {
    return [
      "Role contract: analyze operational state, runbook steps, prerequisites, and safe next actions without mutating state.",
      ...common,
    ];
  }

  return common;
}

export function buildCodexWorkerPrompt(task: TaskSpec, agent: AgentProfile): string {
  const reportOnly = task.resultMode === "report";
  const writeBoundary =
    agent.writerClass === "non-writer"
      ? "This is a non-writer report-only task. Do not edit, create, delete, format, commit, push, or move files."
      : reportOnly
        ? "This is a report-only task. Inspect files and return a HARNESS_RESULT without editing, creating, deleting, formatting, committing, pushing, or moving files."
        : agent.writerClass === "writer"
      ? "Do not create worktrees. Do not dispatch subagents. Do not commit or push. Samantha creates the commit after safety gates pass. Do not modify files outside targetFiles."
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
  const setupCommands =
    task.setupCommands && task.setupCommands.length > 0
      ? task.setupCommands.map((cmd) => `- ${cmd}`)
      : ["- (none)"];
  const roleContract = roleReportContract(agent);

  return [
    `You are ${agent.id}, a Codex-only Samantha worker agent.`,
    "",
    "Samantha owns orchestration, worktree allocation, merge, push, and safety gates.",
    writeBoundary,
    ...(roleContract.length > 0 ? ["", ...roleContract] : []),
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
    "Setup commands already run by Samantha before Codex starts:",
    ...setupCommands,
    "",
    "Verify commands:",
    ...verifyCommands,
    "",
    task.expectedCommitSubject
      ? `Samantha commit subject after gates pass: ${task.expectedCommitSubject}`
      : reportOnly
        ? "Samantha will not require a commit when this report-only task changes no files."
        : "Samantha will choose a concise commit subject after gates pass.",
    "",
    "Before final response, run the verify commands if you changed files.",
    "If a verify command is blocked only because the worker sandbox cannot bind a local dev-server port, report `blocked` and include `sandbox port bind` in the note; Samantha may rerun verification outside the worker sandbox.",
    "Final response must include:",
    "Use an empty commit value; Samantha records the commit after gates pass.",
    'HARNESS_RESULT: {"status":"pass|rework|blocked","note":"short","commit":"<hash-or-empty>"}',
  ].join("\n");
}

export function buildCodexExecCommand(input: {
  agent: AgentProfile;
  worktreePath: string;
  prompt: string;
  codexBin?: string;
}): string[] {
  const command = [
    input.codexBin ?? "codex",
    "exec",
    "--cd",
    input.worktreePath,
    "--sandbox",
    input.agent.writerClass === "non-writer" ? "read-only" : "workspace-write",
  ];

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
  codexBin?: string,
): PreparedCodexDispatch {
  const prompt = buildCodexWorkerPrompt(task, agent);
  return {
    prompt,
    command: buildCodexExecCommand({
      agent,
      worktreePath,
      prompt,
      codexBin,
    }),
  };
}
