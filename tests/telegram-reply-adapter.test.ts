import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendOutboxReplies, telegramReplyText } from "../src/lib/telegram-reply-adapter";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-telegram-reply-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("sendOutboxReplies", () => {
  test("initializes state without sending existing remote outbox reports", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    await mkdir(outbox, { recursive: true });
    await writeFile(join(outbox, "remote-old.md"), "# old\n", "utf8");

    const result = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath: join(root, "state", "telegram-replies.json"),
      fetchImpl: (async () => {
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
    });

    expect(result.initialized).toBe(true);
    expect(result.sent).toEqual([]);
    expect(await readFile(join(root, "state", "telegram-replies.json"), "utf8")).toContain("remote-old.md");
  });

  test("sends only unsent remote outbox reports to Telegram", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    const statePath = join(root, "state", "telegram-replies.json");
    await mkdir(outbox, { recursive: true });
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({ schemaVersion: 1, sentFiles: ["remote-old.md"], updatedAt: "now" }),
      "utf8",
    );
    await writeFile(join(outbox, "remote-old.md"), "# old\n", "utf8");
    await writeFile(join(outbox, "remote-new.md"), "# new\n", "utf8");
    await writeFile(join(outbox, "local.md"), "# local\n", "utf8");
    const sentBodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return {
        statusText: "OK",
        json: async () => ({ ok: true }),
      };
    }) as unknown as typeof fetch;

    const result = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath,
      minAgeMs: 0,
      fetchImpl,
    });

    expect(result.sent.map((item) => item.file)).toEqual(["remote-new.md"]);
    expect(sentBodies).toEqual([
      {
        chat_id: "12345",
        text: "Samantha outbox: remote-new.md\n\n# new",
        disable_web_page_preview: true,
      },
    ]);
    expect(await readFile(statePath, "utf8")).toContain("remote-new.md");
  });

  test("can send existing reports explicitly", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    await mkdir(outbox, { recursive: true });
    await writeFile(join(outbox, "remote-existing.md"), "# existing\n", "utf8");

    const result = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath: join(root, "state", "telegram-replies.json"),
      sendExisting: true,
      minAgeMs: 0,
      fetchImpl: (async () => ({
        statusText: "OK",
        json: async () => ({ ok: true }),
      })) as unknown as typeof fetch,
    });

    expect(result.initialized).toBe(false);
    expect(result.sent[0]?.file).toBe("remote-existing.md");
  });

  test("truncates long reports", () => {
    const text = telegramReplyText("remote-long.md", "x".repeat(5000), 100);

    expect(text.length).toBeLessThanOrEqual(100);
    expect(text).toContain("[truncated]");
  });

  test("times out stalled Telegram sendMessage requests", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    await mkdir(outbox, { recursive: true });
    await writeFile(join(outbox, "remote-new.md"), "# new\n", "utf8");
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    await expect(
      sendOutboxReplies({
        token: "token",
        chatId: "12345",
        outboxDir: outbox,
        statePath: join(root, "state", "telegram-replies.json"),
        sendExisting: true,
        minAgeMs: 0,
        clientTimeoutMs: 1,
        fetchImpl,
      }),
    ).rejects.toThrow("telegram sendMessage timed out");
  });
});
