import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCeoTurnRecord, CeoTurnStore, type CeoTurnRecord } from "../src/lib/ceo-turn-store";

let tmpRoots: string[] = [];

async function makeStore(): Promise<{ path: string; store: CeoTurnStore }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-ceo-turn-"));
  tmpRoots.push(root);
  const path = join(root, "state", "ceo-turns.jsonl");
  return { path, store: new CeoTurnStore(path) };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

const turn: CeoTurnRecord = createCeoTurnRecord({
  id: "ceo-turn-fixture-1",
  source: "remote",
  actor: "bk",
  text: "Summarize current Samantha risks without starting write work.",
  detectedIntent: {
    kind: "report_request",
    summary: "Report-only Samantha risk review.",
  },
  responseBoundary: {
    kind: "next_safe_action",
    summary: "Return a compact CEO report without command choreography.",
    responseId: "ceo-report-20260512-030000-needs-decision-abc12345",
    respondedAt: "2026-05-12T03:01:00.000Z",
  },
  linkedStateIds: {
    requestIds: ["request-risk-review"],
    planIds: ["plan-risk-review"],
    decisionIds: ["decision-risk-review"],
    reportIds: ["ceo-report-20260512-030000-needs-decision-abc12345"],
  },
  memoryCandidateRefs: ["learning-candidate-risk-review"],
  createdAt: "2026-05-12T03:00:00.000Z",
  updatedAt: "2026-05-12T03:01:00.000Z",
});

describe("CeoTurnStore", () => {
  test("appends, lists, finds, and reads CEO turn records", async () => {
    const { store } = await makeStore();

    await expect(store.append(turn)).resolves.toEqual(turn);

    expect(await store.list()).toEqual([turn]);
    expect(await store.find(turn.id)).toEqual(turn);
    expect(await store.read(turn.id)).toEqual(turn);
    await expect(store.read("missing-turn")).rejects.toThrow("CEO turn not found: missing-turn");
  });

  test("creates deterministic records with required empty linked state ids", async () => {
    const { store } = await makeStore();

    const created = await store.create({
      source: "local",
      actor: "bk",
      text: "What is blocked?",
      detectedIntent: { kind: "status_request" },
      responseBoundary: { kind: "pending_response" },
      createdAt: "2026-05-12T04:00:00.000Z",
    });

    expect(created.id).toContain("ceo-turn-20260512-040000-bk-");
    expect(created).toEqual({
      schemaVersion: 1,
      id: created.id,
      source: "local",
      actor: "bk",
      text: "What is blocked?",
      detectedIntent: { kind: "status_request" },
      responseBoundary: { kind: "pending_response" },
      linkedStateIds: {},
      createdAt: "2026-05-12T04:00:00.000Z",
      updatedAt: "2026-05-12T04:00:00.000Z",
    });
    expect(await store.read(created.id)).toEqual(created);
  });

  test("rejects duplicate CEO turn ids", async () => {
    const { store } = await makeStore();

    await store.append(turn);

    await expect(store.append(turn)).rejects.toThrow(`CEO turn already exists: ${turn.id}`);
    expect(await store.list()).toEqual([turn]);
  });

  test("fails closed for malformed CEO turn records", async () => {
    const { path, store } = await makeStore();
    await mkdir(join(path, ".."), { recursive: true });

    await writeFile(path, "{not json}\n", "utf8");
    await expect(store.list()).rejects.toThrow("malformed CEO turn at line 1: invalid JSON");

    await writeFile(path, `${JSON.stringify({ ...turn, text: "" })}\n`, "utf8");
    await expect(store.list()).rejects.toThrow("malformed CEO turn at line 1: text is required");

    await writeFile(path, `${JSON.stringify({ ...turn, linkedStateIds: undefined })}\n`, "utf8");
    await expect(store.list()).rejects.toThrow("malformed CEO turn at line 1: linkedStateIds must be an object");
  });

  test("fails closed for duplicate historical records", async () => {
    const { path, store } = await makeStore();
    await mkdir(join(path, ".."), { recursive: true });

    await writeFile(path, `${JSON.stringify(turn)}\n${JSON.stringify(turn)}\n`, "utf8");

    await expect(store.list()).rejects.toThrow(`malformed CEO turn at line 2: duplicate CEO turn id: ${turn.id}`);
  });
});
