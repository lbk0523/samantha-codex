import type { AgentProfile, TaskSpec, WorktreeAllocation } from "./contracts";
import type { DecisionItem } from "./decision-store";
import { prepareCodexDispatch, type PreparedCodexDispatch } from "./codex-dispatch";
import { gitHead } from "./git";
import { appendWorkerLiveEvent, initializeWorkerLiveLog } from "./live-log";
import { validateDispatch } from "./policy";
import { evaluateWorkerResult, type WorkerResultEvaluation } from "./worker-result";
import { allocateWorktree, worktreePathForTask } from "./worktree";

export interface PrepareWorkerDispatchInput {
  task: TaskSpec;
  agent: AgentProfile;
  repoRoot: string;
  allocate: boolean;
  worktreesDir?: string;
  liveLogPath?: string;
  runId?: string;
  codexBin?: string;
  governanceDecisions?: DecisionItem[];
}

export interface WorkerDispatchPreparation {
  taskId: string;
  agentId: string;
  worktreePath: string;
  allocation?: WorktreeAllocation;
  codex: PreparedCodexDispatch;
}

export interface CommandRunResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorkerDispatchExecution {
  preparation: WorkerDispatchPreparation;
  liveLogPath?: string;
  setupResults: CommandRunResult[];
  command?: CommandRunResult;
  evaluation?: WorkerResultEvaluation;
  commit?: WorkerCommitResult;
  pass: boolean;
}

export interface WorkerCommitResult {
  subject: string;
  files: string[];
  add: CommandRunResult;
  commit: CommandRunResult;
  commitHash: string;
}

export interface CommandLiveLogOptions {
  path: string;
  runId: string;
  taskId: string;
  phase: string;
}

export async function prepareWorkerDispatch(
  input: PrepareWorkerDispatchInput,
): Promise<WorkerDispatchPreparation> {
  const plan = validateDispatch(input.task, input.agent, undefined, input.governanceDecisions);
  if (!plan.mayDispatch) {
    throw new Error(`dispatch blocked:\n${plan.violations.join("\n")}`);
  }
  if (input.allocate && input.agent.worktreePolicy === "none") {
    throw new Error("dispatch blocked:\nagent worktreePolicy none must not allocate worktrees");
  }

  const allocation = input.allocate
    ? await allocateWorktree({
        repoRoot: input.repoRoot,
        taskId: input.task.id,
        worktreesDir: input.worktreesDir,
      })
    : undefined;
  const worktreePath =
    allocation?.worktreePath ??
    (input.agent.worktreePolicy === "none"
      ? input.repoRoot
      : worktreePathForTask(input.repoRoot, input.task.id, input.worktreesDir));

  return {
    taskId: input.task.id,
    agentId: input.agent.id,
    worktreePath,
    allocation,
    codex: prepareCodexDispatch(input.task, input.agent, worktreePath, input.codexBin),
  };
}

export async function runCommand(
  command: string[],
  options: { cwd?: string; liveLog?: CommandLiveLogOptions } = {},
): Promise<CommandRunResult> {
  await appendWorkerLiveEvent(
    options.liveLog?.path,
    {
      type: "command_start",
      runId: options.liveLog?.runId ?? "",
      taskId: options.liveLog?.taskId ?? "",
      phase: options.liveLog?.phase,
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
  );
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    collectStream(child.stdout, async (text) => {
      await appendWorkerLiveEvent(options.liveLog?.path, {
        type: "stdout",
        runId: options.liveLog?.runId ?? "",
        taskId: options.liveLog?.taskId ?? "",
        phase: options.liveLog?.phase,
        text,
      });
    }),
    collectStream(child.stderr, async (text) => {
      await appendWorkerLiveEvent(options.liveLog?.path, {
        type: "stderr",
        runId: options.liveLog?.runId ?? "",
        taskId: options.liveLog?.taskId ?? "",
        phase: options.liveLog?.phase,
        text,
      });
    }),
    child.exited,
  ]);

  await appendWorkerLiveEvent(options.liveLog?.path, {
    type: "command_exit",
    runId: options.liveLog?.runId ?? "",
    taskId: options.liveLog?.taskId ?? "",
    phase: options.liveLog?.phase,
    command,
    exitCode,
  });

  return { command, exitCode, stdout, stderr };
}

