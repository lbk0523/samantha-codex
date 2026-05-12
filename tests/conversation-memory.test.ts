import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCeoTurnRecord } from "../src/lib/ceo-turn-store";
import {
  CEO_CONVERSATION_MEMORY_ID,
  buildConversationMemoryCandidates,
  readCeoConversationMemory,
} from "../src/lib/conversation-memory";

let tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-conversation-memory-"));
  tmpRoots.push(root);
  return root;
}

describe("CEO conversation memory", () => {
  test("reads CEO_Conversation_MEMORY.md as a bounded redacted context summary", async () => {
    const root = await makeRoot();
    const path = join(root, "CEO_Conversation_MEMORY.md");
    await writeFile(
      path,
      [
        "# CEO Conversation Memory",
        "",
        "Natural CEO conversation is broad, execution is gated.",
        "API_KEY=should-not-leak",
      ].join("\n"),
      "utf8",
    );

    const memory = await readCeoConversationMemory(path, { summaryLimit: 120 });

    expect(memory).toMatchObject({
      schemaVersion: 1,
      id: CEO_CONVERSATION_MEMORY_ID,
      status: "ok",
    });
    expect(memory.summary).toContain("Natural CEO conversation");
    expect(memory.summary).toContain("API_KEY=[REDACTED]");
    expect(memory.summary).not.toContain("should-not-leak");
  });

  test("creates pending review candidates for decisions, product direction, rejected paths, and progress", () => {
    const turn = createCeoTurnRecord({
      source: "remote",
      actor: "bk",
      text: "결정: Samantha v2 product direction은 natural CEO conversation이다. rejected path: command bot은 버린다. Stage 5 구현 완료.",
      detectedIntent: { kind: "planning_report" },
      responseBoundary: { kind: "approval_boundary", respondedAt: "2026-05-12T11:00:00.000Z" },
      linkedStateIds: {
        requestIds: ["request-stage5"],
        planIds: ["plan-stage5"],
      },
      createdAt: "2026-05-12T11:00:00.000Z",
    });

    const candidates = buildConversationMemoryCandidates({
      turn,
      projectId: "samantha",
      conversationMemory: {
        schemaVersion: 1,
        id: CEO_CONVERSATION_MEMORY_ID,
        status: "ok",
        summary: "Conversation memory is context only.",
      },
      responseText: "계획은 만들었습니다.",
    });

    expect(candidates.map((candidate) => candidate.proposedMemoryKind)).toEqual([
      "decision_summary",
      "strategy_context",
      "known_risk",
      "artifact_reference",
    ]);
    expect(candidates.every((candidate) => candidate.status === "pending_review")).toBe(true);
    expect(candidates.every((candidate) => candidate.scope.type === "project" && candidate.scope.projectId === "samantha")).toBe(true);
    expect(candidates.every((candidate) => candidate.evidence.some((evidence) => evidence.kind === "ceo_turn" && evidence.id === turn.id))).toBe(true);
    expect(candidates.every((candidate) => candidate.evidence.some((evidence) => evidence.kind === "conversation_memory" && evidence.id === CEO_CONVERSATION_MEMORY_ID))).toBe(true);
    expect(candidates.some((candidate) => candidate.behaviorImpact === "behavior_change" && candidate.behaviorImpactReviewRequired)).toBe(true);
    expect(candidates.every((candidate) => !("promotionGate" in candidate))).toBe(true);
  });

  test("does not create candidates from secret-like turn text", () => {
    const turn = createCeoTurnRecord({
      source: "remote",
      actor: "bk",
      text: "결정: API_KEY=should-not-be-stored 를 기억해.",
      detectedIntent: { kind: "planning_report" },
      responseBoundary: { kind: "blocker", respondedAt: "2026-05-12T11:05:00.000Z" },
      createdAt: "2026-05-12T11:05:00.000Z",
    });

    expect(buildConversationMemoryCandidates({ turn })).toEqual([]);
  });
});
