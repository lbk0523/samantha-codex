import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pollTelegramToInbox } from "../src/lib/telegram-adapter";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-telegram-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("pollTelegramToInbox", () => {
  test("maps allowed Telegram text updates into inbox commands", async () => {
    const root = await makeRoot();
    const fetchImpl = (async (url: string) => {
      expect(url).toContain("offset=7");
      return {
        statusText: "OK",
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                date: 1770000000,
                text: "/next-action",
                from: { id: 12345 },
                chat: { id: 12345 },
              },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const result = await pollTelegramToInbox({
      token: "token",
      inboxDir: join(root, "inbox"),
      allowedSenderId: "12345",
      offset: 7,
      fetchImpl,
    });

    expect(result.nextOffset).toBe(11);
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0]?.command.type).toBe("ops:next-action");
    expect(result.enqueued[0]?.command.id?.endsWith("-10-next-action")).toBe(true);
    expect(await readFile(result.enqueued[0]?.path ?? "", "utf8")).toContain("ops:next-action");
  });

  test("can authorize by Telegram chat id for legacy Samantha env compatibility", async () => {
    const root = await makeRoot();
    const fetchImpl = (async () => ({
      statusText: "OK",
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 30,
            message: {
              text: "/tasks",
              from: { id: 12345 },
              chat: { id: 777 },
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await pollTelegramToInbox({
      token: "token",
      inboxDir: join(root, "inbox"),
      allowedSenderId: "777",
      fetchImpl,
    });

    expect(result.enqueued[0]?.command.type).toBe("tasks:list");
  });

  test("ignores disallowed or unsupported Telegram updates", async () => {
    const root = await makeRoot();
    const fetchImpl = (async () => ({
      statusText: "OK",
      json: async () => ({
        ok: true,
        result: [
          { update_id: 20, message: { text: "/runs", from: { id: 999 } } },
          { update_id: 21, message: { text: "/unknown", from: { id: 12345 } } },
          { update_id: 22, message: { from: { id: 12345 } } },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await pollTelegramToInbox({
      token: "token",
      inboxDir: join(root, "inbox"),
      allowedSenderId: "12345",
      fetchImpl,
    });

    expect(result.enqueued).toEqual([]);
    expect(result.nextOffset).toBe(23);
    expect(result.ignored.map((item) => item.updateId)).toEqual([20, 21, 22]);
  });

  test("requires an explicit allowed sender id", async () => {
    await expect(
      pollTelegramToInbox({
        token: "token",
        inboxDir: "/tmp/inbox",
        allowedSenderId: "",
        fetchImpl: (async () => ({ json: async () => ({ ok: true, result: [] }) })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("allowed sender id");
  });

  test("times out stalled Telegram polling requests", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    await expect(
      pollTelegramToInbox({
        token: "token",
        inboxDir: "/tmp/inbox",
        allowedSenderId: "12345",
        clientTimeoutMs: 1,
        fetchImpl,
      }),
    ).rejects.toThrow("telegram getUpdates timed out");
  });
});
