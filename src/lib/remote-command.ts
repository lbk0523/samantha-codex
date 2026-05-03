import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InboxCommand } from "./inbox";
import { sanitizeTaskId } from "./worktree";

export interface RemoteCommandInput {
  senderId: string;
  text: string;
  receivedAt?: string;
}

export function commandFromRemoteInput(input: RemoteCommandInput, allowedSenderId?: string): InboxCommand {
  if (allowedSenderId && input.senderId !== allowedSenderId) {
    throw new Error("remote sender is not allowed");
  }

  const text = input.text.trim();
  const receivedAt = input.receivedAt ?? new Date().toISOString();

  if (text === "/runs") {
    return { id: `remote-${sanitizeTaskId(receivedAt)}-runs`, type: "runs:list", args: { source: "remote" } };
  }
  if (text === "/tasks") {
    return { id: `remote-${sanitizeTaskId(receivedAt)}-tasks`, type: "tasks:list", args: { source: "remote" } };
  }
  if (text === "/dashboard") {
    return { id: `remote-${sanitizeTaskId(receivedAt)}-dashboard`, type: "dashboard:build", args: { source: "remote" } };
  }
  if (text.startsWith("/task ")) {
    return {
      id: `remote-${sanitizeTaskId(receivedAt)}-task`,
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