async function collectStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (text: string) => Promise<void>,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    output += text;
    await onChunk(text);
  }
  const tail = decoder.decode();
  if (tail) {
    output += tail;
    await onChunk(tail);
  }
  return output;
}

export async function runSetupCommands(
  commands: string[],
  cwd: string,
  options: { liveLog?: Omit<CommandLiveLogOptions, "phase"> } = {},
): Promise<CommandRunResult[]> {
  const results: CommandRunResult[] = [];

  for (const [index, command] of commands.entries()) {
    const result = await runCommand(["bash", "-lc", command], {
      cwd,
      ...(options.liveLog
        ? { liveLog: { ...options.liveLog, phase: `setup:${index + 1}` } }
        : {}),
    });
    results.push(result);
    if (result.exitCode !== 0) break;
  }

  return results;
}

function commitSubjectForTask(task: TaskSpec): string {
  return task.expectedCommitSubject ?? `samantha: ${task.title}`;
}

export async function commitWorkerChanges(input: {
  task: TaskSpec;
  cwd: string;
  files: string[];
}): Promise<WorkerCommitResult> {
  const files = [...input.files].sort();
  const subject = commitSubjectForTask(input.task);
  const add = files.length > 0
    ? await runCommand(["git", "add", "--", ...files], { cwd: input.cwd })
    : {
        command: ["git", "add", "--"],
        exitCode: 1,
        stdout: "",
        stderr: "no changed files to commit",
      };
  const commit = add.exitCode === 0
    ? await runCommand(["git", "commit", "-m", subject], { cwd: input.cwd })
    : {
        command: ["git", "commit", "-m", subject],
        exitCode: 1,
        stdout: "",
        stderr: "skipped because git add failed",
      };
  const commitHash = commit.exitCode === 0 ? await gitHead(input.cwd) : "";

  return {
    subject,
    files,
    add,
    commit,
    commitHash,
  };
}

export async function executeWorkerDispatch(input: PrepareWorkerDispatchInput): Promise<WorkerDispatchExecution> {
  const preparation = await prepareWorkerDispatch(input);
  const baseCommit = preparation.allocation?.baseCommit ?? (await gitHead(preparation.worktreePath));
  if (input.liveLogPath && input.runId) {
    await initializeWorkerLiveLog(input.liveLogPath, {
      runId: input.runId,
      taskId: input.task.id,
      agentId: input.agent.id,
      repoRoot: input.repoRoot,
      worktreePath: preparation.worktreePath,
    });
  }
  const liveLog =
    input.liveLogPath && input.runId
      ? { path: input.liveLogPath, runId: input.runId, taskId: input.task.id }
      : undefined;
  const setupResults = await runSetupCommands(input.task.setupCommands ?? [], preparation.worktreePath, {
    ...(liveLog ? { liveLog } : {}),
  });
  if (setupResults.some((result) => result.exitCode !== 0)) {
    return {
      preparation,
      ...(input.liveLogPath ? { liveLogPath: input.liveLogPath } : {}),
      setupResults,
      pass: false,
    };
  }

  const command = await runCommand(preparation.codex.command, {
    ...(liveLog ? { liveLog: { ...liveLog, phase: "worker" } } : {}),
  });
  const output = [command.stdout, command.stderr].filter(Boolean).join("\n");
  const evaluation = await evaluateWorkerResult({
    task: input.task,
    cwd: preparation.worktreePath,
    baseCommit,
    output,
  });
  const commit =
    evaluation.pass &&
    preparation.allocation &&
    input.agent.writerClass === "writer" &&
    (evaluation.changedFiles.length > 0 || input.task.resultMode !== "report")
      ? await commitWorkerChanges({
          task: input.task,
          cwd: preparation.worktreePath,
          files: evaluation.changedFiles,
        })
      : undefined;
  const commitPassed = !commit || (commit.add.exitCode === 0 && commit.commit.exitCode === 0);

  return {
    preparation,
    ...(input.liveLogPath ? { liveLogPath: input.liveLogPath } : {}),
    setupResults,
    command,
    evaluation,
    commit,
    pass: command.exitCode === 0 && evaluation.pass && commitPassed,
  };
}
