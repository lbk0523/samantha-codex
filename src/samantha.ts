import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentProfile, TaskSpec } from "./lib/contracts";
import { acquireDaemonLock, checkDaemonHealth, readDaemonHeartbeat, writeDaemonHeartbeat } from "./lib/daemon";
import { writeDashboard, type LiveRunStatus } from "./lib/dashboard";
import { processInbox, type InboxCommand } from "./lib/inbox";
import { RunIndex, summarizeWorkerRun } from "./lib/ledger";
import { buildWorkerLiveLogPath, formatWorkerLiveLogLine, startTmuxObserver, type TmuxObserverResult } from "./lib/live-log";
import { applyMerge, evaluateMergeGate, pushMerge, readWorkerRunLog } from "./lib/merge-gate";
import {
  doctorReport,
  draftProposeAddedReport,
  failuresReport,
  healthReport,
  proposalAddedReport,
  proposalsListReport,
  proposalReviewedReport,
  proposalShowReport,
  nextActionReport,
  remoteHelpReport,
  runsListReport,
  runShowReport,
  statusReport,
  taskDraftAddedReport,
  taskDraftShowReport,
  taskDraftsListReport,
  tasksListReport,
  taskShowReport,
} from "./lib/operator-reports";
import { collectOpsSnapshot, withoutActiveInboxCommand } from "./lib/ops-diagnostics";
import { runPlan } from "./lib/plan-runner";
import { applyProjectDefaults, loadProjectProfile } from "./lib/project-profile";
import { ProposalStore, type ProposalRecord } from "./lib/proposal-store";
import { enqueueRemoteCommand } from "./lib/remote-command";
import { lifecycleBaseFromRunLog, RunLifecycleStore } from "./lib/run-lifecycle-store";
import { buildWorkerRunId, writeWorkerRunLog } from "./lib/run-log";
import {
  checkTaskDraft,
  parseTaskDraftUpdatePatch,
  TaskDraftStore,
  taskDraftPatchTemplate,
  taskDraftReadiness,
  taskDraftFromProposal,
  taskSpecFromDraft,
} from "./lib/task-draft-store";
import { TaskStore } from "./lib/task-store";
import { pollTelegramToInbox } from "./lib/telegram-adapter";
import { sendOutboxReplies } from "./lib/telegram-reply-adapter";
import { cleanupCompletedWorktree } from "./lib/worktree-cleanup";
import { branchForTask, worktreePathForTask } from "./lib/worktree";
import { executeWorkerDispatch, prepareWorkerDispatch, commitWorkerChanges } from "./lib/worker-dispatch";
import { evaluateWorkerResult } from "./lib/worker-result";
import { gitHead, gitTopLevel } from "./lib/git";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

const root = resolve(import.meta.dir, "..");

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (const arg of rest) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) {
      flags.set(arg.slice(2), true);
    } else {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }

  return { command, positionals, flags };
}

function flag(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : fallback;
}

function stateDir(args: ParsedArgs): string {
  return resolve(flag(args, "state-dir", join(root, "state")));
}

function runsPath(args: ParsedArgs): string {
  return join(stateDir(args), "runs.jsonl");
}

function tasksPath(args: ParsedArgs): string {
  return join(stateDir(args), "tasks.jsonl");
}

function proposalsPath(args: ParsedArgs): string {
  return join(stateDir(args), "proposals.jsonl");
}

function taskDraftsPath(args: ParsedArgs): string {
  return join(stateDir(args), "task-drafts.jsonl");
}

function runLifecyclePath(args: ParsedArgs): string {
  return join(stateDir(args), "run-lifecycle.jsonl");
}

function logDir(args: ParsedArgs): string {
  return resolve(flag(args, "log-dir", join(root, "runs")));
}

function agentProfilesDir(args: ParsedArgs): string {
  return resolve(flag(args, "agent-profiles-dir", join(root, "references/agent-profiles")));
}

function projectProfilesDir(args: ParsedArgs): string {
  return resolve(flag(args, "project-profiles-dir", join(root, "references/project-profiles")));
}

function daemonLockPath(args: ParsedArgs): string {
  return resolve(flag(args, "lock-file", join(stateDir(args), "daemon.lock")));
}

function heartbeatPath(args: ParsedArgs): string {
  return resolve(flag(args, "heartbeat-file", join(stateDir(args), "heartbeat.json")));
}

function telegramOffsetPath(args: ParsedArgs): string {
  return resolve(flag(args, "telegram-offset-file", join(stateDir(args), "telegram-offset.json")));
}

function telegramRepliesPath(args: ParsedArgs): string {
  return resolve(flag(args, "telegram-replies-file", join(stateDir(args), "telegram-replies.json")));
}

function envFilePath(args: ParsedArgs): string {
  return resolve(flag(args, "env-file", join(root, ".env")));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function formatLiveLogFromStdin(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream() as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const formatted = formatWorkerLiveLogLine(line);
      if (formatted) console.log(formatted);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const formatted = formatWorkerLiveLogLine(buffer);
    if (formatted) console.log(formatted);
  }
}

