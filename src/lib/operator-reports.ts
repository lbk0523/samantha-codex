import type { TaskSpec } from "./contracts";
import type { DaemonHealthResult, DaemonHeartbeat } from "./daemon";
import type { RunSummary } from "./ledger";
import type { OpsSnapshot } from "./ops-diagnostics";
import type { ProposalRecord } from "./proposal-store";
import { remoteActionCommand, type RemoteActionRecord } from "./remote-action-store";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { TaskDraftRecord } from "./task-draft-store";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function code(value: string): string {
  return `\`${oneLine(value).replace(/`/g, "'")}\``;
}

function recent<T>(items: T[], limit: number): T[] {
  return [...items].slice(-limit).reverse();
}

function shortCommit(commit: string): string {
  return commit ? commit.slice(0, 12) : "";
}

function runLine(run: RunSummary): string {
  const commit = shortCommit(run.commit);
  const reason = run.failureReason ? ` reason=${code(run.failureReason)}` : "";
  return [
    `- ${code(run.runId)}`,
    `outcome=${code(run.outcome)}`,
    `task=${code(run.taskId)}`,
    `finished=${code(run.finishedAt)}`,
    commit ? `commit=${code(commit)}` : "",
    reason,
  ]
    .filter(Boolean)
    .join(" ");
}

function taskLine(task: TaskSpec): string {
  const archive = task.status === "archived" && task.archiveReason ? ` reason=${code(task.archiveReason)}` : "";
  return `- ${code(task.id)} status=${code(task.status)} agent=${code(task.targetAgent)}${archive}`;
}

function proposalLine(proposal: ProposalRecord): string {
  return `- ${code(proposal.id)} status=${code(proposal.status)} created=${code(proposal.createdAt)} text=${oneLine(proposal.text)}`;
}

function draftLine(draft: TaskDraftRecord): string {
  return `- ${code(draft.id)} status=${code(draft.status)} source=${code(draft.sourceProposalId)} created=${code(draft.createdAt)} title=${oneLine(draft.title)}`;
}

function remoteActionLine(action: RemoteActionRecord): string {
  return `- ${code(action.id)} status=${code(action.status)} kind=${code(action.kind)} task=${code(action.taskId)} created=${code(action.createdAt)}`;
}

function lifecycleText(lifecycle: RunLifecycleRecord | undefined): string {
  if (!lifecycle) return "missing";
  return `merged=${lifecycle.mergedAt ? "yes" : "no"} pushed=${lifecycle.pushedAt ? "yes" : "no"} cleaned=${lifecycle.cleanedAt ? "yes" : "no"}`;
}

function latestReplyFailure(snapshot: OpsSnapshot): string {
  const failure = snapshot.telegram.replyState?.failures?.at(-1);
  if (!failure) return "none";
  return `${failure.file} attempts=${failure.attempts} error=${failure.lastError}`;
}

