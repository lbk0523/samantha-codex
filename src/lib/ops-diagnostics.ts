import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkDaemonHealth, type DaemonHealthResult } from "./daemon";
import type { TelegramReplyState } from "./telegram-reply-adapter";

export interface TelegramOffsetState {
  nextOffset?: number;
}

export interface EnvDiagnostics {
  envFilePath: string;
  envFileExists: boolean;
  hasBotToken: boolean;
  hasPollChatId: boolean;
  hasReplyChatId: boolean;
}

export interface QueueDiagnostics {
  pendingInboxCount: number;
  outboxCount: number;
  remoteOutboxCount: number;
  unsentRemoteOutboxCount: number;
}

export interface TelegramStateDiagnostics {
  offset?: TelegramOffsetState;
  replyState?: TelegramReplyState;
}

export interface SystemdTemplateDiagnostics {
  directory: string;
  files: Array<{
    file: string;
    installed: boolean;
  }>;
}

export interface OpsSnapshot {
  ok: boolean;
  checkedAt: string;
  env: EnvDiagnostics;
  health: DaemonHealthResult;
  queues: QueueDiagnostics;
  telegram: TelegramStateDiagnostics;
  systemd: SystemdTemplateDiagnostics;
  warnings: string[];
  failures: string[];
}

const systemdFiles = [
  "samantha-inbox-watch.service",
  "samantha-telegram-poll.service",
  "samantha-telegram-poll.timer",
  "samantha-telegram-reply.service",
  "samantha-telegram-reply.timer",
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function nonEmptyEnvNames(path: string): Promise<Set<string>> {
  try {
    const raw = await readFile(path, "utf8");
    const names = new Set<string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (name && value) names.add(name);
    }
    return names;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw err;
  }
}

function hasEnvValue(name: string, env: NodeJS.ProcessEnv, envFileNames: Set<string>): boolean {
  return Boolean(env[name]?.trim()) || envFileNames.has(name);
}

async function countFiles(path: string, predicate: (file: string) => boolean): Promise<number> {
  try {
    return (await readdir(path)).filter(predicate).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function remoteOutboxFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((file) => file.startsWith("remote-") && file.endsWith(".md")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function collectOpsSnapshot(input: {
  envFilePath: string;
  inboxDir: string;
  outboxDir: string;
  heartbeatPath: string;
  lockPath: string;
  telegramOffsetPath: string;
  telegramRepliesPath: string;
  systemdUserDir?: string;
  maxAgeMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  isAlive?: (pid: number) => boolean;
}): Promise<OpsSnapshot> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const envFileNames = await nonEmptyEnvNames(input.envFilePath);
  const hasBotToken = hasEnvValue("TELEGRAM_BOT_TOKEN", env, envFileNames);
  const hasPollChatId =
    hasEnvValue("TELEGRAM_ALLOWED_SENDER_ID", env, envFileNames) ||
    hasEnvValue("TELEGRAM_CHAT_ID", env, envFileNames);
  const hasReplyChatId =
    hasEnvValue("TELEGRAM_REPLY_CHAT_ID", env, envFileNames) ||
    hasEnvValue("TELEGRAM_CHAT_ID", env, envFileNames) ||
    hasEnvValue("TELEGRAM_ALLOWED_SENDER_ID", env, envFileNames);
  const remoteOutbox = await remoteOutboxFiles(input.outboxDir);
  const replyState = await readOptionalJson<TelegramReplyState>(input.telegramRepliesPath);
  const sentFiles = new Set(replyState?.sentFiles ?? []);
  const systemdUserDir = input.systemdUserDir ?? join(homedir(), ".config/systemd/user");
  const maxAgeMs = input.maxAgeMs ?? 15_000;
  const systemd = {
    directory: systemdUserDir,
    files: await Promise.all(
      systemdFiles.map(async (file) => ({
        file,
        installed: await exists(join(systemdUserDir, file)),
      })),
    ),
  };
  const health = await checkDaemonHealth({
    heartbeatPath: input.heartbeatPath,
    lockPath: input.lockPath,
    maxAgeMs,
    now,
    isAlive: input.isAlive,
  });
  const pidVisibilityViolations = health.violations.filter((violation) => violation.includes("pid is not running"));
  const hardHealthViolations = health.violations.filter((violation) => !violation.includes("pid is not running"));
  const heartbeatIsFresh = health.ageMs !== undefined && health.ageMs <= maxAgeMs;
  const effectiveHealth =
    health.heartbeat && health.lock && heartbeatIsFresh && hardHealthViolations.length === 0
      ? { ...health, ok: true, violations: [] }
      : health;
  const queues: QueueDiagnostics = {
    pendingInboxCount: await countFiles(input.inboxDir, (file) => file.endsWith(".json")),
    outboxCount: await countFiles(input.outboxDir, (file) => file.endsWith(".md")),
    remoteOutboxCount: remoteOutbox.length,
    unsentRemoteOutboxCount: remoteOutbox.filter((file) => !sentFiles.has(file)).length,
  };
  const telegram: TelegramStateDiagnostics = {
    offset: await readOptionalJson<TelegramOffsetState>(input.telegramOffsetPath),
    replyState,
  };
  const envDiagnostics: EnvDiagnostics = {
    envFilePath: input.envFilePath,
    envFileExists: await exists(input.envFilePath),
    hasBotToken,
    hasPollChatId,
    hasReplyChatId,
  };
  const failures = [
    ...(!hasBotToken ? ["TELEGRAM_BOT_TOKEN is missing"] : []),
    ...(!hasPollChatId ? ["Telegram poll chat id is missing"] : []),
    ...(!hasReplyChatId ? ["Telegram reply chat id is missing"] : []),
    ...(!effectiveHealth.ok ? effectiveHealth.violations : []),
  ];
  const warnings = [
    ...pidVisibilityViolations.map((violation) => `pid visibility check failed: ${violation}`),
    ...(!telegram.offset ? ["telegram offset state is missing"] : []),
    ...(!telegram.replyState ? ["telegram reply state is missing"] : []),
    ...systemd.files.filter((file) => !file.installed).map((file) => `systemd template not installed: ${file.file}`),
    ...(queues.unsentRemoteOutboxCount > 0 ? [`${queues.unsentRemoteOutboxCount} unsent remote outbox report(s)`] : []),
  ];

  return {
    ok: failures.length === 0,
    checkedAt: now.toISOString(),
    env: envDiagnostics,
    health: effectiveHealth,
    queues,
    telegram,
    systemd,
    warnings,
    failures,
  };
}
