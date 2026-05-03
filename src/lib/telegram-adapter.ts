import { enqueueRemoteCommandFromInput } from "./remote-command";
import type { InboxCommand } from "./inbox";

export interface TelegramUser {
  id: number;
}

export interface TelegramMessage {
  date?: number;
  text?: string;
  from?: TelegramUser;
  chat?: {
    id: number;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
  description?: string;
}

export interface TelegramEnqueueResult {
  updateId: number;
  path: string;
  command: InboxCommand;
}

export interface TelegramIgnoredUpdate {
  updateId: number;
  reason: string;
}

export interface TelegramPollResult {
  ok: boolean;
  nextOffset?: number;
  enqueued: TelegramEnqueueResult[];
  ignored: TelegramIgnoredUpdate[];
}

export async function pollTelegramToInbox(input: {
  token: string;
  inboxDir: string;
  allowedSenderId: string;
  offset?: number;
  limit?: number;
  timeoutSeconds?: number;
  clientTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<TelegramPollResult> {
  if (!input.token) throw new Error("telegram bot token is required");
  if (!input.allowedSenderId) throw new Error("telegram allowed sender id is required");

  const fetchImpl = input.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  params.set("timeout", String(input.timeoutSeconds ?? 0));
  params.set("limit", String(input.limit ?? 10));
  if (input.offset !== undefined) params.set("offset", String(input.offset));

  const clientTimeoutMs = input.clientTimeoutMs ?? Math.max(((input.timeoutSeconds ?? 0) + 10) * 1000, 10_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clientTimeoutMs);
  let body: TelegramGetUpdatesResponse;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${input.token}/getUpdates?${params.toString()}`, {
      signal: controller.signal,
    });
    body = (await response.json()) as TelegramGetUpdatesResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`telegram getUpdates timed out after ${clientTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!body.ok) {
    throw new Error(`telegram getUpdates failed: ${body.description ?? response.statusText}`);
  }

  const enqueued: TelegramEnqueueResult[] = [];
  const ignored: TelegramIgnoredUpdate[] = [];
  let nextOffset = input.offset;

  for (const update of body.result) {
    nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
    const text = update.message?.text;
    const senderId = update.message?.chat?.id ?? update.message?.from?.id;
    if (!text || senderId === undefined) {
      ignored.push({ updateId: update.update_id, reason: "missing text or sender" });
      continue;
    }

    try {
      const result = await enqueueRemoteCommandFromInput({
        remote: {
          senderId: String(senderId),
          text,
          receivedAt: update.message?.date ? new Date(update.message.date * 1000).toISOString() : undefined,
        },
        inboxDir: input.inboxDir,
        allowedSenderId: input.allowedSenderId,
      });
      enqueued.push({ updateId: update.update_id, ...result });
    } catch (err) {
      ignored.push({
        updateId: update.update_id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    nextOffset,
    enqueued,
    ignored,
  };
}
