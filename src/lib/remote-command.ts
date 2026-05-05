import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InboxCommand } from "./inbox";
import { buildProposalId } from "./proposal-store";
import { sanitizeTaskId } from "./worktree";

export interface RemoteCommandInput {
  senderId: string;
  text: string;
  receivedAt?: string;
  remoteId?: string | number;
}

export function commandFromRemoteInput(input: RemoteCommandInput, allowedSenderId?: string): InboxCommand {
  if (allowedSenderId && input.senderId !== allowedSenderId) {
    throw new Error("remote sender is not allowed");
  }

  const text = input.text.trim();
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const commandToken = sanitizeTaskId(input.remoteId === undefined ? receivedAt : `${receivedAt}-${input.remoteId}`);

  if (text === "/help" || text === "/start") {
    return { id: `remote-${commandToken}-help`, type: "remote:help", args: { source: "remote" } };
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
  if (text.startsWith("/draft-propose ")) {
    const proposalText = text.slice("/draft-propose ".length).trim();
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
  if (text === "/next-action") {
    return { id: `remote-${commandToken}-next-action`, type: "ops:next-action", args: { source: "remote" } };
  }
  if (text === "/dashboard") {
    return { id: `remote-${commandToken}-dashboard`, type: "dashboard:build", args: { source: "remote" } };
  }
  if (text === "/actions") {
    return { id: `remote-${commandToken}-actions`, type: "actions:list", args: { source: "remote" } };
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
  if (text.startsWith("/prepare-dispatch ")) {
    const taskId = text.slice("/prepare-dispatch ".length).trim();
    if (!taskId) throw new Error("missing task id");
    return {
      id: `remote-${commandToken}-prepare-dispatch`,
      type: "actions:prepare-dispatch",
      args: { taskId, source: "remote", receivedAt },
    };
  }
  if (text.startsWith("/approve-action ")) {
    const id = text.slice("/approve-action ".length).trim();
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
