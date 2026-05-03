import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DaemonLockInfo {
  schemaVersion: 1;
  pid: number;
  command: string;
  startedAt: string;
}

export interface AcquiredDaemonLock {
  path: string;
  info: DaemonLockInfo;
  release: () => Promise<void>;
}

export interface DaemonHeartbeat {
  schemaVersion: 1;
  pid: number;
  command: string;
  status: "running" | "stopping";
  lockPath: string;
  inboxDir: string;
  outboxDir: string;
  archiveDir: string;
  processedTotal: number;
  updatedAt: string;
}

export interface DaemonHealthResult {
  ok: boolean;
  heartbeat?: DaemonHeartbeat;
  lock?: DaemonLockInfo;
  ageMs?: number;
  violations: string[];
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function acquireDaemonLock(input: {
  lockPath: string;
  command: string;
  pid?: number;
  now?: Date;
  isAlive?: (pid: number) => boolean;
}): Promise<AcquiredDaemonLock> {
  const pid = input.pid ?? process.pid;
  const isAlive = input.isAlive ?? isProcessAlive;
  const info: DaemonLockInfo = {
    schemaVersion: 1,
    pid,
    command: input.command,
    startedAt: nowIso(input.now),
  };

  await mkdir(dirname(input.lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(input.lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, "utf8");
      await handle.close();
      return {
        path: input.lockPath,
        info,
        release: async () => {
          const current = await readJsonFile<DaemonLockInfo>(input.lockPath);
          if (current?.pid === pid) {
            await rm(input.lockPath, { force: true });
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const current = await readJsonFile<DaemonLockInfo>(input.lockPath);
      if (current?.pid && isAlive(current.pid)) {
        throw new Error(`daemon already running: pid ${current.pid}`);
      }
      await rm(input.lockPath, { force: true });
    }
  }

  throw new Error(`could not acquire daemon lock: ${input.lockPath}`);
}

export async function writeDaemonHeartbeat(path: string, heartbeat: DaemonHeartbeat): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
}

export async function readDaemonHeartbeat(path: string): Promise<DaemonHeartbeat | undefined> {
  return readJsonFile<DaemonHeartbeat>(path);
}

export async function checkDaemonHealth(input: {
  heartbeatPath: string;
  lockPath: string;
  maxAgeMs?: number;
  now?: Date;
  isAlive?: (pid: number) => boolean;
}): Promise<DaemonHealthResult> {
  const maxAgeMs = input.maxAgeMs ?? 15_000;
  const now = input.now ?? new Date();
  const isAlive = input.isAlive ?? isProcessAlive;
  const [heartbeat, lock] = await Promise.all([
    readJsonFile<DaemonHeartbeat>(input.heartbeatPath),
    readJsonFile<DaemonLockInfo>(input.lockPath),
  ]);
  const violations: string[] = [];
  let ageMs: number | undefined;

  if (!heartbeat) {
    violations.push("heartbeat is missing");
  } else {
    const updatedAt = Date.parse(heartbeat.updatedAt);
    if (Number.isNaN(updatedAt)) {
      violations.push("heartbeat updatedAt is invalid");
    } else {
      ageMs = now.getTime() - updatedAt;
      if (ageMs > maxAgeMs) {
        violations.push(`heartbeat is stale: ${ageMs}ms`);
      }
    }
    if (!isAlive(heartbeat.pid)) {
      violations.push(`heartbeat pid is not running: ${heartbeat.pid}`);
    }
  }

  if (!lock) {
    violations.push("daemon lock is missing");
  } else if (!isAlive(lock.pid)) {
    violations.push(`lock pid is not running: ${lock.pid}`);
  }

  return {
    ok: violations.length === 0,
    heartbeat,
    lock,
    ageMs,
    violations,
  };
}