function nextActionLinesForRun(run: RunSummary): string[] {
  if (run.pass && run.commit) {
    return [
      "Suggested local next action:",
      code(`bun run samantha merge:check --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
      code(`bun run samantha merge:apply --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
      "After merge/push, cleanup:",
      code(`bun run samantha worktree:cleanup --run-log=${run.logPath} --repo-root=${run.repoRoot}`),
    ];
  }

  if (run.outcome === "blocked") {
    return [
      "Suggested local next action:",
      "Fix or verify the existing worker worktree, then finalize it if the changed files are acceptable.",
      code(`bun run samantha tasks:finalize-worktree ${run.taskId} --repo-root=${run.repoRoot} --worktree=${run.worktreePath}`),
    ];
  }

  if (!run.pass) {
    return [
      "Suggested local next action:",
      "Inspect the run log and retry only after the cause is understood.",
      code(`bun run samantha runs:show ${run.runId}`),
      code(`bun run samantha tasks:retry ${run.taskId}`),
    ];
  }

  return ["Suggested local next action: none"];
}

export function remoteHelpReport(mode: "basic" | "advanced" = "basic"): string {
  if (mode === "advanced") {
    return [
      "# remote:help advanced",
      "",
      "Inspection:",
      "- `/runs`, `/run_latest`, `/run <run_id>`, `/failures`",
      "- `/tasks`, `/task <task_id>`",
      "- `/actions`, `/action_current`, `/action <action_id>`",
      "- `/proposals`, `/proposal_next`, `/proposal <proposal_id>`",
      "- `/drafts`, `/draft_next`, `/draft <draft_id>`",
      "",
      "Explicit workflow:",
      "- `/propose <text>`",
      "- `/draft_propose <text>`",
      "- `/accept <proposal_id>`, `/reject <proposal_id>`",
      "- `/prepare_dispatch <task_id>`",
      "- `/approve_action <action_id>`",
      "",
      "System:",
      "- `/status`, `/doctor`, `/health`, `/dashboard`, `/next_action`",
      "",
      "Remote commands are safe-gated. They cannot dispatch workers directly, merge, push, clean worktrees, or run shell commands.",
    ].join("\n");
  }

  return [
    "# remote:help",
    "",
    "Main flow:",
    "",
    "- `/now`: show the one next command to send",
    "- `/work <request>`: capture new work as a draft",
    "- `/run_next`: prepare the next pending task for approval",
    "- `/yes`: approve the latest prepared action",
    "- `/check`: compact status",
    "- `/problems`: diagnostics when something looks wrong",
    "",
    "Typical execution:",
    "`/now` -> `/run_next` -> `/yes`",
    "",
    "More commands: `/help_advanced`",
  ].join("\n");
}

export function runsListReport(runs: RunSummary[], limit = 10): string {
  const lines = recent(runs, limit).map(runLine);
  return ["# runs:list", "", `Total runs: ${runs.length}`, "", ...(lines.length ? lines : ["No runs recorded."])].join("\n");
}

export function runShowReport(runId: string, run: RunSummary | undefined): string {
  if (!run) {
    return ["# runs:show", "", `Run not found: ${code(runId)}`].join("\n");
  }

  return [
    "# runs:show",
    "",
    `Run: ${code(run.runId)}`,
    `Outcome: ${code(run.outcome)}`,
    `Pass: ${run.pass ? "yes" : "no"}`,
    `Task: ${code(run.taskId)} - ${oneLine(run.taskTitle)}`,
    `Agent: ${code(run.agentId)}`,
    `Started: ${code(run.startedAt)}`,
    `Finished: ${code(run.finishedAt)}`,
    run.commit ? `Commit: ${code(run.commit)}` : "Commit: none",
    run.failureReason ? `Failure: ${code(run.failureReason)}` : "",
    `Log: ${code(run.logPath)}`,
    "",
    ...nextActionLinesForRun(run),
  ]
    .filter(Boolean)
    .join("\n");
}

export function nextActionReport(input: { runs: RunSummary[]; tasks: TaskSpec[]; lifecycles?: RunLifecycleRecord[] }): string {
  const activeTasks = input.tasks.filter((task) => task.status !== "archived");
  const pending = activeTasks.find((task) => task.status === "pending");
  if (pending) {
    return [
      "# next-action",
      "",
      "Pending task found.",
      `Task: ${code(pending.id)}`,
      "",
      "Suggested local next action:",
      code(`bun run samantha tasks:dispatch ${pending.id} --repo-root=<repo>`),
      code(`bun run samantha tasks:dispatch ${pending.id} --repo-root=<repo> --execute`),
    ].join("\n");
  }

  const latest = input.runs.at(-1);
  if (latest) {
    if (latest.pass && latest.commit) {
      const lifecycle = input.lifecycles?.find((record) => record.runId === latest.runId);
      if (lifecycle?.cleanedAt) {
        return [
          "# next-action",
          "",
          `Latest run: ${code(latest.runId)}`,
          "",
          "No immediate action.",
          `Lifecycle: merged=${lifecycle.mergedAt ? "yes" : "no"} pushed=${lifecycle.pushedAt ? "yes" : "no"} cleaned=yes`,
        ].join("\n");
      }
      if (lifecycle?.pushedAt) {
        return [
          "# next-action",
          "",
          `Latest run: ${code(latest.runId)}`,
          "",
          "Suggested local next action:",
          code(`bun run samantha worktree:cleanup --run-log=${latest.logPath} --repo-root=${latest.repoRoot}`),
        ].join("\n");
      }
      if (lifecycle?.mergedAt) {
        return [
          "# next-action",
          "",
          `Latest run: ${code(latest.runId)}`,
          "",
          "Suggested local next action:",
          code(`bun run samantha merge:push --run-log=${latest.logPath} --repo-root=${latest.repoRoot}`),
        ].join("\n");
      }
      return [
        "# next-action",
        "",
        `Latest run: ${code(latest.runId)}`,
        "",
        "Suggested local next action:",
        code(`bun run samantha merge:check --run-log=${latest.logPath} --repo-root=${latest.repoRoot}`),
      ].join("\n");
    }
    return ["# next-action", "", `Latest run: ${code(latest.runId)}`, "", ...nextActionLinesForRun(latest)].join("\n");
  }

  return ["# next-action", "", "No tasks or runs recorded.", "", "Suggested local next action: create a proposal or task draft."].join("\n");
}

export function nowReport(input: {
  runs: RunSummary[];
  tasks: TaskSpec[];
  actions: RemoteActionRecord[];
  proposals?: ProposalRecord[];
  drafts?: TaskDraftRecord[];
  ops?: OpsSnapshot;
  lifecycles?: RunLifecycleRecord[];
}): string {
  const latestByStatus = (status: RemoteActionRecord["status"]) =>
    input.actions.slice().reverse().find((action) => action.status === status);
  const running = latestByStatus("running");
  if (running) {
    return [
      "# now",
      "",
      "Worker is running.",
      `Action: ${code(running.id)}`,
      `Task: ${code(running.taskId)} - ${oneLine(running.taskTitle)}`,
      "",
      `Next: ${code("/action_current")}`,
    ].join("\n");
  }

  const approved = latestByStatus("approved");
  if (approved) {
    return [
      "# now",
      "",
      "Action is approved. Waiting for the runner.",
      `Action: ${code(approved.id)}`,
      `Task: ${code(approved.taskId)} - ${oneLine(approved.taskTitle)}`,
      "",
      `Next: ${code("/action_current")}`,
    ].join("\n");
  }

  const pendingAction = latestByStatus("pending");
  if (pendingAction) {
    return [
      "# now",
      "",
      "Action is ready for approval.",
      `Action: ${code(pendingAction.id)}`,
      `Task: ${code(pendingAction.taskId)} - ${oneLine(pendingAction.taskTitle)}`,
      "",
      `Next: ${code("/yes")}`,
    ].join("\n");
  }

  if (input.ops?.failures.length || input.ops?.warnings.length) {
    const issue = input.ops.failures[0] ?? input.ops.warnings[0] ?? "operation needs attention";
    return ["# now", "", "Operation needs attention.", oneLine(issue), "", `Next: ${code("/problems")}`].join("\n");
  }

  const pendingTask = input.tasks.find((task) => task.status === "pending");
  if (pendingTask) {
    return [
      "# now",
      "",
      "Pending task is ready to prepare.",
      `Task: ${code(pendingTask.id)} - ${oneLine(pendingTask.title)}`,
      "",
      `Next: ${code("/run_next")}`,
    ].join("\n");
  }

  const draft = input.drafts
    ?.slice()
    .reverse()
    .find((item) => item.status === "drafted");
  if (draft) {
    const missing = [
      draft.targetFiles.length === 0 ? "targetFiles" : "",
      draft.verifyCommands.length === 0 ? "verifyCommands" : "",
    ].filter(Boolean);
    const localNext =
      missing.length > 0
        ? `bun run samantha drafts:prepare ${draft.id} --project=<project-id>`
        : `bun run samantha drafts:approve ${draft.id}`;
    return [
      "# now",
      "",
      "Draft is waiting for local preparation.",
      `Draft: ${code(draft.id)}`,
      `Title: ${oneLine(draft.title)}`,
      missing.length ? `Missing: ${missing.join(", ")}` : "Ready for local approval.",
      "",
      `Next: ${code("/draft_next")}`,
      `Local next: ${code(localNext)}`,
    ].join("\n");
  }

  const proposal = input.proposals
    ?.slice()
    .reverse()
    .find((item) => item.status === "pending_review");
  if (proposal) {
    return [
      "# now",
      "",
      "Proposal is waiting for review.",
      `Proposal: ${code(proposal.id)}`,
      `Text: ${oneLine(proposal.text)}`,
      "",
      `Next: ${code("/proposal_next")}`,
    ].join("\n");
  }

  const latest = input.runs.at(-1);
  if (latest && !latest.pass) {
    return [
      "# now",
      "",
      "Latest run did not pass.",
      `Run: ${code(latest.runId)}`,
      latest.failureReason ? `Failure: ${oneLine(latest.failureReason)}` : "",
      "",
      `Next: ${code("/run_latest")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return ["# now", "", "No immediate remote action.", "", `Next: ${code("/check")}`].join("\n");
}

export function failuresReport(runs: RunSummary[], limit = 10): string {
  const failures = runs.filter((run) => !run.pass);
  const lines = recent(failures, limit).map(runLine);
  return [
    "# runs:failures",
    "",
    `Total non-passing runs: ${failures.length}`,
    "",
    "Recent:",
    ...(lines.length ? lines : ["No non-passing runs recorded."]),
  ].join("\n");
}

export function tasksListReport(tasks: TaskSpec[], limit = 20): string {
  const lines = recent(tasks, limit).map(taskLine);
  return ["# tasks:list", "", `Total tasks: ${tasks.length}`, "", ...(lines.length ? lines : ["No tasks recorded."])].join("\n");
}

export function taskShowReport(taskId: string, task: TaskSpec | undefined): string {
  if (!task) {
    return ["# tasks:show", "", `Task not found: ${code(taskId)}`].join("\n");
  }

  return [
    "# tasks:show",
    "",
    `Task: ${code(task.id)}`,
    `Title: ${oneLine(task.title)}`,
    `Status: ${code(task.status)}`,
    `Agent: ${code(task.targetAgent)}`,
    task.archivedAt ? `Archived: ${code(task.archivedAt)}` : "",
    task.archiveReason ? `Archive reason: ${oneLine(task.archiveReason)}` : "",
    `Target files: ${task.targetFiles.map(code).join(", ") || "none"}`,
    `Setup commands: ${(task.setupCommands ?? []).map(code).join(", ") || "none"}`,
    `Verify commands: ${task.verifyCommands.map(code).join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function proposalAddedReport(proposal: ProposalRecord): string {
  return [
    "# proposals:add",
    "",
    `Saved proposal: ${code(proposal.id)}`,
    `Status: ${code(proposal.status)}`,
    "",
    "Text:",
    oneLine(proposal.text),
    "",
    "No worker was dispatched. Review this proposal locally before creating a task.",
  ].join("\n");
}

export function proposalsListReport(proposals: ProposalRecord[], limit = 10): string {
  const lines = recent(proposals, limit).map(proposalLine);
  return [
    "# proposals:list",
    "",
    `Total proposals: ${proposals.length}`,
    "",
    ...(lines.length ? lines : ["No proposals recorded."]),
  ].join("\n");
}

export function proposalShowReport(proposalId: string, proposal: ProposalRecord | undefined): string {
  if (!proposal) {
    return ["# proposals:show", "", `Proposal not found: ${code(proposalId)}`].join("\n");
  }

  return [
    "# proposals:show",
    "",
    `Proposal: ${code(proposal.id)}`,
    `Status: ${code(proposal.status)}`,
    `Source: ${code(proposal.source)}`,
    proposal.senderId ? `Sender: ${code(proposal.senderId)}` : "",
    `Created: ${code(proposal.createdAt)}`,
    proposal.reviewedAt ? `Reviewed: ${code(proposal.reviewedAt)}` : "",
    proposal.reviewNote ? `Review note: ${oneLine(proposal.reviewNote)}` : "",
    "",
    "Text:",
    proposal.text.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

export function proposalReviewedReport(action: "accept" | "reject", proposal: ProposalRecord): string {
  return [
    `# proposals:${action}`,
    "",
    `Proposal: ${code(proposal.id)}`,
    `Status: ${code(proposal.status)}`,
    proposal.reviewedAt ? `Reviewed: ${code(proposal.reviewedAt)}` : "",
    proposal.reviewNote ? `Note: ${oneLine(proposal.reviewNote)}` : "",
    "",
    "No worker was dispatched. This only updates proposal review state.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function taskDraftAddedReport(draft: TaskDraftRecord): string {
  return [
    "# drafts:add",
    "",
    `Saved draft: ${code(draft.id)}`,
    `Source proposal: ${code(draft.sourceProposalId)}`,
    `Status: ${code(draft.status)}`,
    "",
    `Title: ${oneLine(draft.title)}`,
    "",
    "No worker was dispatched. Fill targetFiles and verifyCommands before promoting this draft to a task.",
  ].join("\n");
}

export function draftProposeAddedReport(input: { proposal: ProposalRecord; draft: TaskDraftRecord }): string {
  return [
    "# drafts:add-from-proposal-text",
    "",
    `Saved proposal: ${code(input.proposal.id)}`,
    `Proposal status: ${code(input.proposal.status)}`,
    `Saved draft: ${code(input.draft.id)}`,
    `Draft status: ${code(input.draft.status)}`,
    "",
    `Title: ${oneLine(input.draft.title)}`,
    "",
    "No worker was dispatched. This only creates an accepted proposal and a task draft.",
  ].join("\n");
}

export function taskDraftsListReport(drafts: TaskDraftRecord[], limit = 10): string {
  const lines = recent(drafts, limit).map(draftLine);
  return ["# drafts:list", "", `Total drafts: ${drafts.length}`, "", ...(lines.length ? lines : ["No task drafts recorded."])].join("\n");
}

export function taskDraftShowReport(draftId: string, draft: TaskDraftRecord | undefined): string {
  if (!draft) {
    return ["# drafts:show", "", `Draft not found: ${code(draftId)}`].join("\n");
  }

  return [
    "# drafts:show",
    "",
    `Draft: ${code(draft.id)}`,
    `Source proposal: ${code(draft.sourceProposalId)}`,
    `Status: ${code(draft.status)}`,
    `Created: ${code(draft.createdAt)}`,
    `Title: ${oneLine(draft.title)}`,
    `Agent: ${code(draft.targetAgent)}`,
    `Target files: ${draft.targetFiles.map(code).join(", ") || "none"}`,
    `Setup commands: ${(draft.setupCommands ?? []).map(code).join(", ") || "none"}`,
    `Verify commands: ${draft.verifyCommands.map(code).join(", ") || "none"}`,
    "",
    "Instructions:",
    draft.instructions.trim(),
  ].join("\n");
}

export function remoteActionPreparedReport(action: RemoteActionRecord): string {
  return [
    "# actions:prepare-dispatch",
    "",
    `Action: ${code(action.id)}`,
    `Status: ${code(action.status)}`,
    `Task: ${code(action.taskId)} - ${oneLine(action.taskTitle)}`,
    `Agent: ${code(action.targetAgent)}`,
    `Repo: ${code(action.repoRoot)}`,
    "",
    "Planned command:",
    code(remoteActionCommand(action)),
    "",
    "No worker was dispatched yet.",
    "",
    `Next: ${code("/yes")}`,
    `Explicit approval: ${code(`/approve_action ${action.id}`)}`,
  ].join("\n");
}

export function remoteActionsListReport(actions: RemoteActionRecord[], limit = 10): string {
  const lines = recent(actions, limit).map(remoteActionLine);
  return ["# actions:list", "", `Total actions: ${actions.length}`, "", ...(lines.length ? lines : ["No actions recorded."])].join("\n");
}

export function remoteActionShowReport(actionId: string, action: RemoteActionRecord | undefined): string {
  if (!action) {
    return ["# actions:show", "", `Action not found: ${code(actionId)}`].join("\n");
  }

  return [
    "# actions:show",
    "",
    `Action: ${code(action.id)}`,
    `Kind: ${code(action.kind)}`,
    `Status: ${code(action.status)}`,
    `Task: ${code(action.taskId)} - ${oneLine(action.taskTitle)}`,
    `Agent: ${code(action.targetAgent)}`,
    `Repo: ${code(action.repoRoot)}`,
    `Created: ${code(action.createdAt)}`,
    action.approvedAt ? `Approved: ${code(action.approvedAt)}` : "",
    action.startedAt ? `Started: ${code(action.startedAt)}` : "",
    action.completedAt ? `Completed: ${code(action.completedAt)}` : "",
    "",
    "Command:",
    code(remoteActionCommand(action)),
    action.result?.runId ? `Run: ${code(action.result.runId)}` : "",
    action.result?.outcome ? `Outcome: ${code(action.result.outcome)}` : "",
    action.result?.failure ? `Failure: ${oneLine(action.result.failure)}` : "",
    action.status === "pending" ? `Next: ${code("/yes")}` : "",
    action.status === "approved" || action.status === "running" ? `Next: ${code(`/action ${action.id}`)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function remoteActionApprovedReport(action: RemoteActionRecord): string {
  const result = action.result;
  return [
    "# actions:approve",
    "",
    `Action: ${code(action.id)}`,
    `Status: ${code(action.status)}`,
    `Task: ${code(action.taskId)}`,
    result?.runId ? `Run: ${code(result.runId)}` : "",
    result?.outcome ? `Outcome: ${code(result.outcome)}` : "",
    result?.pass !== undefined ? `Pass: ${result.pass ? "yes" : "no"}` : "",
    result?.runLogPath ? `Run log: ${code(result.runLogPath)}` : "",
    result?.liveLogPath ? `Live log: ${code(result.liveLogPath)}` : "",
    result?.tmuxSession ? `Tmux: ${code(result.tmuxSession)}` : "",
    result?.failure ? `Failure: ${oneLine(result.failure)}` : "",
    action.status === "approved" ? "Runner: waiting for `actions:watch` or `actions:run-pending`." : "",
    action.status === "approved" || action.status === "running" ? `Next: ${code(`/action ${action.id}`)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function statusReport(input: {
  runs: RunSummary[];
  heartbeat?: DaemonHeartbeat;
  pendingInboxCount: number;
  ops?: OpsSnapshot;
  proposals?: ProposalRecord[];
  drafts?: TaskDraftRecord[];
  actions?: RemoteActionRecord[];
  lifecycles?: RunLifecycleRecord[];
}): string {
  const latest = input.runs.at(-1);
  const latestLifecycle = latest ? input.lifecycles?.find((record) => record.runId === latest.runId) : undefined;
  const failureCount = input.runs.filter((run) => !run.pass).length;
  const proposalCounts = input.proposals
    ? {
        pending: input.proposals.filter((proposal) => proposal.status === "pending_review").length,
        accepted: input.proposals.filter((proposal) => proposal.status === "accepted").length,
        rejected: input.proposals.filter((proposal) => proposal.status === "rejected").length,
      }
    : undefined;
  const draftCounts = input.drafts
    ? {
        drafted: input.drafts.filter((draft) => draft.status === "drafted").length,
        approved: input.drafts.filter((draft) => draft.status === "approved").length,
        discarded: input.drafts.filter((draft) => draft.status === "discarded").length,
      }
    : undefined;
  const actionCounts = input.actions
    ? {
        pending: input.actions.filter((action) => action.status === "pending").length,
        approved: input.actions.filter((action) => action.status === "approved").length,
        running: input.actions.filter((action) => action.status === "running").length,
        failed: input.actions.filter((action) => action.status === "failed").length,
      }
    : undefined;
  const heartbeat = input.heartbeat
    ? `${input.heartbeat.status} pid=${input.heartbeat.pid} updated=${input.heartbeat.updatedAt} processed=${input.heartbeat.processedTotal}`
    : "missing";

  return [
    "# status",
    "",
    `Operation: ${input.ops ? (input.ops.ok ? "ok" : "needs attention") : "unknown"}`,
    input.ops ? `Doctor: failures=${input.ops.failures.length} warnings=${input.ops.warnings.length}` : "",
    "",
    "Daemon:",
    `- heartbeat: ${code(heartbeat)}`,
    "",
    "Queues:",
    `- pending inbox: ${input.pendingInboxCount}`,
    input.ops ? `- remote outbox: ${input.ops.queues.remoteOutboxCount}` : "",
    input.ops ? `- unsent remote outbox: ${input.ops.queues.unsentRemoteOutboxCount}` : "",
    "",
    "Remote:",
    input.ops?.queues.latestRemoteCommand
      ? `- latest command: type=${code(input.ops.queues.latestRemoteCommand.type ?? "unknown")} id=${code(input.ops.queues.latestRemoteCommand.id ?? input.ops.queues.latestRemoteCommand.file)} received=${code(input.ops.queues.latestRemoteCommand.receivedAt ?? "unknown")}`
      : "- latest command: none",
    input.ops?.queues.latestRemoteOutbox
      ? `- latest report: ${code(input.ops.queues.latestRemoteOutbox.file)} updated=${code(input.ops.queues.latestRemoteOutbox.updatedAt)}`
      : "- latest report: none",
    "",
    "Telegram:",
    input.ops
      ? input.ops.telegram.offset?.nextOffset !== undefined
        ? `- next offset: ${input.ops.telegram.offset.nextOffset}`
        : "- next offset: missing"
      : "",
    input.ops
      ? input.ops.telegram.replyState
        ? `- replies: sent=${input.ops.telegram.replyState.sentFiles.length} failures=${input.ops.telegram.replyState.failures?.length ?? 0} updated=${code(input.ops.telegram.replyState.updatedAt)}`
        : "- replies: missing"
      : "",
    input.ops ? `- latest reply failure: ${oneLine(latestReplyFailure(input.ops))}` : "",
    "",
    "Attention:",
    input.ops?.failures.length ? `- first failure: ${oneLine(input.ops.failures[0] ?? "")}` : "- failures: none",
    input.ops?.warnings.length ? `- first warning: ${oneLine(input.ops.warnings[0] ?? "")}` : "- warnings: none",
    "",
    "Proposals:",
    proposalCounts
      ? `- pending_review: ${proposalCounts.pending} accepted: ${proposalCounts.accepted} rejected: ${proposalCounts.rejected}`
      : "- unknown",
    "",
    "Drafts:",
    draftCounts ? `- drafted: ${draftCounts.drafted} approved: ${draftCounts.approved} discarded: ${draftCounts.discarded}` : "- unknown",
    "",
    "Actions:",
    actionCounts
      ? `- pending: ${actionCounts.pending} approved: ${actionCounts.approved} running: ${actionCounts.running} failed: ${actionCounts.failed}`
      : "- unknown",
    "",
    "Runs:",
    `- total: ${input.runs.length}`,
    `- non-passing: ${failureCount}`,
    latest ? `- latest: ${oneLine(runLine(latest).slice(2))}` : "- latest: none",
    latest ? `- lifecycle: ${lifecycleText(latestLifecycle)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function healthReport(health: DaemonHealthResult): string {
  const lines = [
    "# health:check",
    "",
    `OK: ${health.ok ? "yes" : "no"}`,
    health.ageMs !== undefined ? `Heartbeat age: ${health.ageMs}ms` : "",
    health.heartbeat
      ? `Heartbeat: ${code(`${health.heartbeat.status} pid=${health.heartbeat.pid} updated=${health.heartbeat.updatedAt}`)}`
      : "Heartbeat: missing",
    health.lock ? `Lock: ${code(`pid=${health.lock.pid} started=${health.lock.startedAt}`)}` : "Lock: missing",
    "",
    "Violations:",
    ...(health.violations.length ? health.violations.map((violation) => `- ${oneLine(violation)}`) : ["- none"]),
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export function doctorReport(snapshot: OpsSnapshot): string {
  const systemdLines = snapshot.systemd.files.map(
    (file) => `- ${file.file}: ${file.installed ? "installed" : "missing"}`,
  );
  return [
    "# ops:doctor",
    "",
    `Overall: ${snapshot.ok ? "ok" : "needs attention"}`,
    `Checked at: ${code(snapshot.checkedAt)}`,
    "",
    "Environment:",
    `- .env file: ${snapshot.env.envFileExists ? "present" : "missing"} (${code(snapshot.env.envFilePath)})`,
    `- TELEGRAM_BOT_TOKEN: ${snapshot.env.hasBotToken ? "present" : "missing"}`,
    `- poll chat id: ${snapshot.env.hasPollChatId ? "present" : "missing"}`,
    `- reply chat id: ${snapshot.env.hasReplyChatId ? "present" : "missing"}`,
    "",
    "Daemon:",
    `- health: ${snapshot.health.ok ? "ok" : "failed"}`,
    snapshot.health.ageMs !== undefined ? `- heartbeat age: ${snapshot.health.ageMs}ms` : "- heartbeat age: unknown",
    snapshot.health.heartbeat
      ? `- heartbeat: ${code(`${snapshot.health.heartbeat.status} pid=${snapshot.health.heartbeat.pid} updated=${snapshot.health.heartbeat.updatedAt}`)}`
      : "- heartbeat: missing",
    "",
    "Queues:",
    `- pending inbox: ${snapshot.queues.pendingInboxCount}`,
    `- outbox reports: ${snapshot.queues.outboxCount}`,
    `- remote outbox reports: ${snapshot.queues.remoteOutboxCount}`,
    `- unsent remote outbox reports: ${snapshot.queues.unsentRemoteOutboxCount}`,
    snapshot.queues.latestRemoteCommand
      ? `- latest remote command: type=${code(snapshot.queues.latestRemoteCommand.type ?? "unknown")} id=${code(snapshot.queues.latestRemoteCommand.id ?? snapshot.queues.latestRemoteCommand.file)} received=${code(snapshot.queues.latestRemoteCommand.receivedAt ?? "unknown")}`
      : "- latest remote command: none",
    snapshot.queues.latestRemoteOutbox
      ? `- latest remote report: ${code(snapshot.queues.latestRemoteOutbox.file)} updated=${code(snapshot.queues.latestRemoteOutbox.updatedAt)}`
      : "- latest remote report: none",
    "",
    "Telegram state:",
    snapshot.telegram.offset?.nextOffset !== undefined
      ? `- next offset: ${snapshot.telegram.offset.nextOffset}`
      : "- next offset: missing",
    snapshot.telegram.replyState
      ? `- replies: sent=${snapshot.telegram.replyState.sentFiles.length} failures=${snapshot.telegram.replyState.failures?.length ?? 0} updated=${code(snapshot.telegram.replyState.updatedAt)}`
      : "- replies: missing",
    `- latest reply failure: ${oneLine(latestReplyFailure(snapshot))}`,
    "",
    "systemd templates:",
    ...systemdLines,
    "",
    "Failures:",
    ...(snapshot.failures.length ? snapshot.failures.map((failure) => `- ${oneLine(failure)}`) : ["- none"]),
    "",
    "Warnings:",
    ...(snapshot.warnings.length ? snapshot.warnings.map((warning) => `- ${oneLine(warning)}`) : ["- none"]),
  ].join("\n");
}
