import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
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
  codexCommand: string;
  hasCodexExecutable: boolean;
}

export interface QueueDiagnostics {
  pendingInboxCount: number;
  outboxCount: number;
  remoteOutboxCount: number;
  unsentRemoteOutboxCount: number;
  latestRemoteCommand?: RemoteCommandDiagnostics;
  latestRemoteOutbox?: FileDiagnostics;
}

export interface TelegramStateDiagnostics {
  offset?: TelegramOffsetState;
  replyState?: TelegramReplyState;
}

export interface FileDiagnostics {
  file: string;
  updatedAt: string;
}

export interface RemoteCommandDiagnostics extends FileDiagnostics {
  id?: string;
  type?: string;
  receivedAt?: string;
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
  "samantha-actions-watch.service",
  "samantha-telegram-poll.service",
  "samantha-telegram-poll.timer",
  "samantha-telegram-reply.service",
  "samantha-telegram-reply.timer",
  "samantha-ceo-notify.service",
  "samantha-ceo-notify.timer",
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

async function envFileValues(path: string): Promise<Map<string, string>> {
  try {
    const raw = await readFile(path, "utf8");
    const values = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (name && value) values.set(name, value.replace(/^['"]|['"]$/g, ""));
    }
    return values;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

function hasEnvValue(name: string, env: NodeJS.ProcessEnv, envFileNames: Set<string>): boolean {
  return Boolean(env[name]?.trim()) || envFileNames.has(name);
}

async function hasExecutable(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!command.trim()) return false;
  if (command.includes("/") || /^[A-Za-z]:[\\/]/.test(command)) {
    return exists(command);
  }
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (await exists(join(dir, command))) return true;
  }
  return false;
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

async function latestFile(path: string, predicate: (file: string) => boolean): Promise<FileDiagnostics | undefined> {
  try {
    const files = (await readdir(path)).filter(predicate).sort();
    const file = files.at(-1);
    if (!file) return undefined;
    const info = await stat(join(path, file));
    return { file, updatedAt: info.mtime.toISOString() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function latestRemoteCommand(path?: string): Promise<RemoteCommandDiagnostics | undefined> {
  if (!path) return undefined;
  const latest = await latestFile(path, (file) => file.startsWith("remote-") && file.endsWith(".json"));
  if (!latest) return undefined;
  try {
    const raw = JSON.parse(await readFile(join(path, latest.file), "utf8")) as {
      id?: string;
      type?: string;
      args?: { receivedAt?: string };
    };
    return {
      ...latest,
      id: raw.id,
      type: raw.type,
      receivedAt: raw.args?.receivedAt,
    };
  } catch {
    return latest;
  }
}

export async function collectOpsSnapshot(input: {
  envFilePath: string;
  inboxDir: string;
  outboxDir: string;
  archiveInboxDir?: string;
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
  const envValues = await envFileValues(input.envFilePath);
  const envFileNames = new Set(envValues.keys());
  const hasBotToken = hasEnvValue("TELEGRAM_BOT_TOKEN", env, envFileNames);
  const hasPollChatId =
    hasEnvValue("TELEGRAM_ALLOWED_SENDER_ID", env, envFileNames) ||
    hasEnvValue("TELEGRAM_CHAT_ID", env, envFileNames);
  const hasReplyChatId =
    hasEnvValue("TELEGRAM_REPLY_CHAT_ID", env, envFileNames) ||
    hasEnvValue("TELEGRAM_CHAT_ID", env, envFileNames) ||
    hasEnvValue("TELEGRAM_ALLOWED_SENDER_ID", env, envFileNames);
  const codexCommand = env.SAMANTHA_CODEX_BIN?.trim() || envValues.get("SAMANTHA_CODEX_BIN") || "codex";
  const hasCodexExecutable = await hasExecutable(codexCommand, env);
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
  const latestRemoteCommandSummary = await latestRemoteCommand(input.archiveInboxDir);
  const latestRemoteOutboxSummary = await latestFile(
    input.outboxDir,
    (file) => file.startsWith("remote-") && file.endsWith(".md"),
  );
  const queues: QueueDiagnostics = {
    pendingInboxCount: await countFiles(input.inboxDir, (file) => file.endsWith(".json")),
    outboxCount: await countFiles(input.outboxDir, (file) => file.endsWith(".md")),
    remoteOutboxCount: remoteOutbox.length,
    unsentRemoteOutboxCount: remoteOutbox.filter((file) => !sentFiles.has(file)).length,
    ...(latestRemoteCommandSummary ? { latestRemoteCommand: latestRemoteCommandSummary } : {}),
    ...(latestRemoteOutboxSummary ? { latestRemoteOutbox: latestRemoteOutboxSummary } : {}),
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
    codexCommand,
    hasCodexExecutable,
  };
  const failures = [
    ...(!hasBotToken ? ["TELEGRAM_BOT_TOKEN is missing"] : []),
    ...(!hasPollChatId ? ["Telegram poll chat id is missing"] : []),
    ...(!hasReplyChatId ? ["Telegram reply chat id is missing"] : []),
    ...(!hasCodexExecutable ? [`Codex executable is missing: ${codexCommand}`] : []),
    ...(!effectiveHealth.ok ? effectiveHealth.violations : []),
  ];
  const warnings = [
    ...pidVisibilityViolations.map((violation) => `pid visibility check failed: ${violation}`),
    ...(!telegram.offset ? ["telegram offset state is missing"] : []),
    ...(!telegram.replyState ? ["telegram reply state is missing"] : []),
    ...systemd.files.filter((file) => !file.installed).map((file) => `systemd template not installed: ${file.file}`),
    ...(queues.unsentRemoteOutboxCount > 0 ? [`${queues.unsentRemoteOutboxCount} unsent remote outbox report(s)`] : []),
    ...((replyState?.failures?.length ?? 0) > 0 ? [`${replyState?.failures?.length ?? 0} Telegram reply failure(s)`] : []),
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

export function withoutActiveInboxCommand(snapshot: OpsSnapshot): OpsSnapshot {
  return {
    ...snapshot,
    queues: {
      ...snapshot.queues,
      pendingInboxCount: Math.max(0, snapshot.queues.pendingInboxCount - 1),
    },
  };
}
