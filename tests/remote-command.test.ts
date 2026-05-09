import { describe, expect, test } from "bun:test";
import { commandFromRemoteInput } from "../src/lib/remote-command";

describe("commandFromRemoteInput", () => {
  test("maps narrow Telegram approval to latest decision approval without ids", () => {
    const command = commandFromRemoteInput(
      {
        senderId: "bk",
        text: "/approve",
        receivedAt: "2026-05-07T11:00:00.000Z",
        remoteId: 7,
      },
      "bk",
    );

    expect(command).toMatchObject({
      type: "decisions:approve-latest",
      args: { source: "remote", receivedAt: "2026-05-07T11:00:00.000Z" },
    });
    expect(JSON.stringify(command)).not.toContain("decision-");
  });

  test("does not accept id-bearing Telegram approval workflows", () => {
    expect(() =>
      commandFromRemoteInput(
        { senderId: "bk", text: "/approve decision-20260507-plan-12345678" },
        "bk",
      ),
    ).toThrow("unsupported remote command");
  });

  test("maps Telegram answer to blocker clarification resolution without ids", () => {
    const command = commandFromRemoteInput(
      {
        senderId: "bk",
        text: "/answer 계속 진행해도 돼",
        receivedAt: "2026-05-07T11:05:00.000Z",
        remoteId: 8,
      },
      "bk",
    );

    expect(command).toMatchObject({
      type: "decisions:answer-blocker-clarification",
      args: {
        source: "remote",
        receivedAt: "2026-05-07T11:05:00.000Z",
        note: "계속 진행해도 돼",
      },
    });
    expect(JSON.stringify(command)).not.toContain("decision-");
  });

  test("rejects empty Telegram answers", () => {
    expect(() => commandFromRemoteInput({ senderId: "bk", text: "/answer" }, "bk")).toThrow("missing answer text");
    expect(() => commandFromRemoteInput({ senderId: "bk", text: "/answer   " }, "bk")).toThrow("missing answer text");
  });

  test("redirects legacy yes and accept responses to approve", () => {
    expect(commandFromRemoteInput({ senderId: "bk", text: "/yes" }, "bk")).toMatchObject({
      type: "remote:deprecated",
      args: { replacement: "/approve" },
    });
    expect(commandFromRemoteInput({ senderId: "bk", text: "/accept" }, "bk")).toMatchObject({
      type: "remote:deprecated",
      args: { replacement: "/approve" },
    });
  });
});
