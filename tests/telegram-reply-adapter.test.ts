import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compactTelegramReport, sendOutboxReplies, telegramReplyMessages } from "../src/lib/telegram-reply-adapter";

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
    expect(result.failed).toEqual([]);
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
      now: new Date(Date.now() + 1000),
      fetchImpl,
    });

    expect(result.sent.map((item) => item.file)).toEqual(["remote-new.md"]);
    expect(result.sent[0]?.messages).toBe(1);
    expect(result.failed).toEqual([]);
    expect(sentBodies).toEqual([
      {
        chat_id: "12345",
        text: "new",
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
      now: new Date(Date.now() + 60_000),
      fetchImpl: (async () => ({
        statusText: "OK",
        json: async () => ({ ok: true }),
      })) as unknown as typeof fetch,
    });

    expect(result.initialized).toBe(false);
    expect(result.sent[0]?.file).toBe("remote-existing.md");
  });

  test("does not send copyable id messages as separate Telegram sends", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    const statePath = join(root, "state", "telegram-replies.json");
    await mkdir(outbox, { recursive: true });
    await writeFile(
      join(outbox, "remote-propose.md"),
      [
        "# proposals:add",
        "",
        "Saved proposal: `proposal-2026-05-04t10-00-00.000z-10`",
        "Status: `pending_review`",
      ].join("\n"),
      "utf8",
    );
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
      sendExisting: true,
      minAgeMs: 0,
      now: new Date(Date.now() + 1000),
      fetchImpl,
    });

    expect(result.sent[0]?.messages).toBe(1);
    expect(sentBodies.map((body) => (body as { text: string }).text)).toEqual([
      [
        "proposals add",
        "",
        "Status: `pending_review`",
      ].join("\n"),
    ]);
  });

  test("splits long reports into multiple Telegram messages", () => {
    const messages = telegramReplyMessages("remote-long.md", "x".repeat(5000), 100);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 100)).toBe(true);
    expect(messages[0]).toContain("part 1/");
  });

  test("compacts Telegram reports without exposing workflow ids", () => {
    const report = compactTelegramReport(
      [
        "# execution-result",
        "",
        "저장된 요청: `request-20260506-090000-work-abc12345`",
        "액션: `action-1`",
        "태스크: `task-1` - 보고서 작성",
        "대상 repo: `oh-my-health-trainer`",
        "작업 유형: 계획/보고 - 커밋 없음 정상",
        "런: `run-1`",
        "결과: `pass`",
        "변경 파일:",
        "- `src > lib > operator-reports.ts`",
        "기록:",
        "- Run log: `/runs/run-1.json`",
        "다음 액션:",
        "- 텔레그램: `/go`",
        "로컬 merge 후보:",
        "`bun run samantha merge:check --run-log=/runs/run-1.json --repo-root=/repo`",
      ].join("\n"),
    );

    expect(report).toContain("실행 결과");
    expect(report).toContain("작업: 보고서 작성");
    expect(report).toContain("대상 repo: `oh-my-health-trainer`");
    expect(report).toContain("작업 유형: 계획/보고 - 커밋 없음 정상");
    expect(report).toContain("결과: `pass`");
    expect(report).toContain("텔레그램: `/go`");
    expect(report).not.toContain("action-1");
    expect(report).not.toContain("task-1");
    expect(report).not.toContain("run-1");
    expect(report).not.toContain("request-20260506-090000-work-abc12345");
    expect(report).not.toContain("operator-reports");
    expect(report).not.toContain("merge:check");
  });

  test("keeps compact plan-result outcome, artifacts, risk, and one next command", () => {
    const report = compactTelegramReport(
      [
        "# plan-result",
        "",
        "계획 결과: 구현 통과",
        "계획: `plan-20260506-090100-work-def67890`",
        "요청: `request-20260506-090000-work-abc12345`",
        "대상 repo: `samantha-codex`",
        "작업 유형: 구현/수정 - merge 필요",
        "완료 작업: 1/1",
        "Worker 결과:",
        "- Reviewer [project=samantha goal=goal-parallelism]: Telegram UX 정리: 보고 완료 (계획/보고); checked quality and regressions; reduced bad change approval risk",
        "  보고: Telegram 보고 메시지를 짧게 정리했습니다.",
        "산출/변경:",
        "- `src > lib > operator-reports.ts`",
        "남은 리스크:",
        "- 없음",
        "다음 액션:",
        "- 텔레그램: `/now`",
        "로컬 merge 후보:",
        "`bun run samantha merge:check --run-log=/runs/run-1.json --repo-root=/repo`",
      ].join("\n"),
    );

    expect(report).toContain("계획 결과");
    expect(report).toContain("계획 결과: 구현 통과");
    expect(report).toContain("대상 repo: `samantha-codex`");
    expect(report).toContain("작업 유형: 구현/수정 - merge 필요");
    expect(report).toContain("Reviewer [project=samantha goal=goal-parallelism]");
    expect(report).toContain("reduced bad change approval risk");
    expect(report).toContain("Telegram 보고 메시지를 짧게 정리했습니다.");
    expect(report).toContain("`src > lib > operator-reports.ts`");
    expect(report).toContain("남은 리스크:");
    expect(report).toContain("텔레그램: `/now`");
    expect(report).not.toContain("plan-20260506-090100-work-def67890");
    expect(report).not.toContain("request-20260506-090000-work-abc12345");
    expect(report).not.toContain("merge:check");
  });

  test("keeps compact plan alternatives advisory and separate from go materialization", () => {
    const report = compactTelegramReport(
      [
        "# plan",
        "",
        "요청: `request-20260508-work-abc12345`",
        "계획: `plan-20260508-work-def67890`",
        "요약: Plan alternatives",
        "선택/대안 (advisory, /go 제외):",
        "- 선택 접근: 한 writer task에서 구현과 검증을 함께 처리합니다.",
        "- 거절한 대안: 대안 task set 병렬 실행 - writer cap 1을 넘길 수 있습니다.",
        "- 트레이드오프:",
        "  - 더 느리지만 deterministic materialization을 유지합니다.",
        "작업 후보:",
        "- `selected-write` Selected write path agent=`codex-worker` mode=`write`",
        "안전장치:",
        "- `/go` 전까지 task/action은 만들지 않습니다.",
        "- 대안/트레이드오프는 advisory이며 `/go` materialization 대상이 아닙니다.",
        "다음 액션:",
        "- 계획 승인 및 worker 실행 큐 등록: `/go`",
      ].join("\n"),
    );

    expect(report).toContain("선택/대안 (advisory, /go 제외):");
    expect(report).toContain("선택 접근: 한 writer task에서 구현과 검증을 함께 처리합니다.");
    expect(report).toContain("거절한 대안: 대안 task set 병렬 실행");
    expect(report).toContain("계획 승인 및 worker 실행 큐 등록: `/go`");
    expect(report).not.toContain("plan-20260508-work-def67890");
    expect(report).not.toContain("request-20260508-work-abc12345");
  });

  test("keeps blocked plan Telegram reports on the deterministic revision action", () => {
    const report = compactTelegramReport(
      [
        "# now",
        "",
        "오케스트레이터 계획이 생성되어 검토를 기다리고 있습니다.",
        "계획: `plan-20260508-work-def67890`",
        "요청: `request-20260508-work-abc12345`",
        "요약: Unsafe plan",
        "",
        "진행 차단:",
        "- task proposal write: verifyCommands must not be empty",
        "",
        "다음 액션:",
        "- 계획 수정: `/revise <피드백>`",
      ].join("\n"),
    );

    expect(report).toContain("진행 차단:");
    expect(report).toContain("계획 수정: `/revise <피드백>`");
    expect(report).not.toContain("/go");
    expect(report).not.toContain("plan-20260508-work-def67890");
  });

  test("normalizes deprecated commands before Telegram display", () => {
    const report = compactTelegramReport(
      [
        "# plan-result",
        "",
        "계획 결과: 복구 필요",
        "오케스트레이터 종합:",
        "Synthesis mentioned /run_latest, /next_action, /next-action, and /status.",
        "Worker 결과:",
        "- Worker final text mentioned /action_current, /doctor, /health, and /failures.",
        "남은 리스크:",
        "- Old guidance: /run_latest then /status",
        "다음 액션:",
        "- 텔레그램: `/action_current`",
      ].join("\n"),
    );

    expect(report).toContain("/now");
    expect(report).toContain("/check");
    expect(report).toContain("/problems");
    for (const command of ["/run_latest", "/next_action", "/next-action", "/action_current", "/status", "/doctor", "/health", "/failures"]) {
      expect(report).not.toContain(command);
    }
  });

  test("delivers compact CEO notifications through existing Telegram outbox sender", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    const statePath = join(root, "state", "telegram-replies.json");
    await mkdir(outbox, { recursive: true });
    await writeFile(
      join(outbox, "remote-20260507-110100-ceo-notify-needs-decision-abc12345.md"),
      [
        "# ceo-notify",
        "",
        "상태: needs_decision",
        "요약: decisions=1 active=0 blocked=0 risks=0",
        "결정 필요: Review plan: Mobile approval",
        "",
        "다음 액션:",
        "- 텔레그램: `/approve`",
        "",
        "긴 검토와 세부 로그는 CLI 또는 dashboard에서 확인하세요.",
      ].join("\n"),
      "utf8",
    );
    const sentBodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return { statusText: "OK", json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;

    const result = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath,
      sendExisting: true,
      minAgeMs: 0,
      now: new Date(Date.now() + 1000),
      fetchImpl,
    });

    expect(result.sent[0]?.file).toContain("ceo-notify");
    const text = (sentBodies[0] as { text: string }).text;
    expect(text).toContain("CEO 알림");
    expect(text).toContain("텔레그램: `/approve`");
    expect(text).toContain("CLI 또는 dashboard");
    expect(text).not.toContain("decision-");
  });

  test("skips already-sent CEO notifications from delivery state", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    const statePath = join(root, "state", "telegram-replies.json");
    const file = "remote-20260507-110100-ceo-notify-needs-decision-abc12345.md";
    await mkdir(outbox, { recursive: true });
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(outbox, file), "# ceo-notify\n\n다음 액션:\n- 텔레그램: `/approve`\n", "utf8");
    await writeFile(
      statePath,
      `${JSON.stringify({ schemaVersion: 1, sentFiles: [file], failures: [], updatedAt: "2026-05-07T11:02:00.000Z" })}\n`,
      "utf8",
    );

    const result = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath,
      minAgeMs: 0,
      now: new Date(Date.now() + 1000),
      fetchImpl: (async () => {
        throw new Error("already-sent CEO notification should not be resent");
      }) as unknown as typeof fetch,
    });

    expect(result.sent).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toContainEqual({ file, reason: "already sent" });
    expect(await readFile(statePath, "utf8")).toContain(file);
  });

  test("does not send id-only Telegram messages after reports that return ids", () => {
    const messages = telegramReplyMessages(
      "remote-propose.md",
      [
        "# proposals:add",
        "",
        "Saved proposal: `proposal-2026-05-04t10-00-00.000z-10`",
        "Status: `pending_review`",
      ].join("\n"),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("proposals add");
    expect(messages[0]).not.toContain("proposal-2026-05-04t10-00-00.000z-10");
  });

  test("records failed sends for retry without marking the file sent", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    const statePath = join(root, "state", "telegram-replies.json");
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

    const result = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath,
      sendExisting: true,
      minAgeMs: 0,
      clientTimeoutMs: 1,
      now: new Date(Date.now() + 1000),
      fetchImpl,
    });

    expect(result.sent).toEqual([]);
    expect(result.failed[0]).toMatchObject({
      file: "remote-new.md",
      attempts: 1,
      nextMessageIndex: 0,
    });
    const state = await readFile(statePath, "utf8");
    expect(state).toContain("remote-new.md");
    expect(state).not.toContain('"sentFiles":["remote-new.md"]');
  });

  test("retries failed sends and clears failure state after success", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    const statePath = join(root, "state", "telegram-replies.json");
    await mkdir(outbox, { recursive: true });
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(outbox, "remote-new.md"), "# new\n", "utf8");
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        sentFiles: [],
        failures: [{ file: "remote-new.md", attempts: 1, lastError: "timeout", nextMessageIndex: 0, updatedAt: "now" }],
        updatedAt: "now",
      }),
      "utf8",
    );

    const result = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath,
      minAgeMs: 0,
      now: new Date(Date.now() + 1000),
      fetchImpl: (async () => ({
        statusText: "OK",
        json: async () => ({ ok: true }),
      })) as unknown as typeof fetch,
    });

    expect(result.sent[0]?.file).toBe("remote-new.md");
    const state = await readFile(statePath, "utf8");
    expect(state).toContain("remote-new.md");
    expect(state).toContain('"failures": []');
  });

  test("resumes split replies after the last confirmed message", async () => {
    const root = await makeRoot();
    const outbox = join(root, "outbox");
    const statePath = join(root, "state", "telegram-replies.json");
    const report = "x".repeat(8000);
    await mkdir(outbox, { recursive: true });
    await writeFile(join(outbox, "remote-long.md"), report, "utf8");
    const expectedMessages = telegramReplyMessages("remote-long.md", report);
    let firstAttemptCalls = 0;

    const firstAttempt = (async () => {
      firstAttemptCalls += 1;
      if (firstAttemptCalls === 2) throw new Error("telegram unavailable");
      return {
        statusText: "OK",
        json: async () => ({ ok: true }),
      };
    }) as unknown as typeof fetch;

    const failedResult = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath,
      sendExisting: true,
      minAgeMs: 0,
      now: new Date(Date.now() + 1000),
      fetchImpl: firstAttempt,
    });

    expect(failedResult.failed[0]).toMatchObject({
      file: "remote-long.md",
      attempts: 1,
      nextMessageIndex: 1,
    });

    const retryBodies: unknown[] = [];
    const retry = (async (_url: string, init?: RequestInit) => {
      retryBodies.push(JSON.parse(String(init?.body)));
      return {
        statusText: "OK",
        json: async () => ({ ok: true }),
      };
    }) as unknown as typeof fetch;

    const retryResult = await sendOutboxReplies({
      token: "token",
      chatId: "12345",
      outboxDir: outbox,
      statePath,
      minAgeMs: 0,
      now: new Date(Date.now() + 1000),
      fetchImpl: retry,
    });

    expect(retryResult.sent[0]?.file).toBe("remote-long.md");
    expect(retryBodies).toHaveLength(expectedMessages.length - 1);
    expect((retryBodies[0] as { text: string }).text).toContain("part 2/");
  });
});
