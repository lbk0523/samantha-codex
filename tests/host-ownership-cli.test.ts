import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-host-cli-"));
  tmpRoots.push(root);
  return root;
}

async function runSamantha(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", "run", "src/samantha.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("host ownership CLI", () => {
  test("host:claim writes an active ownership record under the state dir", async () => {
    const root = await makeRoot();
    const stateDir = join(root, "state");
    const expiresAt = "2026-06-10T00:00:00.000Z";

    const result = await runSamantha([
      "host:claim",
      "--host-id=mac-candidate",
      `--expires-at=${expiresAt}`,
      `--state-dir=${stateDir}`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as { path: string; record: Record<string, unknown> };
    const path = join(stateDir, "host-ownership.json");
    const record = await readJson(path);
    expect(output.path).toBe(path);
    expect(output.record).toEqual(record);
    expect(record).toMatchObject({
      schemaVersion: 1,
      role: "active_automation_host",
      hostId: "mac-candidate",
      expiresAt,
    });
    expect(Number.isNaN(Date.parse(String(record.updatedAt)))).toBe(false);
  });

  test("host:client writes a client ownership record to an explicit path", async () => {
    const root = await makeRoot();
    const path = join(root, "custom-host-ownership.json");

    const result = await runSamantha([
      "host:client",
      "--host-id=ssh-candidate",
      `--host-ownership-path=${path}`,
    ]);

    expect(result.exitCode).toBe(0);
    const record = await readJson(path);
    expect(record).toMatchObject({
      schemaVersion: 1,
      role: "client_machine",
      hostId: "ssh-candidate",
    });
    expect(record.expiresAt).toBeUndefined();
  });

  test("doctor --local-only suppresses Telegram-required failures but keeps local blockers", async () => {
    const root = await makeRoot();
    const stateDir = join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "host-ownership.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        role: "active_automation_host",
        hostId: "mac-candidate",
        updatedAt: "2026-05-11T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const result = await runSamantha(
      [
        "doctor",
        "--json",
        "--local-only",
        "--host-id=mac-candidate",
        `--state-dir=${stateDir}`,
        `--env-file=${join(root, ".env")}`,
        `--inbox-dir=${join(root, "inbox")}`,
        `--outbox-dir=${join(root, "outbox")}`,
        `--archive-dir=${join(root, "archive", "inbox")}`,
      ],
      {
        SAMANTHA_CODEX_BIN: join(root, "missing-codex"),
        TELEGRAM_ALLOWED_SENDER_ID: "",
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_CHAT_ID: "",
        TELEGRAM_REPLY_CHAT_ID: "",
      },
    );

    expect(result.exitCode).toBe(1);
    const snapshot = JSON.parse(result.stdout) as {
      failures: string[];
      warnings: string[];
    };
    expect(snapshot.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Codex executable is missing:"),
        "daemon lock is missing",
      ]),
    );
    expect(snapshot.failures).not.toContain("TELEGRAM_BOT_TOKEN is missing");
    expect(snapshot.failures).not.toContain("Telegram poll chat id is missing");
    expect(snapshot.failures).not.toContain("Telegram reply chat id is missing");
    expect(snapshot.warnings).not.toContain("telegram offset state is missing");
    expect(snapshot.warnings).not.toContain("telegram reply state is missing");
  });

  test("doctor --local-only ignores malformed Telegram state files", async () => {
    const root = await makeRoot();
    const stateDir = join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "host-ownership.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        role: "active_automation_host",
        hostId: "mac-candidate",
        updatedAt: "2026-05-11T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(join(stateDir, "telegram-offset.json"), "{bad json\n", "utf8");
    await writeFile(join(stateDir, "telegram-replies.json"), "{bad json\n", "utf8");

    const result = await runSamantha(
      [
        "doctor",
        "--json",
        "--local-only",
        "--host-id=mac-candidate",
        `--state-dir=${stateDir}`,
        `--env-file=${join(root, ".env")}`,
        `--inbox-dir=${join(root, "inbox")}`,
        `--outbox-dir=${join(root, "outbox")}`,
        `--archive-dir=${join(root, "archive", "inbox")}`,
      ],
      {
        SAMANTHA_CODEX_BIN: "bun",
        TELEGRAM_ALLOWED_SENDER_ID: "",
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_CHAT_ID: "",
        TELEGRAM_REPLY_CHAT_ID: "",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const snapshot = JSON.parse(result.stdout) as {
      failures: string[];
      telegram: Record<string, unknown>;
    };
    expect(snapshot.failures).toContain("daemon lock is missing");
    expect(snapshot.telegram).toEqual({});
  });
});
