import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireDaemonLock,
  checkDaemonHealth,
  writeDaemonHeartbeat,
} from "../src/lib/daemon";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-daemon-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("daemon lock and health", () => {
  test("prevents duplicate live watchers", async () => {
    const root = await makeRoot();
    const lockPath = join(root, "daemon.lock");
    const lock = await acquireDaemonLock({
      lockPath,
      command: "inbox:watch",
      pid: 101,
      isAlive: (pid) => pid === 101,
    });

    await expect(
      acquireDaemonLock({
        lockPath,
        command: "inbox:watch",
        pid: 202,
        isAlive: (pid) => pid === 101,
      }),
    ).rejects.toThrow("daemon already running");

    await lock.release();
  });

  test("replaces stale lock files", async () => {
    const root = await makeRoot();
    const lockPath = join(root, "daemon.lock");
    await acquireDaemonLock({
      lockPath,
      command: "inbox:watch",
      pid: 101,
      isAlive: () => false,
    });

    const lock = await acquireDaemonLock({
      lockPath,
      command: "inbox:watch",
      pid: 202,
      isAlive: () => false,
    });

    expect(lock.info.pid).toBe(202);
    await lock.release();
  });

  test("reports healthy recent heartbeat and live lock", async () => {
    const root = await makeRoot();
    const lockPath = join(root, "daemon.lock");
    const heartbeatPath = join(root, "heartbeat.json");
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
      inboxDir: join(root, "inbox"),
      outboxDir: join(root, "outbox"),
      archiveDir: join(root, "archive"),
      processedTotal: 3,
      updatedAt: "2026-05-03T10:00:10.000Z",
    });

    const health = await checkDaemonHealth({
      heartbeatPath,
      lockPath,
      now: new Date("2026-05-03T10:00:11.000Z"),
      maxAgeMs: 5_000,
      isAlive: (pid) => pid === 101,
    });

    expect(health.ok).toBe(true);
    expect(health.heartbeat?.processedTotal).toBe(3);
  });

  test("reports stale heartbeats", async () => {
    const root = await makeRoot();
    const lockPath = join(root, "daemon.lock");
    const heartbeatPath = join(root, "heartbeat.json");
    await acquireDaemonLock({
      lockPath,
      command: "inbox:watch",
      pid: 101,
      isAlive: (pid) => pid === 101,
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
      processedTotal: 0,
      updatedAt: "2026-05-03T10:00:00.000Z",
    });

    const health = await checkDaemonHealth({
      heartbeatPath,
      lockPath,
      now: new Date("2026-05-03T10:01:00.000Z"),
      maxAgeMs: 5_000,
      isAlive: (pid) => pid === 101,
    });

    expect(health.ok).toBe(false);
    expect(health.violations.some((violation) => violation.startsWith("heartbeat is stale"))).toBe(true);
  });

  test("ships a systemd user service template for inbox:watch", async () => {
    const service = await readFile(resolve("ops/systemd/samantha-inbox-watch.service"), "utf8");

    expect(service).toContain("ExecStart=%h/.bun/bin/bun run samantha inbox:watch --interval-ms=1000");
    expect(service).toContain("Restart=on-failure");
    expect(service).toContain("WantedBy=default.target");
  });

  test("ships systemd user timer templates for Telegram polling", async () => {
    const service = await readFile(resolve("ops/systemd/samantha-telegram-poll.service"), "utf8");
    const timer = await readFile(resolve("ops/systemd/samantha-telegram-poll.timer"), "utf8");

    expect(service).toContain("EnvironmentFile=-%h/projects/samantha-codex/.env");
    expect(service).toContain("ExecStart=%h/.bun/bin/bun run samantha telegram:poll --timeout-seconds=25");
    expect(service).toContain("TimeoutStartSec=45");
    expect(timer).toContain("OnUnitInactiveSec=3s");
    expect(timer).toContain("AccuracySec=1s");
    expect(timer).toContain("WantedBy=timers.target");
  });

  test("ships systemd user timer templates for Telegram outbox replies", async () => {
    const service = await readFile(resolve("ops/systemd/samantha-telegram-reply.service"), "utf8");
    const timer = await readFile(resolve("ops/systemd/samantha-telegram-reply.timer"), "utf8");

    expect(service).toContain("EnvironmentFile=-%h/projects/samantha-codex/.env");
    expect(service).toContain("ExecStart=%h/.bun/bin/bun run samantha telegram:reply");
    expect(service).toContain("TimeoutStartSec=45");
    expect(timer).toContain("OnUnitInactiveSec=3s");
    expect(timer).toContain("AccuracySec=1s");
    expect(timer).toContain("WantedBy=timers.target");
  });
});
