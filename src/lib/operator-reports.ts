import type { TaskSpec } from "./contracts";
import type { DaemonHealthResult, DaemonHeartbeat } from "./daemon";
import type { RunSummary } from "./ledger";
import type { OpsSnapshot } from "./ops-diagnostics";
import type { ProposalRecord } from "./proposal-store";
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

export function remoteHelpReport(): string {
  return [
    "# remote:help",
    "",
    "Supported Telegram commands:",
    "",
    "- `/help`: show this help",
    "- `/status`: show daemon and latest run summary",
    "- `/doctor`: show local operation diagnostics",
    "- `/health`: show daemon health check",
    "- `/runs`: show recent run summaries",
    "- `/run <run-id>`: show one run summary",
    "- `/failures`: show recent non-passing runs",
    "- `/propose <text>`: save a pending work proposal without executing it",
    "- `/proposals`: show recent proposals",
    "- `/proposal <proposal-id>`: show one proposal",
    "- `/accept <proposal-id>`: mark one proposal accepted without executing it",
    "- `/reject <proposal-id>`: mark one proposal rejected without executing it",
    "- `/draft-propose <text>`: save, accept, and draft a work proposal without executing it",
    "- `/draft <proposal-id>`: create a task draft from an accepted proposal",
    "- `/drafts`: show recent task drafts",
    "- `/draft <draft-id>`: show one task draft",
    "- `/tasks`: show known tasks",
    "- `/task <task-id>`: show one task",
    "- `/next-action`: show the safest local next action",
    "- `/dashboard`: rebuild the read-only dashboard",
    "",
    "Remote commands are safe-gated. They cannot dispatch workers, merge, push, clean worktrees, or run shell commands.",
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

export function nextActionReport(input: { runs: RunSummary[]; tasks: TaskSpec[] }): string {
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

export function statusReport(input: {
  runs: RunSummary[];
  heartbeat?: DaemonHeartbeat;
  pendingInboxCount: number;
  ops?: OpsSnapshot;
  proposals?: ProposalRecord[];
  drafts?: TaskDraftRecord[];
}): string {
  const latest = input.runs.at(-1);
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
    "",
    "Proposals:",
    proposalCounts
      ? `- pending_review: ${proposalCounts.pending} accepted: ${proposalCounts.accepted} rejected: ${proposalCounts.rejected}`
      : "- unknown",
    "",
    "Drafts:",
    draftCounts ? `- drafted: ${draftCounts.drafted} approved: ${draftCounts.approved} discarded: ${draftCounts.discarded}` : "- unknown",
    "",
    "Runs:",
    `- total: ${input.runs.length}`,
    `- non-passing: ${failureCount}`,
    latest ? `- latest: ${oneLine(runLine(latest).slice(2))}` : "- latest: none",
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
    "",
    "Telegram state:",
    snapshot.telegram.offset?.nextOffset !== undefined
      ? `- next offset: ${snapshot.telegram.offset.nextOffset}`
      : "- next offset: missing",
    snapshot.telegram.replyState
      ? `- replies: sent=${snapshot.telegram.replyState.sentFiles.length} failures=${snapshot.telegram.replyState.failures?.length ?? 0} updated=${code(snapshot.telegram.replyState.updatedAt)}`
      : "- replies: missing",
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
