import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface TelegramReplyState {
  schemaVersion: 1;
  sentFiles: string[];
  updatedAt: string;
}

export interface TelegramReplySent {
  file: string;
  path: string;
}

export interface TelegramReplySkipped {
  file: string;
  reason: string;
}

export interface TelegramReplyResult {
  ok: boolean;
  initialized: boolean;
  sent: TelegramReplySent[];
  skipped: TelegramReplySkipped[];
}

export interface TelegramSendMessageResponse {
  ok: boolean;
  description?: string;
}

async function readReplyState(path: string): Promise<TelegramReplyState | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as TelegramReplyState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function writeReplyState(path: string, sentFiles: Set<string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const state: TelegramReplyState = {
    schemaVersion: 1,
    sentFiles: [...sentFiles].sort(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function truncateForTelegram(input: string, limit: number): string {
  if (input.length <= limit) return input;
  const suffix = "\n\n[truncated]";
  return `${input.slice(0, limit - suffix.length)}${suffix}`;
}

export function telegramReplyText(file: string, report: string, limit = 3900): string {
  return truncateForTelegram([`Samantha outbox: ${file}`, "", report.trim()].join("\n"), limit);
}

async function sendTelegramMessage(input: {
  token: string;
  chatId: string;
  text: string;
  clientTimeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.clientTimeoutMs);
  let body: TelegramSendMessageResponse;
  let response: Response;
  try {
    response = await input.fetchImpl(`https://api.telegram.org/bot${input.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    body = (await response.json()) as TelegramSendMessageResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`telegram sendMessage timed out after ${input.clientTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!body.ok) {
    throw new Error(`telegram sendMessage failed: ${body.description ?? response.statusText}`);
  }
}

export async function sendOutboxReplies(input: {
  token: string;
  chatId: string;
  outboxDir: string;
  statePath: string;
  limit?: number;
  minAgeMs?: number;
  markExisting?: boolean;
  sendExisting?: boolean;
  clientTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<TelegramReplyResult> {
  if (!input.token) throw new Error("telegram bot token is required");
  if (!input.chatId) throw new Error("telegram chat id is required");

  const fetchImpl = input.fetchImpl ?? fetch;
  const limit = input.limit ?? 10;
  const minAgeMs = input.minAgeMs ?? 1000;
  const clientTimeoutMs = input.clientTimeoutMs ?? 10_000;
  const now = input.now ?? new Date();
  const state = await readReplyState(input.statePath);
  const sentFiles = new Set(state?.sentFiles ?? []);
  const files = (await readdir(input.outboxDir).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }))
    .filter((file) => file.startsWith("remote-") && file.endsWith(".md"))
    .sort();

  if (!state && !input.sendExisting) {
    for (const file of files) sentFiles.add(file);
    await writeReplyState(input.statePath, sentFiles);
    return {
      ok: true,
      initialized: true,
      sent: [],
      skipped: files.map((file) => ({ file, reason: "marked existing on first run" })),
    };
  }

  if (input.markExisting) {
    for (const file of files) sentFiles.add(file);
    await writeReplyState(input.statePath, sentFiles);
    return {
      ok: true,
      initialized: false,
      sent: [],
      skipped: files.map((file) => ({ file, reason: "marked existing" })),
    };
  }

  const sent: TelegramReplySent[] = [];
  const skipped: TelegramReplySkipped[] = [];

  for (const file of files) {
    if (sent.length >= limit) break;
    if (sentFiles.has(file)) {
      skipped.push({ file, reason: "already sent" });
      continue;
    }

    const path = join(input.outboxDir, file);
    const info = await stat(path);
    const ageMs = now.getTime() - info.mtimeMs;
    if (ageMs < minAgeMs) {
      skipped.push({ file, reason: `too new: ${Math.max(0, Math.round(ageMs))}ms` });
      continue;
    }

    const text = telegramReplyText(basename(file), await readFile(path, "utf8"));
    await sendTelegramMessage({
      token: input.token,
      chatId: input.chatId,
      text,
      clientTimeoutMs,
      fetchImpl,
    });
    sentFiles.add(file);
    await writeReplyState(input.statePath, sentFiles);
    sent.push({ file, path });
  }

  return {
    ok: true,
    initialized: false,
    sent,
    skipped,
  };
}
