import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InboxCommand } from "./inbox";
import { compactEntityId } from "./ids";
import { buildOrchestrationRequestId } from "./orchestrator-store";
import { buildProposalId } from "./proposal-store";
import { sanitizeTaskId } from "./worktree";

export interface RemoteCommandInput {
  senderId: string;
  text: string;
  receivedAt?: string;
  remoteId?: string | number;
}

function isCommand(text: string, ...commands: string[]): boolean {
  return commands.includes(text);
}

function commandArgument(text: string, ...commands: string[]): string | undefined {
  for (const command of commands) {
    if (text.startsWith(`${command} `)) return text.slice(command.length + 1).trim();
  }
  return undefined;
}

function commandParts(value: string): string[] {
  return value.split(/[,\s]+/).filter(Boolean);
}

export function commandFromRemoteInput(input: RemoteCommandInput, allowedSenderId?: string): InboxCommand {
  if (allowedSenderId && input.senderId !== allowedSenderId) {
    throw new Error("remote sender is not allowed");
  }

  const text = input.text.trim();
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const commandToken = compactEntityId({
    prefix: "remote",
    createdAt: receivedAt,
    label: text.split(/\s+/, 1)[0]?.replace(/^\//, "") || "command",
    source: `${receivedAt}-${input.remoteId ?? text}`,
  }).replace(/^remote-/, "");

  if (isCommand(text, "/help", "/start")) {
    return { id: `remote-${commandToken}-help`, type: "remote:help", args: { source: "remote", mode: "basic" } };
  }
  if (isCommand(text, "/help_advanced", "/help advanced")) {
    return { id: `remote-${commandToken}-help-advanced`, type: "remote:help", args: { source: "remote", mode: "advanced" } };
  }
  if (text === "/now") {
    return { id: `remote-${commandToken}-now`, type: "ops:now", args: { source: "remote" } };
  }
  if (text === "/plan_current") {
    return { id: `remote-${commandToken}-plan-current`, type: "orchestrator:show-current-plan", args: { source: "remote" } };
  }
  const planArgs = commandArgument(text, "/plan");
  if (text === "/plan" || planArgs !== undefined) {
    const [projectId = "", scopeId = ""] = planArgs ? commandParts(planArgs) : [];
    return {
      id: `remote-${commandToken}-plan`,
      type: "orchestrator:plan-latest",
      args: {
        ...(projectId ? { projectId } : {}),
        ...(scopeId ? { scopeId } : {}),
        source: "remote",
        receivedAt,
      },
    };
  }
  if (text === "/go") {
    return { id: `remote-${commandToken}-go`, type: "actions:go", args: { source: "remote", receivedAt } };
  }
  if (text === "/recover") {
    return {
      id: `remote-${commandToken}-recover`,
      type: "orchestrator:recover-latest",
      args: { source: "remote", senderId: input.senderId, receivedAt },
    };
  }
  const cancelReason = commandArgument(text, "/cancel");
  if (text === "/cancel" || cancelReason !== undefined) {
    return {
      id: `remote-${commandToken}-cancel`,
      type: "orchestrator:cancel-current",
      args: {
        ...(cancelReason ? { reason: cancelReason } : {}),
        source: "remote",
        receivedAt,
      },
    };
  }
  if (text.startsWith("/revise ")) {
    const feedback = text.slice("/revise ".length).trim();
    if (!feedback) throw new Error("missing revision feedback");
    return {
      id: `remote-${commandToken}-revise`,
      type: "orchestrator:revise-latest",
      args: {
        requestId: buildOrchestrationRequestId(receivedAt, "revise"),
        feedback,
        senderId: input.senderId,
        source: "remote",
        receivedAt,
      },
    };
  }
  if (text === "/check") {
    return { id: `remote-${commandToken}-check`, type: "status:show", args: { source: "remote" } };
  }
  if (text === "/problems") {
    return { id: `remote-${commandToken}-problems`, type: "ops:doctor", args: { source: "remote" } };
  }
  if (text === "/status") {
    return { id: `remote-${commandToken}-status`, type: "status:show", args: { source: "remote" } };
  }
  if (text === "/doctor") {
    return { id: `remote-${commandToken}-doctor`, type: "ops:doctor", args: { source: "remote" } };
  }
  if (text === "/health") {
    return { id: `remote-${commandToken}-health`, type: "health:check", args: { source: "remote" } };
  }
  if (text === "/runs") {
    return { id: `remote-${commandToken}-runs`, type: "runs:list", args: { source: "remote" } };
  }
  if (text.startsWith("/run ")) {
    const id = text.slice("/run ".length).trim();
    if (!id) throw new Error("missing run id");
    return {
      id: `remote-${commandToken}-run`,
      type: "runs:show",
      args: { id, source: "remote" },
    };
  }
  if (text === "/run_latest") {
    return { id: `remote-${commandToken}-run-latest`, type: "runs:show-latest", args: { source: "remote" } };
  }
  if (text === "/failures") {
    return { id: `remote-${commandToken}-failures`, type: "runs:failures", args: { source: "remote" } };
  }
  if (text === "/proposals") {
    return { id: `remote-${commandToken}-proposals`, type: "proposals:list", args: { source: "remote" } };
  }
  if (text.startsWith("/proposal ")) {
    const id = text.slice("/proposal ".length).trim();
    if (!id) throw new Error("missing proposal id");
    return {
      id: `remote-${commandToken}-proposal`,
      type: "proposals:show",
      args: { id, source: "remote" },
    };
  }
  if (text === "/proposal_next") {
    return { id: `remote-${commandToken}-proposal-next`, type: "proposals:show-latest", args: { source: "remote" } };
  }
  if (text.startsWith("/accept ")) {
    const id = text.slice("/accept ".length).trim();
    if (!id) throw new Error("missing proposal id");
    return {
      id: `remote-${commandToken}-accept`,
      type: "proposals:accept",
      args: { id, source: "remote", receivedAt },
    };
  }
  if (text.startsWith("/reject ")) {
    const id = text.slice("/reject ".length).trim();
    if (!id) throw new Error("missing proposal id");
    return {
      id: `remote-${commandToken}-reject`,
      type: "proposals:reject",
      args: { id, source: "remote", receivedAt },
    };
  }
  if (text === "/drafts") {
    return { id: `remote-${commandToken}-drafts`, type: "drafts:list", args: { source: "remote" } };
  }
  if (text === "/draft_next") {
    return { id: `remote-${commandToken}-draft-next`, type: "drafts:show-latest", args: { source: "remote" } };
  }
  const draftPrepareArgs = commandArgument(text, "/draft_prepare", "/draft-prepare");
  if (draftPrepareArgs !== undefined) {
    const [projectId = "", ...targetFiles] = commandParts(draftPrepareArgs);
    if (!projectId) throw new Error("missing project id");
    return {
      id: `remote-${commandToken}-draft-prepare`,
      type: "drafts:prepare-latest",
      args: { projectId, targetFiles, source: "remote", receivedAt },
    };
  }
  if (isCommand(text, "/draft_approve", "/draft-approve")) {
    return { id: `remote-${commandToken}-draft-approve`, type: "drafts:approve-latest", args: { source: "remote", receivedAt } };
  }
  const draftProposeText = commandArgument(text, "/draft_propose", "/draft-propose");
  if (draftProposeText !== undefined) {
    const proposalText = draftProposeText;
    if (!proposalText) throw new Error("missing proposal text");
    return {
      id: `remote-${commandToken}-draft-propose`,
      type: "drafts:add-from-proposal-text",
      args: {
        proposalId: buildProposalId(receivedAt, input.remoteId),
        text: proposalText,
        senderId: input.senderId,
        source: "remote",
        receivedAt,
      },
    };
  }
  if (text.startsWith("/work ")) {
    const requestText = text.slice("/work ".length).trim();
    if (!requestText) throw new Error("missing work text");
    return {
      id: `remote-${commandToken}-work`,
      type: "orchestrator:add-request",
      args: {
        requestId: buildOrchestrationRequestId(receivedAt, "work"),
        text: requestText,
        senderId: input.senderId,
        source: "remote",
        receivedAt,
      },
    };
  }
  if (text.startsWith("/draft ")) {
    const id = text.slice("/draft ".length).trim();
    if (!id) throw new Error("missing draft or proposal id");
    if (id.startsWith("proposal-")) {
      return {
        id: `remote-${commandToken}-draft`,
        type: "drafts:add",
        args: { proposalId: id, source: "remote", receivedAt },
      };
    }
    if (id.startsWith("draft-")) {
      return {
        id: `remote-${commandToken}-draft`,
        type: "drafts:show",
        args: { id, source: "remote" },
      };
    }
    throw new Error("draft command id must start with proposal- or draft-");
  }
  if (text.startsWith("/propose ")) {
    const proposalText = text.slice("/propose ".length).trim();
    if (!proposalText) throw new Error("missing proposal text");
    return {
      id: `remote-${commandToken}-propose`,
      type: "proposals:add",
      args: {
        id: buildProposalId(receivedAt, input.remoteId),
        text: proposalText,
        senderId: input.senderId,
        source: "remote",
        receivedAt,
      },
    };
  }
  if (text === "/tasks") {
    return { id: `remote-${commandToken}-tasks`, type: "tasks:list", args: { source: "remote" } };
  }
  if (isCommand(text, "/next_action", "/next-action")) {
    return { id: `remote-${commandToken}-next-action`, type: "ops:next-action", args: { source: "remote" } };
  }
  if (text === "/dashboard") {
    return { id: `remote-${commandToken}-dashboard`, type: "dashboard:build", args: { source: "remote" } };
  }
  if (text === "/actions") {
    return { id: `remote-${commandToken}-actions`, type: "actions:list", args: { source: "remote" } };
  }
  if (isCommand(text, "/run_next", "/run-next")) {
    return { id: `remote-${commandToken}-run-next`, type: "actions:run-next", args: { source: "remote", receivedAt } };
  }
  if (text === "/yes") {
    return { id: `remote-${commandToken}-yes`, type: "actions:approve-latest", args: { source: "remote", receivedAt } };
  }
  if (text.startsWith("/action ")) {
    const id = text.slice("/action ".length).trim();
    if (!id) throw new Error("missing action id");
    return {
      id: `remote-${commandToken}-action`,
      type: "actions:show",
      args: { id, source: "remote" },
    };
  }
  if (text === "/action_current") {
    return { id: `remote-${commandToken}-action-current`, type: "actions:show-current", args: { source: "remote" } };
  }
  const prepareDispatchTaskId = commandArgument(text, "/prepare_dispatch", "/prepare-dispatch");
  if (prepareDispatchTaskId !== undefined) {
    const taskId = prepareDispatchTaskId;
    if (!taskId) throw new Error("missing task id");
    return {
      id: `remote-${commandToken}-prepare-dispatch`,
      type: "actions:prepare-dispatch",
      args: { taskId, source: "remote", receivedAt },
    };
  }
  const approveActionId = commandArgument(text, "/approve_action", "/approve-action");
  if (approveActionId !== undefined) {
    const id = approveActionId;
    if (!id) throw new Error("missing action id");
    return {
      id: `remote-${commandToken}-approve-action`,
      type: "actions:approve",
      args: { id, source: "remote", receivedAt },
    };
  }
  if (text.startsWith("/task ")) {
    return {
      id: `remote-${commandToken}-task`,
      type: "tasks:show",
      args: { id: text.slice("/task ".length).trim(), source: "remote" },
    };
  }

  throw new Error(`unsupported remote command: ${text}`);
}

export async function enqueueRemoteCommand(input: {
  inputPath: string;
  inboxDir: string;
  allowedSenderId?: string;
}): Promise<{ path: string; command: InboxCommand }> {
  const remote = JSON.parse(await readFile(input.inputPath, "utf8")) as RemoteCommandInput;
  return enqueueRemoteCommandFromInput({
    remote,
    inboxDir: input.inboxDir,
    allowedSenderId: input.allowedSenderId,
  });
}

export async function enqueueRemoteCommandFromInput(input: {
  remote: RemoteCommandInput;
  inboxDir: string;
  allowedSenderId?: string;
}): Promise<{ path: string; command: InboxCommand }> {
  const command = commandFromRemoteInput(input.remote, input.allowedSenderId);
  const file = `${sanitizeTaskId(command.id ?? `${Date.now()}`)}.json`;
  const path = join(input.inboxDir, file);

  await mkdir(input.inboxDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(command, null, 2)}\n`, "utf8");

  return { path, command };
}
