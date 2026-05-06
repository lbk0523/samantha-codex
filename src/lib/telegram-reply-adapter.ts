import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface TelegramReplyState {
  schemaVersion: 1;
  sentFiles: string[];
  failures?: TelegramReplyFailure[];
  updatedAt: string;
}

export interface TelegramReplySent {
  file: string;
  path: string;
  messages: number;
}

export interface TelegramReplyFailure {
  file: string;
  attempts: number;
  lastError: string;
  nextMessageIndex?: number;
  updatedAt: string;
}

export interface TelegramReplyFailed {
  file: string;
  path: string;
  error: string;
  attempts: number;
  nextMessageIndex: number;
}

export interface TelegramReplySkipped {
  file: string;
  reason: string;
}

export interface TelegramReplyResult {
  ok: boolean;
  initialized: boolean;
  sent: TelegramReplySent[];
  failed: TelegramReplyFailed[];
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

async function writeReplyState(path: string, sentFiles: Set<string>, failures = new Map<string, TelegramReplyFailure>()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const state: TelegramReplyState = {
    schemaVersion: 1,
    sentFiles: [...sentFiles].sort(),
    failures: [...failures.values()].sort((a, b) => a.file.localeCompare(b.file)),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function splitText(input: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = input;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
    const splitAt = Math.max(...candidates) > limit * 0.5 ? Math.max(...candidates) : limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function matchFirst(pattern: RegExp, value: string): string | undefined {
  return pattern.exec(value)?.[1]?.trim();
}

export function copyableIdsFromReport(report: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    ids.push(value);
  };

  for (const rawLine of report.split(/\r?\n/)) {
    const line = rawLine.trim();
    push(matchFirst(/^(?:Saved proposal|저장된 제안):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Saved draft|저장된 드래프트):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Approved draft|승인된 드래프트):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Created task|생성된 task):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Action|액션):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Proposal|제안):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Draft|드래프트):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Source proposal|원본 제안):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Run|런):\s+`([^`]+)`$/, line));
    push(matchFirst(/^(?:Task|태스크):\s+`([^`]+)`(?:\s+-.*)?$/, line));
    push(matchFirst(/^- `([^`]+)`\s+status=`[^`]+`\s+(?:agent|created|source)=/, line));
    push(matchFirst(/^- `([^`]+)`\s+outcome=`[^`]+`/, line));
    push(matchFirst(/^- latest:\s+`([^`]+)`\s+outcome=`[^`]+`/, line));
  }

  return ids;
}

export function telegramReplyMessages(file: string, report: string, limit = 3900): string[] {
  const body = report.trim() || "(empty report)";
  const header = `Samantha outbox: ${file}`;
  const single = [header, "", body].join("\n");
  const idMessages = copyableIdsFromReport(body);
  if (single.length <= limit) return [single, ...idMessages];

  const partHeader = `Samantha outbox: ${file} (part 999/999)\n\n`;
  const bodyLimit = Math.max(1, limit - partHeader.length);
  const chunks = splitText(body, bodyLimit);
  return [
    ...chunks.map((chunk, index) => [`Samantha outbox: ${file} (part ${index + 1}/${chunks.length})`, "", chunk].join("\n")),
    ...idMessages,
  ];
}

export function telegramReplyText(file: string, report: string, limit = 3900): string {
  return telegramReplyMessages(file, report, limit)[0] ?? "";
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
  const failures = new Map((state?.failures ?? []).map((failure) => [failure.file, failure]));
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
      failed: [],
      skipped: files.map((file) => ({ file, reason: "marked existing on first run" })),
    };
  }

  if (input.markExisting) {
    for (const file of files) sentFiles.add(file);
    for (const file of files) failures.delete(file);
    await writeReplyState(input.statePath, sentFiles, failures);
    return {
      ok: true,
      initialized: false,
      sent: [],
      failed: [],
      skipped: files.map((file) => ({ file, reason: "marked existing" })),
    };
  }

  const sent: TelegramReplySent[] = [];
  const failed: TelegramReplyFailed[] = [];
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

    const messages = telegramReplyMessages(basename(file), await readFile(path, "utf8"));
    const previous = failures.get(file);
    const startIndex = Math.min(previous?.nextMessageIndex ?? 0, messages.length);
    let nextMessageIndex = startIndex;
    try {
      for (let index = startIndex; index < messages.length; index += 1) {
        await sendTelegramMessage({
          token: input.token,
          chatId: input.chatId,
          text: messages[index],
          clientTimeoutMs,
          fetchImpl,
        });
        nextMessageIndex = index + 1;
      }
      sentFiles.add(file);
      failures.delete(file);
      await writeReplyState(input.statePath, sentFiles, failures);
      sent.push({ file, path, messages: messages.length });
    } catch (err) {
      const failure: TelegramReplyFailure = {
        file,
        attempts: (previous?.attempts ?? 0) + 1,
        lastError: errorMessage(err),
        nextMessageIndex,
        updatedAt: new Date().toISOString(),
      };
      failures.set(file, failure);
      await writeReplyState(input.statePath, sentFiles, failures);
      failed.push({ file, path, error: failure.lastError, attempts: failure.attempts, nextMessageIndex });
    }
  }

  return {
    ok: true,
    initialized: false,
    sent,
    failed,
    skipped,
  };
}
