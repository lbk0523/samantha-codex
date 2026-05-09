import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireDaemonLock, writeDaemonHeartbeat } from "../src/lib/daemon";
import { collectOpsSnapshot, withoutActiveInboxCommand } from "../src/lib/ops-diagnostics";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-ops-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("collectOpsSnapshot", () => {
  test("summarizes environment, daemon, queue, Telegram, and systemd state without secrets", async () => {
    const root = await makeRoot();
    const envFilePath = join(root, ".env");
    const inboxDir = join(root, "inbox");
    const outboxDir = join(root, "outbox");
    const archiveInboxDir = join(root, "archive", "inbox");
    const stateDir = join(root, "state");
    const systemdDir = join(root, "systemd");
    const binDir = join(root, "bin");
    const lockPath = join(stateDir, "daemon.lock");
    const heartbeatPath = join(stateDir, "heartbeat.json");
    await Promise.all([
      mkdir(inboxDir, { recursive: true }),
      mkdir(outboxDir, { recursive: true }),
      mkdir(archiveInboxDir, { recursive: true }),
      mkdir(systemdDir, { recursive: true }),
      mkdir(binDir, { recursive: true }),
    ]);
    await writeFile(envFilePath, "TELEGRAM_BOT_TOKEN=secret\nTELEGRAM_CHAT_ID=12345\n", "utf8");
    await writeFile(join(binDir, "codex"), "", "utf8");
    await writeFile(join(inboxDir, "pending.json"), "{}", "utf8");
    await writeFile(join(outboxDir, "remote-a.md"), "# a\n", "utf8");
    await writeFile(join(outboxDir, "remote-b.md"), "# b\n", "utf8");
    await writeFile(join(outboxDir, "local.md"), "# local\n", "utf8");
    await writeFile(
      join(archiveInboxDir, "remote-2026-05-03t10-00-00.000z-status.json"),
      JSON.stringify({
        id: "remote-2026-05-03t10-00-00.000z-status",
        type: "status:show",
        args: { receivedAt: "2026-05-03T10:00:00.000Z" },
      }),
      "utf8",
    );
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "telegram-offset.json"), JSON.stringify({ nextOffset: 77 }), "utf8");
    await writeFile(
      join(stateDir, "telegram-replies.json"),
      JSON.stringify({ schemaVersion: 1, sentFiles: ["remote-a.md"], updatedAt: "2026-05-03T10:00:00.000Z" }),
      "utf8",
    );
    for (const file of [
      "samantha-inbox-watch.service",
      "samantha-actions-watch.service",
      "samantha-telegram-poll.service",
      "samantha-telegram-poll.timer",
      "samantha-telegram-reply.service",
      "samantha-telegram-reply.timer",
      "samantha-ceo-notify.service",
      "samantha-ceo-notify.timer",
    ]) {
      await writeFile(join(systemdDir, file), "", "utf8");
    }
    await acquireDaemonLock({
      lockPath,
      command: "inbox:watch",
      pid: 101,
      now: new Date("2026-05-03T10:00:00.000Z"),
      isAlive: (pid) => pid === 101,
    });
    await writeDaemonHeartbeat(heartbeatPath, {
      schemaVersion: 1,
      pid: 101,
      command: "inbox:watch",
      status: "running",
      lockPath,
      inboxDir,
      outboxDir,
      archiveDir: join(root, "archive"),
      processedTotal: 3,
      updatedAt: "2026-05-03T10:00:10.000Z",
    });

    const snapshot = await collectOpsSnapshot({
      envFilePath,
      inboxDir,
      outboxDir,
      archiveInboxDir,
      heartbeatPath,
      lockPath,
      telegramOffsetPath: join(stateDir, "telegram-offset.json"),
      telegramRepliesPath: join(stateDir, "telegram-replies.json"),
      systemdUserDir: systemdDir,
      env: { PATH: binDir },
      now: new Date("2026-05-03T10:00:11.000Z"),
      isAlive: (pid) => pid === 101,
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.env.hasBotToken).toBe(true);
    expect(snapshot.env.hasPollChatId).toBe(true);
    expect(snapshot.env.hasCodexExecutable).toBe(true);
    expect(snapshot.queues.pendingInboxCount).toBe(1);
    expect(snapshot.queues.outboxCount).toBe(3);
    expect(snapshot.queues.remoteOutboxCount).toBe(2);
    expect(snapshot.queues.unsentRemoteOutboxCount).toBe(1);
    expect(snapshot.queues.latestRemoteCommand?.type).toBe("status:show");
    expect(snapshot.queues.latestRemoteOutbox?.file).toBe("remote-b.md");
    expect(snapshot.telegram.offset?.nextOffset).toBe(77);
    expect(snapshot.warnings).toContain("1 unsent remote outbox report(s)");
    expect(snapshot.warnings).not.toContain("systemd template not installed: samantha-ceo-notify.timer");
    expect(snapshot.serviceTemplates?.provider).toBe("systemd");
    expect(snapshot.serviceTemplates?.files.every((file) => file.installed)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  test("checks launchd templates on macOS automation hosts", async () => {
    const root = await makeRoot();
    const launchdDir = join(root, "LaunchAgents");
    await mkdir(launchdDir, { recursive: true });
    await writeFile(join(launchdDir, "com.bk.samantha.inbox-watch.plist"), "", "utf8");

    const snapshot = await collectOpsSnapshot({
      envFilePath: join(root, ".env"),
      inboxDir: join(root, "inbox"),
      outboxDir: join(root, "outbox"),
      heartbeatPath: join(root, "state", "heartbeat.json"),
      lockPath: join(root, "state", "daemon.lock"),
      telegramOffsetPath: join(root, "state", "telegram-offset.json"),
      telegramRepliesPath: join(root, "state", "telegram-replies.json"),
      serviceProvider: "launchd",
      serviceTemplateDir: launchdDir,
      env: {},
    });

    expect(snapshot.serviceTemplates?.provider).toBe("launchd");
    expect(snapshot.serviceTemplates?.directory).toBe(launchdDir);
    expect(snapshot.serviceTemplates?.files.map((file) => file.file)).toContain("com.bk.samantha.inbox-watch.plist");
    expect(snapshot.warnings).toContain("launchd template not installed: com.bk.samantha.actions-watch.plist");
  });

  test("reports missing runtime prerequisites as failures and warnings", async () => {
    const root = await makeRoot();
    const snapshot = await collectOpsSnapshot({
      envFilePath: join(root, ".env"),
      inboxDir: join(root, "inbox"),
      outboxDir: join(root, "outbox"),
      heartbeatPath: join(root, "state", "heartbeat.json"),
      lockPath: join(root, "state", "daemon.lock"),
      telegramOffsetPath: join(root, "state", "telegram-offset.json"),
      telegramRepliesPath: join(root, "state", "telegram-replies.json"),
      systemdUserDir: join(root, "systemd"),
      env: {},
    });

    expect(snapshot.ok).toBe(false);
    expect(snapshot.failures).toContain("TELEGRAM_BOT_TOKEN is missing");
    expect(snapshot.failures).toContain("Codex executable is missing: codex");
    expect(snapshot.failures).toContain("daemon lock is missing");
    expect(snapshot.warnings).toContain("telegram offset state is missing");
    expect(snapshot.warnings).toContain("telegram reply state is missing");
    expect(snapshot.warnings).toContain("systemd template not installed: samantha-ceo-notify.timer");
  });

  test("reports stale heartbeat and dead lock state as runtime failures", async () => {
    const root = await makeRoot();
    const stateDir = join(root, "state");
    const systemdDir = join(root, "systemd");
    const binDir = join(root, "bin");
    const lockPath = join(stateDir, "daemon.lock");
    const heartbeatPath = join(stateDir, "heartbeat.json");
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(systemdDir, { recursive: true }),
      mkdir(binDir, { recursive: true }),
    ]);
    await writeFile(join(root, ".env"), "TELEGRAM_BOT_TOKEN=secret\nTELEGRAM_CHAT_ID=12345\n", "utf8");
    await writeFile(join(binDir, "codex"), "", "utf8");
    await writeFile(join(stateDir, "telegram-offset.json"), JSON.stringify({ nextOffset: 77 }), "utf8");
    await writeFile(
      join(stateDir, "telegram-replies.json"),
      JSON.stringify({ schemaVersion: 1, sentFiles: [], updatedAt: "2026-05-03T10:00:00.000Z" }),
      "utf8",
    );
    for (const file of [
      "samantha-inbox-watch.service",
      "samantha-actions-watch.service",
      "samantha-telegram-poll.service",
      "samantha-telegram-poll.timer",
      "samantha-telegram-reply.service",
      "samantha-telegram-reply.timer",
      "samantha-ceo-notify.service",
      "samantha-ceo-notify.timer",
    ]) {
      await writeFile(join(systemdDir, file), "", "utf8");
    }
    await acquireDaemonLock({
      lockPath,
      command: "inbox:watch",
      pid: 202,
      now: new Date("2026-05-03T09:59:00.000Z"),
      isAlive: () => false,
    });
    await writeDaemonHeartbeat(heartbeatPath, {
      schemaVersion: 1,
      pid: 101,
      command: "inbox:watch",
      status: "running",
      lockPath,
      inboxDir: join(root, "inbox"),
      outboxDir: join(root, "outbox"),
      archiveDir: join(root, "archive"),
      processedTotal: 3,
      updatedAt: "2026-05-03T10:00:00.000Z",
    });

    const snapshot = await collectOpsSnapshot({
      envFilePath: join(root, ".env"),
      inboxDir: join(root, "inbox"),
      outboxDir: join(root, "outbox"),
      heartbeatPath,
      lockPath,
      telegramOffsetPath: join(stateDir, "telegram-offset.json"),
      telegramRepliesPath: join(stateDir, "telegram-replies.json"),
      systemdUserDir: systemdDir,
      env: { PATH: binDir },
      now: new Date("2026-05-03T10:01:00.000Z"),
      maxAgeMs: 5_000,
      isAlive: () => false,
    });

    expect(snapshot.ok).toBe(false);
    expect(snapshot.failures.some((failure) => failure.startsWith("heartbeat is stale"))).toBe(true);
    expect(snapshot.failures).toContain("heartbeat pid is not running: 101");
    expect(snapshot.failures).toContain("lock pid is not running: 202");
  });

  test("can exclude the currently processed inbox command from queue counts", async () => {
    const root = await makeRoot();
    const snapshot = await collectOpsSnapshot({
      envFilePath: join(root, ".env"),
      inboxDir: join(root, "inbox"),
      outboxDir: join(root, "outbox"),
      heartbeatPath: join(root, "state", "heartbeat.json"),
      lockPath: join(root, "state", "daemon.lock"),
      telegramOffsetPath: join(root, "state", "telegram-offset.json"),
      telegramRepliesPath: join(root, "state", "telegram-replies.json"),
      systemdUserDir: join(root, "systemd"),
      env: {},
    });

    expect(withoutActiveInboxCommand(snapshot).queues.pendingInboxCount).toBe(0);

    const withPending = {
      ...snapshot,
      queues: { ...snapshot.queues, pendingInboxCount: 2 },
    };
    expect(withoutActiveInboxCommand(withPending).queues.pendingInboxCount).toBe(1);
  });

  test("downgrades pid visibility failures when heartbeat and lock are fresh", async () => {
    const root = await makeRoot();
    const stateDir = join(root, "state");
    const lockPath = join(stateDir, "daemon.lock");
    const heartbeatPath = join(stateDir, "heartbeat.json");
    const systemdDir = join(root, "systemd");
    const codexBin = join(root, "bin", "codex");
    await mkdir(stateDir, { recursive: true });
    await mkdir(systemdDir, { recursive: true });
    await mkdir(join(root, "bin"), { recursive: true });
    for (const file of [
      "samantha-inbox-watch.service",
      "samantha-actions-watch.service",
      "samantha-telegram-poll.service",
      "samantha-telegram-poll.timer",
      "samantha-telegram-reply.service",
      "samantha-telegram-reply.timer",
      "samantha-ceo-notify.service",
      "samantha-ceo-notify.timer",
    ]) {
      await writeFile(join(systemdDir, file), "", "utf8");
    }
    await writeFile(codexBin, "", "utf8");
    await writeFile(
      join(root, ".env"),
      `TELEGRAM_BOT_TOKEN=secret\nTELEGRAM_CHAT_ID=12345\nSAMANTHA_CODEX_BIN=${codexBin}\n`,
      "utf8",
    );
    await acquireDaemonLock({
      lockPath,
      command: "inbox:watch",
      pid: 101,
      now: new Date("2026-05-03T10:00:00.000Z"),
      isAlive: () => false,
    });
    await writeDaemonHeartbeat(heartbeatPath, {
      schemaVersion: 1,
      pid: 101,
      command: "inbox:watch",
      status: "running",
      lockPath,
      inboxDir: join(root, "inbox"),
      outboxDir: join(root, "outbox"),
      archiveDir: join(root, "archive"),
      processedTotal: 1,
      updatedAt: "2026-05-03T10:00:10.000Z",
    });

    const snapshot = await collectOpsSnapshot({
      envFilePath: join(root, ".env"),
      inboxDir: join(root, "inbox"),
      outboxDir: join(root, "outbox"),
      heartbeatPath,
      lockPath,
      telegramOffsetPath: join(root, "state", "telegram-offset.json"),
      telegramRepliesPath: join(root, "state", "telegram-replies.json"),
      systemdUserDir: systemdDir,
      now: new Date("2026-05-03T10:00:11.000Z"),
      isAlive: () => false,
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.warnings.some((warning) => warning.startsWith("pid visibility check failed"))).toBe(true);
  });
});
