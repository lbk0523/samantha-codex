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

const telegramCommandReplacements: Array<[RegExp, string]> = [
  [/(^|[^\w/])\/help_advanced\b/g, "$1/help"],
  [/(^|[^\w/])\/help advanced\b/g, "$1/help"],
  [/(^|[^\w/])\/(?:next_action|next-action|runs|run_latest|run_next|run-next|tasks|task|actions|action_current|action|proposals|proposal_next|proposal|drafts|draft_next)\b/g, "$1/now"],
  [/(^|[^\w/])\/run\b/g, "$1/now"],
  [/(^|[^\w/])\/(?:status|dashboard)\b/g, "$1/check"],
  [/(^|[^\w/])\/(?:doctor|health|failures)\b/g, "$1/problems"],
  [/(^|[^\w/])\/(?:accept|draft_approve|draft-approve|yes|prepare_dispatch|prepare-dispatch|approve_action|approve-action)\b/g, "$1/go"],
  [/(^|[^\w/])\/reject\b/g, "$1/cancel"],
  [/(^|[^\w/])\/(?:draft_prepare|draft-prepare)\b/g, "$1/plan"],
  [/(^|[^\w/])\/(?:propose|draft_propose|draft-propose|draft)\b/g, "$1/work <요청>"],
];

function normalizeTelegramVisibleText(value: string): string {
  let safe = value;
  for (const [pattern, replacement] of telegramCommandReplacements) {
    safe = safe.replace(pattern, replacement);
  }
  return safe;
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

function headingTitle(line: string): string | undefined {
  const heading = line.match(/^#\s+(.+)$/)?.[1]?.trim();
  if (!heading) return undefined;
  const titles: Record<string, string> = {
    now: "현재 상태",
    plan: "계획",
    go: "실행 준비",
    "plan-result": "계획 결과",
    "execution-result": "실행 결과",
    recover: "복구 요청",
    approve: "승인",
    "ceo-notify": "CEO 알림",
    "decision-required": "결정 필요",
    revise: "계획 수정",
    cancel: "취소",
    "ops:doctor": "운영 점검",
    "ops:status": "운영 상태",
  };
  return titles[heading] ?? heading.replace(/[-_:]/g, " ");
}

function compactLine(rawLine: string): string | undefined {
  const line = rawLine.trimEnd();
  const trimmed = line.trim();
  if (!trimmed) return "";

  const heading = headingTitle(trimmed);
  if (heading) return heading;

  const taskWithTitle = trimmed.match(/^태스크:\s+`[^`]+`\s+-\s+(.+)$/);
  if (taskWithTitle) return `작업: ${taskWithTitle[1].trim()}`;

  const taskCandidate = trimmed.match(/^- `[^`]+`\s+(.+?)(?:\s+agent=`[^`]+`)?(?:\s+mode=`[^`]+`)?$/);
  if (taskCandidate && !taskCandidate[1].includes("status=`") && !taskCandidate[1].includes("outcome=`")) {
    return `- ${taskCandidate[1].trim()}`;
  }

  if (/^(?:요청|계획|액션|런|커밋|기록|Decision|Subject|Run log|Live log|Tmux|Source proposal|원본 제안):/.test(trimmed)) {
    return undefined;
  }
  if (/^(?:Saved proposal|저장된 제안|저장된 요청|Saved draft|저장된 드래프트|Approved draft|승인된 드래프트|Created task|생성된 task):/.test(trimmed)) {
    return undefined;
  }
  if (/^(?:Action|Run|Task|Proposal|Draft):\s+`/.test(trimmed)) return undefined;
  if (/^- `[^`]+`\s+(?:status|outcome)=/.test(trimmed)) return undefined;
  if (/^- latest:\s+`[^`]+`\s+outcome=/.test(trimmed)) return undefined;
  if (/^- 텔레그램: `\/action_current`$/.test(trimmed)) return "- 텔레그램: `/now`";
  if (trimmed.includes("`bun run ")) return undefined;

  return line;
}

export function compactTelegramReport(report: string): string {
  const skipSectionHeadings = new Set([
    "기록:",
    "증거:",
    "로컬 fallback:",
    "로컬 merge 후보:",
    "실행 예정 명령:",
    "변경 파일:",
    "생성된 task:",
    "생성된 action:",
    "안전장치:",
  ]);
  const resumeSectionHeadings = new Set([
    "다음 액션:",
    "검증:",
    "산출 보고:",
    "오케스트레이터 종합:",
    "Worker 결과:",
    "세부:",
  ]);
  const lines: string[] = [];
  let skippingSection = false;

  for (const rawLine of report.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (skipSectionHeadings.has(trimmed)) {
      skippingSection = true;
      continue;
    }
    if (skippingSection) {
      if (!trimmed) skippingSection = false;
      else if (resumeSectionHeadings.has(trimmed)) skippingSection = false;
      else continue;
    }

    const compacted = compactLine(rawLine);
    if (compacted === undefined) continue;
    lines.push(compacted);
  }

  return normalizeTelegramVisibleText(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim())
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function telegramReplyMessages(_file: string, report: string, limit = 3900): string[] {
  const body = compactTelegramReport(report) || "(empty report)";
  if (body.length <= limit) return [body];

  const partHeader = "Samantha (part 999/999)\n\n";
  const bodyLimit = Math.max(1, limit - partHeader.length);
  const chunks = splitText(body, bodyLimit);
  return chunks.map((chunk, index) => [`Samantha (part ${index + 1}/${chunks.length})`, "", chunk].join("\n"));
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
