import { homedir, hostname, platform } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
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
  oldestPendingInbox?: FileDiagnostics;
  oldestPendingInboxAgeMs?: number;
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
  checked: boolean;
  platform: NodeJS.Platform;
  files: Array<{
    file: string;
    installed: boolean;
  }>;
}

export type ServiceTemplateProvider = "systemd" | "launchd";

export interface ServiceTemplateDiagnostics {
  provider: ServiceTemplateProvider;
  directory: string;
  files: Array<{
    file: string;
    installed: boolean;
  }>;
}

export type HostOwnershipRole = "active_automation_host" | "client_machine";
export type HostOwnershipState = "active" | "client" | "stale" | "unknown";

export interface HostOwnershipRecord {
  schemaVersion: 1;
  role: HostOwnershipRole;
  hostId: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface HostOwnershipDiagnostics {
  path: string;
  currentHostId: string;
  state: HostOwnershipState;
  automationAllowed: boolean;
  reason: string;
  record?: HostOwnershipRecord;
}

export type OpsDiagnosticSeverity = "stale" | "blocked" | "degraded" | "needs_bk" | "unsafe_to_continue";

export interface OpsDiagnosticIssue {
  severity: OpsDiagnosticSeverity;
  area: "host" | "daemon" | "service" | "inbox" | "telegram" | "environment";
  message: string;
  action: string;
}

export interface OpsSnapshot {
  ok: boolean;
  checkedAt: string;
  hostOwnership: HostOwnershipDiagnostics;
  env: EnvDiagnostics;
  health: DaemonHealthResult;
  queues: QueueDiagnostics;
  telegram: TelegramStateDiagnostics;
  serviceTemplates?: ServiceTemplateDiagnostics;
  systemd: SystemdTemplateDiagnostics;
  issues: OpsDiagnosticIssue[];
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

const launchdFiles = [
  "com.bk.samantha.inbox-watch.plist",
  "com.bk.samantha.actions-watch.plist",
  "com.bk.samantha.telegram-poll.plist",
  "com.bk.samantha.telegram-reply.plist",
  "com.bk.samantha.ceo-notify.plist",
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

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function redactDiagnosticValue(value: string): string {
  return value
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(Bearer|token|secret|password|api[_-]?key)=\S+/gi, "$1=[redacted]")
    .replace(/\b(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|TELEGRAM_REPLY_CHAT_ID)=\S+/g, "$1=[redacted]");
}

function sanitizeReplyState(state: TelegramReplyState | undefined): TelegramReplyState | undefined {
  if (!state) return undefined;
  return {
    ...state,
    failures: state.failures?.map((failure) => ({
      ...failure,
      lastError: redactDiagnosticValue(failure.lastError),
    })),
  };
}

function parseHostOwnershipRecord(value: unknown): HostOwnershipRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const role = record.role;
  if (record.schemaVersion !== 1) return undefined;
  if (role !== "active_automation_host" && role !== "client_machine") return undefined;
  if (typeof record.hostId !== "string" || !record.hostId.trim()) return undefined;
  if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) return undefined;
  if (record.expiresAt !== undefined) {
    if (typeof record.expiresAt !== "string" || Number.isNaN(Date.parse(record.expiresAt))) return undefined;
  }
  return {
    schemaVersion: 1,
    role,
    hostId: oneLine(record.hostId),
    updatedAt: record.updatedAt,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  };
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

async function oldestFile(path: string, predicate: (file: string) => boolean): Promise<FileDiagnostics | undefined> {
  try {
    const files = (await readdir(path)).filter(predicate).sort();
    const entries = await Promise.all(
      files.map(async (file) => ({
        file,
        info: await stat(join(path, file)),
      })),
    );
    const oldest = entries.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs || a.file.localeCompare(b.file)).at(0);
    if (!oldest) return undefined;
    return { file: oldest.file, updatedAt: oldest.info.mtime.toISOString() };
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

async function hostOwnershipDiagnostics(input: {
  path: string;
  currentHostId: string;
  now: Date;
}): Promise<HostOwnershipDiagnostics> {
  let rawRecord: unknown;
  try {
    rawRecord = await readOptionalJson<unknown>(input.path);
  } catch {
    return {
      path: input.path,
      currentHostId: input.currentHostId,
      state: "unknown",
      automationAllowed: false,
      reason: "host ownership record is malformed",
    };
  }
  if (!rawRecord) {
    return {
      path: input.path,
      currentHostId: input.currentHostId,
      state: "unknown",
      automationAllowed: false,
      reason: "host ownership record is missing",
    };
  }

  const record = parseHostOwnershipRecord(rawRecord);
  if (!record) {
    return {
      path: input.path,
      currentHostId: input.currentHostId,
      state: "unknown",
      automationAllowed: false,
      reason: "host ownership record is malformed",
    };
  }

  if (record.expiresAt && Date.parse(record.expiresAt) <= input.now.getTime()) {
    return {
      path: input.path,
      currentHostId: input.currentHostId,
      state: "stale",
      automationAllowed: false,
      reason: `host ownership expired at ${record.expiresAt}`,
      record,
    };
  }

  if (record.role === "active_automation_host" && record.hostId === input.currentHostId) {
    return {
      path: input.path,
      currentHostId: input.currentHostId,
      state: "active",
      automationAllowed: true,
      reason: "current machine is the active automation host",
      record,
    };
  }

  return {
    path: input.path,
    currentHostId: input.currentHostId,
    state: "client",
    automationAllowed: false,
    reason:
      record.role === "active_automation_host"
        ? `active automation host is ${record.hostId}`
        : "current machine is recorded as a client machine",
    record,
  };
}

function healthIssue(violation: string): OpsDiagnosticIssue {
  if (violation.startsWith("heartbeat is stale")) {
    return {
      severity: "stale",
      area: "daemon",
      message: violation,
      action: "Run `bun run samantha health:check`, then inspect the active host service manager status.",
    };
  }
  if (violation.includes("pid is not running")) {
    return {
      severity: "unsafe_to_continue",
      area: "daemon",
      message: violation,
      action: "Do not start a second watcher; inspect the active host service manager and stale lock state first.",
    };
  }
  return {
    severity: "blocked",
    area: "daemon",
    message: violation,
    action: "Run `bun run samantha health:check` and inspect the active host service manager status.",
  };
}

export async function collectOpsSnapshot(input: {
  envFilePath: string;
  inboxDir: string;
  outboxDir: string;
  archiveInboxDir?: string;
  hostOwnershipPath?: string;
  currentHostId?: string;
  heartbeatPath: string;
  lockPath: string;
  telegramOffsetPath: string;
  telegramRepliesPath: string;
  serviceProvider?: ServiceTemplateProvider;
  serviceTemplateDir?: string;
  systemdUserDir?: string;
  launchdUserDir?: string;
  hostPlatform?: NodeJS.Platform;
  maxAgeMs?: number;
  maxPendingInboxAgeMs?: number;
  localOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  isAlive?: (pid: number) => boolean;
}): Promise<OpsSnapshot> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const localOnly = input.localOnly === true;
  const hostOwnershipPath = input.hostOwnershipPath ?? join(dirname(input.heartbeatPath), "host-ownership.json");
  const envValues = await envFileValues(input.envFilePath);
  const envHostId = env.SAMANTHA_HOST_ID?.trim() || envValues.get("SAMANTHA_HOST_ID");
  const currentHostId = input.currentHostId ?? envHostId ?? hostname();
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
  const replyState = localOnly
    ? undefined
    : sanitizeReplyState(await readOptionalJson<TelegramReplyState>(input.telegramRepliesPath));
  const sentFiles = new Set(replyState?.sentFiles ?? []);
  const hostPlatform = input.hostPlatform ?? platform();
  const shouldCheckSystemd = input.systemdUserDir !== undefined || hostPlatform === "linux";
  const systemdUserDir = input.systemdUserDir ?? join(homedir(), ".config/systemd/user");
  const launchdUserDir = input.launchdUserDir ?? join(homedir(), "Library/LaunchAgents");
  const serviceProvider =
    input.serviceProvider ??
    (input.launchdUserDir !== undefined
      ? "launchd"
      : input.systemdUserDir !== undefined
        ? "systemd"
        : hostPlatform === "darwin"
          ? "launchd"
          : "systemd");
  const serviceTemplateFiles = serviceProvider === "launchd" ? launchdFiles : systemdFiles;
  const serviceTemplateDir =
    input.serviceTemplateDir ?? (serviceProvider === "launchd" ? launchdUserDir : systemdUserDir);
  const maxAgeMs = input.maxAgeMs ?? 15_000;
  const maxPendingInboxAgeMs = input.maxPendingInboxAgeMs ?? 300_000;
  const systemd = {
    directory: systemdUserDir,
    checked: shouldCheckSystemd,
    platform: hostPlatform,
    files: shouldCheckSystemd
      ? await Promise.all(
          systemdFiles.map(async (file) => ({
            file,
            installed: await exists(join(systemdUserDir, file)),
          })),
        )
      : [],
  };
  const serviceTemplates = {
    provider: serviceProvider,
    directory: serviceTemplateDir,
    files: await Promise.all(
      serviceTemplateFiles.map(async (file) => ({
        file,
        installed: await exists(join(serviceTemplateDir, file)),
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
  const oldestPendingInbox = await oldestFile(input.inboxDir, (file) => file.endsWith(".json"));
  const oldestPendingInboxAgeMs = oldestPendingInbox
    ? now.getTime() - Date.parse(oldestPendingInbox.updatedAt)
    : undefined;
  const queues: QueueDiagnostics = {
    pendingInboxCount: await countFiles(input.inboxDir, (file) => file.endsWith(".json")),
    ...(oldestPendingInbox ? { oldestPendingInbox } : {}),
    ...(oldestPendingInboxAgeMs !== undefined ? { oldestPendingInboxAgeMs } : {}),
    outboxCount: await countFiles(input.outboxDir, (file) => file.endsWith(".md")),
    remoteOutboxCount: remoteOutbox.length,
    unsentRemoteOutboxCount: remoteOutbox.filter((file) => !sentFiles.has(file)).length,
    ...(latestRemoteCommandSummary ? { latestRemoteCommand: latestRemoteCommandSummary } : {}),
    ...(latestRemoteOutboxSummary ? { latestRemoteOutbox: latestRemoteOutboxSummary } : {}),
  };
  const telegram: TelegramStateDiagnostics = localOnly
    ? {}
    : {
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
  const hostOwnership = await hostOwnershipDiagnostics({
    path: hostOwnershipPath,
    currentHostId,
    now,
  });
  const missingServiceTemplates = serviceTemplates.files.filter((file) => !file.installed);
  const replyFailures = replyState?.failures ?? [];
  const latestReplyFailure = replyFailures.at(-1);
  const issues: OpsDiagnosticIssue[] = [
    ...(!hostOwnership.automationAllowed
      ? [
          {
            severity: "unsafe_to_continue" as const,
            area: "host" as const,
            message: `host ownership is ${hostOwnership.state}: ${hostOwnership.reason}`,
            action: "Repair `state/host-ownership.json` on the active automation host before running automation.",
          },
        ]
      : []),
    ...(!localOnly && !hasBotToken
      ? [
          {
            severity: "blocked" as const,
            area: "environment" as const,
            message: "TELEGRAM_BOT_TOKEN is missing",
            action: "Set TELEGRAM_BOT_TOKEN in the active host .env, then rerun `bun run samantha doctor`.",
          },
        ]
      : []),
    ...(!localOnly && !hasPollChatId
      ? [
          {
            severity: "blocked" as const,
            area: "environment" as const,
            message: "Telegram poll chat id is missing",
            action: "Set TELEGRAM_ALLOWED_SENDER_ID or TELEGRAM_CHAT_ID in the active host .env, then rerun `bun run samantha doctor`.",
          },
        ]
      : []),
    ...(!localOnly && !hasReplyChatId
      ? [
          {
            severity: "blocked" as const,
            area: "environment" as const,
            message: "Telegram reply chat id is missing",
            action: "Set TELEGRAM_REPLY_CHAT_ID or TELEGRAM_CHAT_ID in the active host .env, then rerun `bun run samantha doctor`.",
          },
        ]
      : []),
    ...(!hasCodexExecutable
      ? [
          {
            severity: "blocked" as const,
            area: "environment" as const,
            message: `Codex executable is missing: ${codexCommand}`,
            action: "Set SAMANTHA_CODEX_BIN in the active host .env or install codex on PATH, then rerun `bun run samantha doctor`.",
          },
        ]
      : []),
    ...effectiveHealth.violations.map(healthIssue),
    ...(oldestPendingInboxAgeMs !== undefined && oldestPendingInboxAgeMs > maxPendingInboxAgeMs
      ? [
          {
            severity: "blocked" as const,
            area: "inbox" as const,
            message: `oldest inbox command is stuck: ${oldestPendingInboxAgeMs}ms`,
            action: "Inspect `inbox/` and run `bun run samantha doctor`; do not start another watcher until host ownership is active.",
          },
        ]
      : []),
    ...missingServiceTemplates.map((file) => ({
      severity: "degraded" as const,
      area: "service" as const,
      message: `${serviceTemplates.provider} template not installed: ${file.file}`,
      action: `Install the ${serviceTemplates.provider} template from docs/DAEMON_OPERATIONS.md on the active automation host.`,
    })),
    ...(!localOnly && latestReplyFailure
      ? [
          {
            severity: "needs_bk" as const,
            area: "telegram" as const,
            message: `Telegram reply failed for ${latestReplyFailure.file}: ${latestReplyFailure.lastError}`,
            action: "Inspect Telegram env/network and `state/telegram-replies.json`, then rerun `bun run samantha doctor`.",
          },
        ]
      : []),
  ];
  const failures = issues
    .filter((issue) => issue.severity === "blocked" || issue.severity === "stale" || issue.severity === "unsafe_to_continue")
    .map((issue) => issue.message);
  const warnings = [
    ...pidVisibilityViolations.map((violation) => `pid visibility check failed: ${violation}`),
    ...(!localOnly && !telegram.offset ? ["telegram offset state is missing"] : []),
    ...(!localOnly && !telegram.replyState ? ["telegram reply state is missing"] : []),
    ...missingServiceTemplates.map((file) => `${serviceTemplates.provider} template not installed: ${file.file}`),
    ...(!localOnly && queues.unsentRemoteOutboxCount > 0 ? [`${queues.unsentRemoteOutboxCount} unsent remote outbox report(s)`] : []),
    ...(!localOnly && (replyState?.failures?.length ?? 0) > 0 ? [`${replyState?.failures?.length ?? 0} Telegram reply failure(s)`] : []),
  ];

  return {
    ok: failures.length === 0,
    checkedAt: now.toISOString(),
    hostOwnership,
    env: envDiagnostics,
    health: effectiveHealth,
    queues,
    telegram,
    serviceTemplates,
    systemd,
    issues,
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
