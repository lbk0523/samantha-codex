import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InboxCommand } from "./inbox";
import { compactEntityId } from "./ids";
import { buildOrchestrationRequestId } from "./orchestrator-store";
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

function deprecatedReplacement(command: string): string | undefined {
  const replacements: Record<string, string> = {
    "/help_advanced": "/help",
    "/help advanced": "/help",
    "/next_action": "/now",
    "/next-action": "/now",
    "/status": "/check",
    "/doctor": "/problems",
    "/health": "/problems",
    "/dashboard": "/check",
    "/runs": "/now",
    "/run": "/now",
    "/run_latest": "/now",
    "/failures": "/problems",
    "/proposals": "/now",
    "/proposal": "/now",
    "/proposal_next": "/now",
    "/propose": "/work <요청>",
    "/accept": "/approve",
    "/reject": "/cancel",
    "/drafts": "/now",
    "/draft_next": "/now",
    "/draft": "/work <요청>",
    "/draft_propose": "/work <요청>",
    "/draft-propose": "/work <요청>",
    "/draft_prepare": "/plan",
    "/draft-prepare": "/plan",
    "/draft_approve": "/go",
    "/draft-approve": "/go",
    "/tasks": "/now",
    "/task": "/now",
    "/actions": "/now",
    "/action": "/now",
    "/action_current": "/now",
    "/run_next": "/go",
    "/run-next": "/go",
    "/yes": "/approve",
    "/prepare_dispatch": "/go",
    "/prepare-dispatch": "/go",
    "/approve_action": "/go",
    "/approve-action": "/go",
  };
  return replacements[command];
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
  if (text === "/approve") {
    return { id: `remote-${commandToken}-approve`, type: "decisions:approve-latest", args: { source: "remote", receivedAt } };
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

  const commandName = text === "/help advanced" ? "/help advanced" : text.split(/\s+/, 1)[0] ?? "";
  const replacement = deprecatedReplacement(commandName);
  if (replacement) {
    return {
      id: `remote-${commandToken}-deprecated`,
      type: "remote:deprecated",
      args: { command: commandName, replacement, source: "remote" },
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