async function pendingInboxCount(path: string): Promise<number> {
  try {
    return (await readdir(path)).filter((file) => file.endsWith(".json")).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function knownAgentIds(args: ParsedArgs): Promise<string[]> {
  const dir = agentProfilesDir(args);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  const agents = await Promise.all(files.map((file) => readJson<AgentProfile>(join(dir, file))));
  return agents.map((agent) => agent.id);
}

async function loadAgentProfile(args: ParsedArgs, agentId: string): Promise<AgentProfile> {
  const dir = agentProfilesDir(args);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    const agent = await readJson<AgentProfile>(join(dir, file));
    if (agent.id === agentId) return agent;
  }
  throw new Error(`agent profile not found: ${agentId}`);
}

async function buildDashboard(args: ParsedArgs, out: string): Promise<number> {
  const runs = await new RunIndex(runsPath(args)).list();
  const inboxDir = resolve(flag(args, "inbox-dir", join(root, "inbox")));
  await writeDashboard(out, runs, {
    heartbeat: await readDaemonHeartbeat(heartbeatPath(args)),
    pendingInboxCount: await pendingInboxCount(inboxDir),
    ops: await collectOps(args),
    proposals: await new ProposalStore(proposalsPath(args)).list(),
    drafts: await new TaskDraftStore(taskDraftsPath(args)).list(),
    tasks: await new TaskStore(tasksPath(args)).list(),
    lifecycles: await new RunLifecycleStore(runLifecyclePath(args)).list(),
    liveRuns: await readLiveRuns(logDir(args)),
  });
  return runs.length;
}

async function readLiveRuns(baseLogDir: string): Promise<LiveRunStatus[]> {
  const liveDir = join(baseLogDir, "live");
  let files: string[];
  try {
    files = (await readdir(liveDir)).filter((file) => file.endsWith(".jsonl")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const liveRuns: LiveRunStatus[] = [];
  for (const file of files) {
    const liveLogPath = join(liveDir, file);
    const lines = (await readFile(liveLogPath, "utf8")).split(/\r?\n/).filter(Boolean);
    const events = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const meta = events.find((event) => event.type === "meta");
    const latest = events.at(-1);
    if (!latest) continue;

    const latestText = typeof latest.text === "string" ? latest.text : undefined;
    liveRuns.push({
      runId: String(latest.runId ?? meta?.runId ?? file.replace(/\.jsonl$/, "")),
      taskId: String(latest.taskId ?? meta?.taskId ?? "unknown"),
      agentId: typeof latest.agentId === "string" ? latest.agentId : typeof meta?.agentId === "string" ? meta.agentId : undefined,
      phase: typeof latest.phase === "string" ? latest.phase : undefined,
      lastEventType: typeof latest.type === "string" ? latest.type : undefined,
      lastAt: String(latest.at ?? ""),
      liveLogPath,
      ...(latestText ? { latestText } : {}),
    });
  }
  return liveRuns;
}

async function serveDashboard(args: ParsedArgs): Promise<void> {
  const out = resolve(flag(args, "out", join(root, "dashboard/index.html")));
  const hostname = flag(args, "host", "127.0.0.1");
  const port = Number(flag(args, "port", "4173"));
  const server = Bun.serve({
    hostname,
    port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/" && url.pathname !== "/index.html") return new Response("not found", { status: 404 });
      await buildDashboard(args, out);
      return new Response(await readFile(out, "utf8"), {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
      });
    },
  });

  console.log(`Samantha dashboard listening on http://${server.hostname}:${server.port}/`);
  console.log(`Rendering ${out} on each request`);
  await new Promise(() => {});
}

async function collectOps(args: ParsedArgs) {
  return collectOpsSnapshot({
    envFilePath: envFilePath(args),
    inboxDir: resolve(flag(args, "inbox-dir", join(root, "inbox"))),
    outboxDir: resolve(flag(args, "outbox-dir", join(root, "outbox"))),
    archiveInboxDir: resolve(flag(args, "archive-dir", join(root, "archive", "inbox"))),
    heartbeatPath: heartbeatPath(args),
    lockPath: daemonLockPath(args),
    telegramOffsetPath: telegramOffsetPath(args),
    telegramRepliesPath: telegramRepliesPath(args),
    maxAgeMs: Number(flag(args, "max-age-ms", "15000")),
  });
}

async function handleInboxCommand(command: InboxCommand, args: ParsedArgs): Promise<string> {
  if (command.type === "remote:help") {
    return remoteHelpReport();
  }
  if (command.type === "status:show") {
    const runs = await new RunIndex(runsPath(args)).list();
    const ops = withoutActiveInboxCommand(await collectOps(args));
    return statusReport({
      runs,
      heartbeat: ops.health.heartbeat,
      pendingInboxCount: ops.queues.pendingInboxCount,
      ops,
      proposals: await new ProposalStore(proposalsPath(args)).list(),
      drafts: await new TaskDraftStore(taskDraftsPath(args)).list(),
      lifecycles: await new RunLifecycleStore(runLifecyclePath(args)).list(),
    });
  }
  if (command.type === "ops:doctor") {
    return doctorReport(withoutActiveInboxCommand(await collectOps(args)));
  }
  if (command.type === "health:check") {
    return healthReport(
      await checkDaemonHealth({
        heartbeatPath: heartbeatPath(args),
        lockPath: daemonLockPath(args),
        maxAgeMs: Number(command.args?.maxAgeMs ?? flag(args, "max-age-ms", "15000")),
      }),
    );
  }
  if (command.type === "runs:list") {
    const runs = await new RunIndex(runsPath(args)).list();
    return runsListReport(runs);
  }
  if (command.type === "runs:show") {
    const id = String(command.args?.id ?? "");
    const run = await new RunIndex(runsPath(args)).find(id);
    return runShowReport(id, run);
  }
  if (command.type === "runs:failures") {
    const runs = await new RunIndex(runsPath(args)).list();
    return failuresReport(runs);
  }
  if (command.type === "proposals:add") {
    const proposal: ProposalRecord = {
      schemaVersion: 1,
      id: String(command.args?.id ?? ""),
      text: String(command.args?.text ?? ""),
      source: "remote",
      senderId: String(command.args?.senderId ?? ""),
      status: "pending_review",
      createdAt: String(command.args?.receivedAt ?? new Date().toISOString()),
    };
    if (!proposal.id) throw new Error("proposal id is required");
    if (!proposal.text.trim()) throw new Error("proposal text is required");
    await new ProposalStore(proposalsPath(args)).append(proposal);
    return proposalAddedReport(proposal);
  }
  if (command.type === "proposals:list") {
    const proposals = await new ProposalStore(proposalsPath(args)).list();
    return proposalsListReport(proposals);
  }
  if (command.type === "proposals:show") {
    const id = String(command.args?.id ?? "");
    const proposal = await new ProposalStore(proposalsPath(args)).find(id);
    return proposalShowReport(id, proposal);
  }
  if (command.type === "proposals:accept" || command.type === "proposals:reject") {
    const id = String(command.args?.id ?? "");
    if (!id) throw new Error("proposal id is required");
    const action = command.type === "proposals:accept" ? "accept" : "reject";
    const proposal = await new ProposalStore(proposalsPath(args)).updateStatus(
      id,
      action === "accept" ? "accepted" : "rejected",
      {
        reviewedAt: String(command.args?.receivedAt ?? new Date().toISOString()),
        reviewNote: typeof command.args?.note === "string" ? command.args.note : undefined,
      },
    );
    return proposalReviewedReport(action, proposal);
  }
  if (command.type === "drafts:add") {
    const proposalId = String(command.args?.proposalId ?? "");
    if (!proposalId) throw new Error("proposal id is required");
    const proposal = await new ProposalStore(proposalsPath(args)).find(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    const draft = taskDraftFromProposal(proposal, String(command.args?.receivedAt ?? new Date().toISOString()));
    await new TaskDraftStore(taskDraftsPath(args)).append(draft);
    return taskDraftAddedReport(draft);
  }
  if (command.type === "drafts:add-from-proposal-text") {
    const receivedAt = String(command.args?.receivedAt ?? new Date().toISOString());
    const proposal: ProposalRecord = {
      schemaVersion: 1,
      id: String(command.args?.proposalId ?? ""),
      text: String(command.args?.text ?? ""),
      source: "remote",
      senderId: String(command.args?.senderId ?? ""),
      status: "accepted",
      createdAt: receivedAt,
      reviewedAt: receivedAt,
      reviewNote: "accepted by /draft-propose",
    };
    if (!proposal.id) throw new Error("proposal id is required");
    if (!proposal.text.trim()) throw new Error("proposal text is required");

    const draft = taskDraftFromProposal(proposal, receivedAt);
    await new ProposalStore(proposalsPath(args)).append(proposal);
    await new TaskDraftStore(taskDraftsPath(args)).append(draft);
    return draftProposeAddedReport({ proposal, draft });
  }
  if (command.type === "drafts:list") {
    const drafts = await new TaskDraftStore(taskDraftsPath(args)).list();
    return taskDraftsListReport(drafts);
  }
  if (command.type === "drafts:show") {
    const id = String(command.args?.id ?? "");
    const draft = await new TaskDraftStore(taskDraftsPath(args)).find(id);
    return taskDraftShowReport(id, draft);
  }
  if (command.type === "tasks:list") {
    const tasks = await new TaskStore(tasksPath(args)).listActive();
    return tasksListReport(tasks);
  }
  if (command.type === "tasks:show") {
    const id = String(command.args?.id ?? "");
    const task = (await new TaskStore(tasksPath(args)).list()).find((item) => item.id === id);
    return taskShowReport(id, task);
  }
  if (command.type === "ops:next-action") {
    return nextActionReport({
      runs: await new RunIndex(runsPath(args)).list(),
      tasks: await new TaskStore(tasksPath(args)).list(),
      lifecycles: await new RunLifecycleStore(runLifecyclePath(args)).list(),
    });
  }
  if (command.type === "dashboard:build") {
    const out = resolve(flag(args, "out", join(root, "dashboard/index.html")));
    await buildDashboard(args, out);
    return `# dashboard:build\n\nWrote ${out}`;
  }

  throw new Error(`unsupported inbox command: ${command.type}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "live:format") {
    await formatLiveLogFromStdin();
    return;
  }

  if (args.command === "runs:list") {
    printJson(await new RunIndex(runsPath(args)).list());
    return;
  }

  if (args.command === "runs:show") {
    const runId = args.positionals[0];
    if (!runId) throw new Error("usage: runs:show <run-id>");
    const summary = await new RunIndex(runsPath(args)).find(runId);
    const log = summary ? await readJson(summary.logPath).catch(() => undefined) : undefined;
    printJson({ summary, log });
    return;
  }

  if (args.command === "tasks:add") {
    const taskPath = args.positionals[0];
    if (!taskPath) throw new Error("usage: tasks:add <task.json>");
    const task = await readJson<TaskSpec>(resolve(taskPath));
    await new TaskStore(tasksPath(args)).append(task);
    printJson({ added: task.id });
    return;
  }

  if (args.command === "tasks:list") {
    const taskStore = new TaskStore(tasksPath(args));
    printJson(args.flags.get("include-archived") === true ? await taskStore.list() : await taskStore.listActive());
    return;
  }

  if (args.command === "tasks:show") {
    const taskId = args.positionals[0];
    if (!taskId) throw new Error("usage: tasks:show <task-id>");
    printJson((await new TaskStore(tasksPath(args)).find(taskId)) ?? null);
    return;
  }

  if (args.command === "tasks:dispatch") {
    const taskId = args.positionals[0];
    const repoRoot = flag(args, "repo-root", "");
    if (!taskId || !repoRoot) throw new Error("usage: tasks:dispatch <task-id> --repo-root=<repo> [--execute]");

    const taskStore = new TaskStore(tasksPath(args));
    const task = await taskStore.find(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "pending") throw new Error(`task must be pending to dispatch: ${task.status}`);

    const agent = await loadAgentProfile(args, task.targetAgent);
    const execute = args.flags.get("execute") === true;
    const allocate = args.flags.get("allocate") === true || (execute && agent.worktreePolicy === "per-task");
    const worktreesDir = flag(args, "worktrees-dir", "");
    const baseLogDir = logDir(args);
    const startedAt = new Date().toISOString();
    const runId = buildWorkerRunId({ startedAt, taskId: task.id });
    const liveLogPath = args.flags.get("tmux") === true || args.flags.get("live-log") === true
      ? buildWorkerLiveLogPath(baseLogDir, runId)
      : undefined;
    const input = {
      task,
      agent,
      repoRoot: resolve(repoRoot),
      allocate,
      worktreesDir: worktreesDir || undefined,
      ...(liveLogPath ? { liveLogPath, runId } : {}),
    };

    if (!execute) {
      printJson(await prepareWorkerDispatch(input));
      return;
    }

    let tmux: TmuxObserverResult | undefined;
    if (args.flags.get("tmux") === true && liveLogPath) {
      tmux = await startTmuxObserver({
        sessionName: flag(args, "tmux-session", "samantha"),
        taskId: task.id,
        runId,
        liveLogPath,
        cwd: root,
        formatterCommand: "bun run src/samantha.ts live:format",
      });
    }
    const execution = await executeWorkerDispatch(input);
    const finishedAt = new Date().toISOString();
    const logInput = {
      ...input,
      execute: true,
      startedAt,
      finishedAt,
      execution,
    };
    const runLog = await writeWorkerRunLog(baseLogDir, logInput);
    const runSummary = summarizeWorkerRun({ ...logInput, runId: runLog.runId, logPath: runLog.path });
    await new RunIndex(runsPath(args)).append(runSummary);
    await taskStore.updateStatus(task.id, runSummary.pass ? "completed" : "failed");
    printJson({
      runLog,
      runSummary,
      ...(liveLogPath ? { liveLog: { path: liveLogPath } } : {}),
      ...(tmux ? { tmux } : {}),
    });
    if (!runSummary.pass) process.exitCode = 1;
    return;
  }

  if (args.command === "tasks:retry") {
    const taskId = args.positionals[0];
    if (!taskId) throw new Error("usage: tasks:retry <task-id>");
    const taskStore = new TaskStore(tasksPath(args));
    const task = await taskStore.find(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "failed" && task.status !== "blocked") {
      throw new Error(`task must be failed or blocked to retry: ${task.status}`);
    }
    printJson(await taskStore.updateStatus(task.id, "pending"));
    return;
  }

  if (args.command === "tasks:archive") {
    const taskId = args.positionals[0];
    const reason = flag(args, "reason", "");
    if (!taskId || !reason.trim()) throw new Error("usage: tasks:archive <task-id> --reason=<text>");
    printJson(await new TaskStore(tasksPath(args)).archive(taskId, {
      archivedAt: new Date().toISOString(),
      reason,
    }));
    return;
  }

  if (args.command === "tasks:finalize-worktree") {
    const taskId = args.positionals[0];
    const repoRootFlag = flag(args, "repo-root", "");
    if (!taskId || !repoRootFlag) {
      throw new Error("usage: tasks:finalize-worktree <task-id> --repo-root=<repo> [--worktree=<path>] [--note=<text>]");
    }

    const taskStore = new TaskStore(tasksPath(args));
    const task = await taskStore.find(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);

    const agent = await loadAgentProfile(args, task.targetAgent);
    const repoRoot = await gitTopLevel(resolve(repoRootFlag));
    const worktreesDir = flag(args, "worktrees-dir", "");
    const worktreePath = resolve(
      flag(args, "worktree", worktreePathForTask(repoRoot, task.id, worktreesDir || undefined)),
    );
    const baseCommit = await gitHead(repoRoot);
    const note = flag(args, "note", "manual finalize passed");
    const output = `HARNESS_RESULT: ${JSON.stringify({ status: "pass", note, commit: "" })}`;
    const startedAt = new Date().toISOString();
    const evaluation = await evaluateWorkerResult({
      task,
      cwd: worktreePath,
      baseCommit,
      output,
    });
    const commit =
      evaluation.pass && agent.writerClass === "writer"
        ? await commitWorkerChanges({
            task,
            cwd: worktreePath,
            files: evaluation.changedFiles,
          })
        : undefined;
    const commitPassed = !commit || (commit.add.exitCode === 0 && commit.commit.exitCode === 0);
    const finishedAt = new Date().toISOString();
    const execution = {
      preparation: {
        taskId: task.id,
        agentId: agent.id,
        worktreePath,
        allocation: {
          taskId: task.id,
          repoRoot,
          worktreePath,
          branch: branchForTask(task.id),
          baseCommit,
        },
        codex: {
          prompt: "Manual finalize of an existing worker worktree.",
          command: ["manual", "finalize-worktree"],
        },
      },
      setupResults: [],
      command: {
        command: ["manual", "finalize-worktree"],
        exitCode: 0,
        stdout: output,
        stderr: "",
      },
      evaluation,
      commit,
      pass: evaluation.pass && commitPassed,
    };
    const logInput = {
      task,
      agent,
      repoRoot,
      allocate: true,
      execute: true,
      worktreesDir: worktreesDir || undefined,
      startedAt,
      finishedAt,
      execution,
    };
    const runLog = await writeWorkerRunLog(resolve(flag(args, "log-dir", join(root, "runs"))), logInput);
    const runSummary = summarizeWorkerRun({ ...logInput, runId: runLog.runId, logPath: runLog.path });
    await new RunIndex(runsPath(args)).append(runSummary);
    await taskStore.updateStatus(task.id, runSummary.pass ? "completed" : "failed");
    printJson({ runLog, runSummary });
    if (!runSummary.pass) process.exitCode = 1;
    return;
  }

  if (args.command === "proposals:list") {
    printJson(await new ProposalStore(proposalsPath(args)).list());
    return;
  }

  if (args.command === "proposals:show") {
    const proposalId = args.positionals[0];
    if (!proposalId) throw new Error("usage: proposals:show <proposal-id>");
    printJson((await new ProposalStore(proposalsPath(args)).find(proposalId)) ?? null);
    return;
  }

  if (args.command === "proposals:accept" || args.command === "proposals:reject") {
    const proposalId = args.positionals[0];
    if (!proposalId) throw new Error(`usage: ${args.command} <proposal-id> [--note=<text>]`);
    const status = args.command === "proposals:accept" ? "accepted" : "rejected";
    printJson(
      await new ProposalStore(proposalsPath(args)).updateStatus(proposalId, status, {
        reviewedAt: new Date().toISOString(),
        reviewNote: typeof args.flags.get("note") === "string" ? String(args.flags.get("note")) : undefined,
      }),
    );
    return;
  }

  if (args.command === "proposals:draft-task") {
    const proposalId = args.positionals[0];
    if (!proposalId) throw new Error("usage: proposals:draft-task <proposal-id>");
    const proposal = await new ProposalStore(proposalsPath(args)).find(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    const draft = taskDraftFromProposal(proposal, new Date().toISOString());
    await new TaskDraftStore(taskDraftsPath(args)).append(draft);
    printJson(draft);
    return;
  }

  if (args.command === "drafts:list") {
    printJson(await new TaskDraftStore(taskDraftsPath(args)).list());
    return;
  }

  if (args.command === "drafts:show") {
    const draftId = args.positionals[0];
    if (!draftId) throw new Error("usage: drafts:show <draft-id>");
    printJson((await new TaskDraftStore(taskDraftsPath(args)).find(draftId)) ?? null);
    return;
  }

  if (args.command === "drafts:check") {
    const draftId = args.positionals[0];
    if (!draftId) throw new Error("usage: drafts:check <draft-id>");
    const draft = await new TaskDraftStore(taskDraftsPath(args)).find(draftId);
    const result = checkTaskDraft(draft, { knownAgentIds: await knownAgentIds(args) });
    printJson({
      check: result,
      readiness: taskDraftReadiness(draft, {
        knownAgentIds: await knownAgentIds(args),
        projectId: flag(args, "project", "") || undefined,
      }),
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "drafts:template") {
    const draftId = args.positionals[0];
    if (!draftId) throw new Error("usage: drafts:template <draft-id> [--project=<id>]");
    const draft = await new TaskDraftStore(taskDraftsPath(args)).find(draftId);
    if (!draft) throw new Error(`task draft not found: ${draftId}`);
    const projectId = flag(args, "project", "");
    const defaults = projectId ? applyProjectDefaults({}, await loadProjectProfile(projectProfilesDir(args), projectId)) : {};
    printJson(taskDraftPatchTemplate(draft, defaults));
    return;
  }

  if (args.command === "drafts:update") {
    const draftId = args.positionals[0];
    const from = flag(args, "from", "");
    if (!draftId || !from) throw new Error("usage: drafts:update <draft-id> --from=<draft-patch.json>");
    const projectId = flag(args, "project", "");
    const patch = parseTaskDraftUpdatePatch(await readJson<unknown>(resolve(from)));
    const nextPatch = projectId
      ? applyProjectDefaults(patch, await loadProjectProfile(projectProfilesDir(args), projectId))
      : patch;
    const updated = await new TaskDraftStore(taskDraftsPath(args)).update(draftId, nextPatch, new Date().toISOString());
    printJson({
      draft: updated,
      check: checkTaskDraft(updated, { knownAgentIds: await knownAgentIds(args) }),
      readiness: taskDraftReadiness(updated, {
        knownAgentIds: await knownAgentIds(args),
        projectId: projectId || undefined,
      }),
    });
    return;
  }

  if (args.command === "drafts:prepare") {
    const draftId = args.positionals[0];
    const projectId = flag(args, "project", "");
    if (!draftId || !projectId) throw new Error("usage: drafts:prepare <draft-id> --project=<id> [--from=<draft-patch.json>]");
    const from = flag(args, "from", "");
    const patch = parseTaskDraftUpdatePatch(from ? await readJson<unknown>(resolve(from)) : {});
    const project = await loadProjectProfile(projectProfilesDir(args), projectId);
    const before = await new TaskDraftStore(taskDraftsPath(args)).find(draftId);
    const updated = await new TaskDraftStore(taskDraftsPath(args)).update(
      draftId,
      applyProjectDefaults(patch, project),
      new Date().toISOString(),
    );
    printJson({
      project,
      before: before
        ? {
            targetFiles: before.targetFiles.length,
            forbiddenChanges: before.forbiddenChanges.length,
            setupCommands: before.setupCommands?.length ?? 0,
            verifyCommands: before.verifyCommands.length,
          }
        : undefined,
      draft: updated,
      check: checkTaskDraft(updated, { knownAgentIds: await knownAgentIds(args) }),
      readiness: taskDraftReadiness(updated, { knownAgentIds: await knownAgentIds(args), projectId }),
    });
    return;
  }

  if (args.command === "drafts:approve") {
    const draftId = args.positionals[0];
    if (!draftId) throw new Error("usage: drafts:approve <draft-id>");
    const draftStore = new TaskDraftStore(taskDraftsPath(args));
    const draft = await draftStore.find(draftId);
    const check = checkTaskDraft(draft, { knownAgentIds: await knownAgentIds(args) });
    if (!check.ok || !draft) {
      printJson({
        check,
        readiness: taskDraftReadiness(draft, { knownAgentIds: await knownAgentIds(args) }),
      });
      process.exitCode = 1;
      return;
    }
    const task = taskSpecFromDraft(draft);
    await new TaskStore(tasksPath(args)).append(task);
    const approved = await draftStore.markApproved(draft.id, new Date().toISOString());
    printJson({ approved: approved.id, task });
    return;
  }

  if (args.command === "merge:check") {
    printJson(
      await evaluateMergeGate({
        runLogPath: resolve(flag(args, "run-log", "")),
        repoRoot: resolve(flag(args, "repo-root", ".")),
        targetBranch: flag(args, "target-branch", "main"),
      }),
    );
    return;
  }

  if (args.command === "merge:apply") {
    const runLogPath = resolve(flag(args, "run-log", ""));
    const repoRoot = resolve(flag(args, "repo-root", "."));
    const result = await applyMerge({
      runLogPath,
      repoRoot,
      targetBranch: flag(args, "target-branch", "main"),
    });
    let lifecycle;
    if ((result.applied && result.verified) || (result.gate.alreadyMerged && result.violations.length === 0)) {
      lifecycle = await new RunLifecycleStore(runLifecyclePath(args)).mark(
        lifecycleBaseFromRunLog({
          log: await readWorkerRunLog(runLogPath),
          runLogPath,
          repoRoot,
          updatedAt: new Date().toISOString(),
        }),
        "merged",
        new Date().toISOString(),
      );
    }
    printJson({ ...result, lifecycle });
    return;
  }

  if (args.command === "merge:push") {
    const runLogFlag = flag(args, "run-log", "");
    const repoRoot = resolve(flag(args, "repo-root", "."));
    const branch = flag(args, "branch", "main");
    const remote = flag(args, "remote", "origin");
    let resolvedRunLogPath = "";
    let preflight;
    if (runLogFlag) {
      resolvedRunLogPath = resolve(runLogFlag);
      preflight = await evaluateMergeGate({
        runLogPath: resolvedRunLogPath,
        repoRoot,
        targetBranch: branch,
      });
      if (!preflight.alreadyMerged || preflight.violations.length > 0) {
        printJson({
          mayPush: false,
          remote,
          branch,
          preflight,
          violations: [
            ...preflight.violations,
            ...(preflight.alreadyMerged ? [] : ["run commit is not integrated; run merge:apply first"]),
          ],
        });
        return;
      }
    }
    const result = await pushMerge({
      repoRoot,
      remote,
      branch,
    });
    let lifecycle;
    if (resolvedRunLogPath && result.mayPush) {
      lifecycle = await new RunLifecycleStore(runLifecyclePath(args)).mark(
        lifecycleBaseFromRunLog({
          log: await readWorkerRunLog(resolvedRunLogPath),
          runLogPath: resolvedRunLogPath,
          repoRoot,
          updatedAt: new Date().toISOString(),
        }),
        "pushed",
        new Date().toISOString(),
      );
    }
    printJson({ ...result, preflight, lifecycle });
    return;
  }

  if (args.command === "next-action" || args.command === "ops:next-action") {
    printJson({
      report: nextActionReport({
        runs: await new RunIndex(runsPath(args)).list(),
        tasks: await new TaskStore(tasksPath(args)).list(),
        lifecycles: await new RunLifecycleStore(runLifecyclePath(args)).list(),
      }),
    });
    return;
  }

  if (args.command === "runs:mark-lifecycle") {
    const runLogFlag = flag(args, "run-log", "");
    const repoRoot = resolve(flag(args, "repo-root", "."));
    if (!runLogFlag) throw new Error("usage: runs:mark-lifecycle --run-log=<path> --repo-root=<repo> [--merged] [--pushed] [--cleaned]");
    const runLogPath = resolve(runLogFlag);
    const log = await readWorkerRunLog(runLogPath);
    const store = new RunLifecycleStore(runLifecyclePath(args));
    let lifecycle = lifecycleBaseFromRunLog({
      log,
      runLogPath,
      repoRoot,
      updatedAt: new Date().toISOString(),
    });
    if (args.flags.get("merged") === true) lifecycle = await store.mark(lifecycle, "merged", new Date().toISOString());
    if (args.flags.get("pushed") === true) lifecycle = await store.mark(lifecycle, "pushed", new Date().toISOString());
    if (args.flags.get("cleaned") === true) lifecycle = await store.mark(lifecycle, "cleaned", new Date().toISOString());
    printJson(lifecycle);
    return;
  }

  if (args.command === "worktree:cleanup") {
    const runLogPath = resolve(flag(args, "run-log", ""));
    const repoRoot = resolve(flag(args, "repo-root", "."));
    const result = await cleanupCompletedWorktree({
      runLogPath,
      repoRoot,
      targetBranch: flag(args, "target-branch", "main"),
      deleteBranch: args.flags.get("keep-branch") !== true,
    });
    let lifecycle;
    if (result.cleaned) {
      lifecycle = await new RunLifecycleStore(runLifecyclePath(args)).mark(
        lifecycleBaseFromRunLog({
          log: await readWorkerRunLog(runLogPath),
          runLogPath,
          repoRoot,
          updatedAt: new Date().toISOString(),
        }),
        "cleaned",
        new Date().toISOString(),
      );
    }
    printJson({ ...result, lifecycle });
    return;
  }

  if (args.command === "health:check") {
    const result = await checkDaemonHealth({
      heartbeatPath: heartbeatPath(args),
      lockPath: daemonLockPath(args),
      maxAgeMs: Number(flag(args, "max-age-ms", "15000")),
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "doctor" || args.command === "ops:doctor") {
    const snapshot = await collectOps(args);
    if (args.flags.get("json") === true) {
      printJson(snapshot);
    } else {
      console.log(doctorReport(snapshot));
    }
    if (!snapshot.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "plan:run") {
    const planPath = args.positionals[0];
    if (!planPath) throw new Error("usage: plan:run <plan.json> [--execute]");
    printJson(
      await runPlan({
        planPath: resolve(planPath),
        execute: args.flags.get("execute") === true,
        logDir: resolve(flag(args, "log-dir", join(root, "runs"))),
        stateDir: stateDir(args),
      }),
    );
    return;
  }

  if (args.command === "inbox:process" || args.command === "inbox:watch") {
    const inboxDir = resolve(flag(args, "inbox-dir", join(root, "inbox")));
    const outboxDir = resolve(flag(args, "outbox-dir", join(root, "outbox")));
    const archiveDir = resolve(flag(args, "archive-dir", join(root, "archive/inbox")));
    const intervalMs = Number(flag(args, "interval-ms", "5000"));
    const isWatch = args.command === "inbox:watch";
    const lock = isWatch
      ? await acquireDaemonLock({
          lockPath: daemonLockPath(args),
          command: "inbox:watch",
        })
      : undefined;
    let stopping = false;
    let processedTotal = 0;
    const stop = () => {
      stopping = true;
    };

    if (isWatch) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }

    try {
      do {
        const processed = await processInbox({
          inboxDir,
          outboxDir,
          archiveDir,
          handle: (command) => handleInboxCommand(command, args),
        });
        processedTotal += processed.length;
        if (isWatch && lock) {
          await writeDaemonHeartbeat(heartbeatPath(args), {
            schemaVersion: 1,
            pid: process.pid,
            command: "inbox:watch",
            status: stopping ? "stopping" : "running",
            lockPath: lock.path,
            inboxDir,
            outboxDir,
            archiveDir,
            processedTotal,
            updatedAt: new Date().toISOString(),
          });
        }
        if (args.command === "inbox:process") {
          printJson({ processed });
          return;
        }
        await Bun.sleep(Number.isFinite(intervalMs) ? intervalMs : 5000);
      } while (!stopping);
    } finally {
      await lock?.release();
    }
    return;
  }

  if (args.command === "remote:enqueue") {
    const inputPath = args.positionals[0];
    if (!inputPath) throw new Error("usage: remote:enqueue <remote-command.json>");
    printJson(
      await enqueueRemoteCommand({
        inputPath: resolve(inputPath),
        inboxDir: resolve(flag(args, "inbox-dir", join(root, "inbox"))),
        allowedSenderId: flag(args, "allowed-sender-id", ""),
      }),
    );
    return;
  }

  if (args.command === "telegram:poll") {
    const token = flag(args, "bot-token", process.env.TELEGRAM_BOT_TOKEN ?? "");
    const allowedSenderId = flag(
      args,
      "allowed-sender-id",
      process.env.TELEGRAM_ALLOWED_SENDER_ID ?? process.env.TELEGRAM_CHAT_ID ?? "",
    );
    const offsetPath = telegramOffsetPath(args);
    const storedOffset = await readOptionalJson<{ nextOffset?: number }>(offsetPath);
    const explicitOffset = args.flags.get("offset");
    const offset = typeof explicitOffset === "string" ? Number(explicitOffset) : storedOffset?.nextOffset;
    const result = await pollTelegramToInbox({
      token,
      allowedSenderId,
      inboxDir: resolve(flag(args, "inbox-dir", join(root, "inbox"))),
      offset,
      limit: Number(flag(args, "limit", "10")),
      timeoutSeconds: Number(flag(args, "timeout-seconds", "0")),
    });
    if (result.nextOffset !== undefined) {
      await mkdir(stateDir(args), { recursive: true });
      await writeFile(offsetPath, `${JSON.stringify({ nextOffset: result.nextOffset }, null, 2)}\n`, "utf8");
    }
    printJson(result);
    return;
  }

  if (args.command === "telegram:reply") {
    const token = flag(args, "bot-token", process.env.TELEGRAM_BOT_TOKEN ?? "");
    const chatId = flag(
      args,
      "chat-id",
      process.env.TELEGRAM_REPLY_CHAT_ID ??
        process.env.TELEGRAM_CHAT_ID ??
        process.env.TELEGRAM_ALLOWED_SENDER_ID ??
        "",
    );
    printJson(
      await sendOutboxReplies({
        token,
        chatId,
        outboxDir: resolve(flag(args, "outbox-dir", join(root, "outbox"))),
        statePath: telegramRepliesPath(args),
        limit: Number(flag(args, "limit", "10")),
        minAgeMs: Number(flag(args, "min-age-ms", "1000")),
        markExisting: args.flags.get("mark-existing") === true,
        sendExisting: args.flags.get("send-existing") === true,
      }),
    );
    return;
  }

  if (args.command === "dashboard:build") {
    const out = resolve(flag(args, "out", join(root, "dashboard/index.html")));
    const runs = await buildDashboard(args, out);
    printJson({ out, runs });
    return;
  }

  if (args.command === "dashboard:serve") {
    await serveDashboard(args);
    return;
  }

  console.log(
    [
      "usage: bun run samantha <command>",
      "",
      "commands:",
      "  runs:list",
      "  runs:show <run-id>",
      "  runs:mark-lifecycle --run-log=<path> --repo-root=<repo> [--merged] [--pushed] [--cleaned]",
      "  tasks:add <task.json>",
      "  tasks:list",
      "  tasks:list --include-archived",
      "  tasks:show <task-id>",
      "  tasks:archive <task-id> --reason=<text>",
      "  tasks:dispatch <task-id> --repo-root=<repo> [--execute] [--tmux] [--live-log]",
      "  tasks:finalize-worktree <task-id> --repo-root=<repo> [--worktree=<path>] [--note=<text>]",
      "  tasks:retry <task-id>",
      "  next-action",
      "  proposals:list",
      "  proposals:show <proposal-id>",
      "  proposals:accept <proposal-id> [--note=<text>]",
      "  proposals:reject <proposal-id> [--note=<text>]",
      "  proposals:draft-task <proposal-id>",
      "  drafts:list",
      "  drafts:show <draft-id>",
      "  drafts:check <draft-id>",
      "  drafts:template <draft-id> [--project=<id>]",
      "  drafts:update <draft-id> --from=<draft-patch.json>",
      "  drafts:prepare <draft-id> --project=<id> [--from=<draft-patch.json>]",
      "  drafts:approve <draft-id>",
      "  merge:check --run-log=<path> --repo-root=<repo>",
      "  merge:apply --run-log=<path> --repo-root=<repo>",
      "  merge:push --repo-root=<repo> [--run-log=<path>] [--remote=origin] [--branch=main]",
      "  worktree:cleanup --run-log=<path> --repo-root=<repo> [--keep-branch]",
      "  health:check [--max-age-ms=15000]",
      "  doctor [--json]",
      "  plan:run <plan.json> [--execute]",
      "  inbox:process",
      "  inbox:watch",
      "  remote:enqueue <remote-command.json>",
      "  telegram:poll [--allowed-sender-id=<id>] [--bot-token=<token>]",
      "  telegram:reply [--chat-id=<id>] [--mark-existing] [--send-existing]",
      "  dashboard:build",
      "  dashboard:serve [--port=4173] [--host=127.0.0.1]",
      "  live:format",
    ].join("\n"),
  );
}

await main();
