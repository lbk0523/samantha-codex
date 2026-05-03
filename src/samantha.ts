import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TaskSpec } from "./lib/contracts";
import { writeDashboard } from "./lib/dashboard";
import { processInbox, type InboxCommand } from "./lib/inbox";
import { RunIndex } from "./lib/ledger";
import { applyMerge, evaluateMergeGate, pushMerge } from "./lib/merge-gate";
import { runPlan } from "./lib/plan-runner";
import { enqueueRemoteCommand } from "./lib/remote-command";
import { TaskStore } from "./lib/task-store";
import { cleanupCompletedWorktree } from "./lib/worktree-cleanup";

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

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function handleInboxCommand(command: InboxCommand, args: ParsedArgs): Promise<string> {
  if (command.type === "runs:list") {
    const runs = await new RunIndex(runsPath(args)).list();
    return `# runs:list\n\n\`\`\`json\n${JSON.stringify(runs, null, 2)}\n\`\`\``;
  }
  if (command.type === "tasks:list") {
    const tasks = await new TaskStore(tasksPath(args)).list();
    return `# tasks:list\n\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\``;
  }
  if (command.type === "tasks:show") {
    const id = String(command.args?.id ?? "");
    const task = (await new TaskStore(tasksPath(args)).list()).find((item) => item.id === id);
    return `# tasks:show ${id}\n\n\`\`\`json\n${JSON.stringify(task ?? null, null, 2)}\n\`\`\``;
  }
  if (command.type === "dashboard:build") {
    const runs = await new RunIndex(runsPath(args)).list();
    const out = resolve(flag(args, "out", join(root, "dashboard/index.html")));
    await writeDashboard(out, runs);
    return `# dashboard:build\n\nWrote ${out}`;
  }

  throw new Error(`unsupported inbox command: ${command.type}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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
    printJson(await new TaskStore(tasksPath(args)).list());
    return;
  }

  if (args.command === "tasks:show") {
    const taskId = args.positionals[0];
    if (!taskId) throw new Error("usage: tasks:show <task-id>");
    printJson((await new TaskStore(tasksPath(args)).list()).find((task) => task.id === taskId) ?? null);
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
    printJson(
      await applyMerge({
        runLogPath: resolve(flag(args, "run-log", "")),
        repoRoot: resolve(flag(args, "repo-root", ".")),
        targetBranch: flag(args, "target-branch", "main"),
      }),
    );
    return;
  }

  if (args.command === "merge:push") {
    printJson(
      await pushMerge({
        repoRoot: resolve(flag(args, "repo-root", ".")),
        remote: flag(args, "remote", "origin"),
        branch: flag(args, "branch", "main"),
      }),
    );
    return;
  }

  if (args.command === "worktree:cleanup") {
    printJson(
      await cleanupCompletedWorktree({
        runLogPath: resolve(flag(args, "run-log", "")),
        repoRoot: resolve(flag(args, "repo-root", ".")),
        targetBranch: flag(args, "target-branch", "main"),
        deleteBranch: args.flags.get("keep-branch") !== true,
      }),
    );
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

    do {
      const processed = await processInbox({
        inboxDir,
        outboxDir,
        archiveDir,
        handle: (command) => handleInboxCommand(command, args),
      });
      if (args.command === "inbox:process") {
        printJson({ processed });
        return;
      }
      await Bun.sleep(Number.isFinite(intervalMs) ? intervalMs : 5000);
    } while (true);
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

  if (args.command === "dashboard:build") {
    const runs = await new RunIndex(runsPath(args)).list();
    const out = resolve(flag(args, "out", join(root, "dashboard/index.html")));
    await writeDashboard(out, runs);
    printJson({ out, runs: runs.length });
    return;
  }

  console.log(
    [
      "usage: bun run samantha <command>",
      "",
      "commands:",
      "  runs:list",
      "  runs:show <run-id>",
      "  tasks:add <task.json>",
      "  tasks:list",
      "  tasks:show <task-id>",
      "  merge:check --run-log=<path> --repo-root=<repo>",
      "  merge:apply --run-log=<path> --repo-root=<repo>",
      "  merge:push --repo-root=<repo> [--remote=origin] [--branch=main]",
      "  worktree:cleanup --run-log=<path> --repo-root=<repo> [--keep-branch]",
      "  plan:run <plan.json> [--execute]",
      "  inbox:process",
      "  inbox:watch",
      "  remote:enqueue <remote-command.json>",
      "  dashboard:build",
    ].join("\n"),
  );
}

await main();
