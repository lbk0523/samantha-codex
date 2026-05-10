import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GovernanceEventStore,
  createGovernanceEvent,
  type GovernanceEventRecord,
} from "../src/lib/governance-event-store";

let tmpRoots: string[] = [];

async function makeStore(): Promise<{ path: string; store: GovernanceEventStore }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-governance-events-"));
  tmpRoots.push(root);
  const path = join(root, "state", "governance-events.jsonl");
  return { path, store: new GovernanceEventStore(path) };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

function eventFixture(input: {
  timestamp: string;
  subjectId: string;
  kind?: GovernanceEventRecord["kind"];
  riskClass?: GovernanceEventRecord["riskClass"];
  summary?: string;
  dedupeKey?: string;
}): GovernanceEventRecord {
  return createGovernanceEvent({
    timestamp: input.timestamp,
    actor: "system",
    source: { kind: "run_lifecycle", id: "run-lifecycle-1" },
    subject: { type: "run", id: input.subjectId },
    kind: input.kind ?? "transition_completed",
    riskClass: input.riskClass ?? "low",
    summary: input.summary ?? "Run completed after verification.",
    related: {
      decisionIds: ["decision-1", "decision-1"],
      actionIds: ["action-1"],
      runIds: [input.subjectId],
    },
    dedupeKey: input.dedupeKey,
  });
}

describe("GovernanceEventStore", () => {
  test("appends, lists, loads, and filters events without rewriting prior lines", async () => {
    const { path, store } = await makeStore();
    const first = eventFixture({
      timestamp: "2026-05-09T01:00:00.000Z",
      subjectId: "run-1",
      summary: "Run started.",
      kind: "transition_completed",
    });
    const second = eventFixture({
      timestamp: "2026-05-09T01:01:00.000Z",
      subjectId: "run-2",
      summary: "Run failed verification.",
      kind: "transition_failed",
      riskClass: "medium",
    });

    await store.append(first);
    const firstLine = (await readFile(path, "utf8")).trimEnd();
    await store.append(second);

    const rawLines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(rawLines[0]).toBe(firstLine);
    expect(rawLines).toHaveLength(2);
    expect((await store.list()).map((event) => event.id)).toEqual([first.id, second.id]);
    expect(await store.load(first.id)).toEqual(first);
    expect(await store.list({ subject: { type: "run", id: "run-2" } })).toEqual([second]);
    expect(await store.list({ kind: "transition_failed" })).toEqual([second]);
    expect(await store.list({ riskClass: "medium" })).toEqual([second]);
    expect(await store.list({ source: { kind: "run_lifecycle", id: "run-lifecycle-1" } })).toEqual([first, second]);
    expect(await store.list({ decisionId: "decision-1" })).toEqual([first, second]);
    expect(await store.list({ actionId: "action-1" })).toEqual([first, second]);
    expect(await store.list({ runId: "run-2" })).toEqual([second]);
    await expect(store.load("gov-event-missing")).rejects.toThrow("governance event not found: gov-event-missing");
  });

  test("returns an existing event for repeated deterministic no-op appends", async () => {
    const { path, store } = await makeStore();
    const first = eventFixture({
      timestamp: "2026-05-09T01:00:00.000Z",
      subjectId: "run-1",
      summary: "No active work to dispatch.",
      kind: "audit_gap_recorded",
      riskClass: "informational",
      dedupeKey: "safe-noop:dispatch:none",
    });
    const regenerated = {
      ...first,
      summary: "Repeated no active work check.",
    };

    await store.append(first);
    const rawBefore = await readFile(path, "utf8");
    await expect(store.append(regenerated)).resolves.toEqual(first);

    expect(await readFile(path, "utf8")).toBe(rawBefore);
    expect(await store.list()).toEqual([first]);
  });

  test("accepts learning candidate records as governed memory event sources", async () => {
    const { store } = await makeStore();
    const event = createGovernanceEvent({
      timestamp: "2026-05-10T01:10:00.000Z",
      actor: "deterministic_operator",
      source: { kind: "learning_candidate", id: "learning-candidate-20260510-010000-recurring-preference" },
      subject: { type: "memory", id: "learning-candidate-20260510-010000-recurring-preference" },
      kind: "transition_requested",
      riskClass: "low",
      summary: "Learning candidate accepted for later deterministic memory write gate.",
    });

    await store.append(event);

    expect(await store.list({ source: event.source })).toEqual([event]);
    expect(await store.list({ subject: event.subject })).toEqual([event]);
  });

  test("reports malformed JSON with line context", async () => {
    const { path, store } = await makeStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{bad json}\n", "utf8");

    await expect(store.list()).rejects.toThrow("malformed governance event at line 1: invalid JSON");
  });

  test("reports unknown taxonomy values with line context", async () => {
    const { path, store } = await makeStore();
    const event = eventFixture({
      timestamp: "2026-05-09T01:00:00.000Z",
      subjectId: "run-1",
    }) as unknown as Record<string, unknown>;
    event.kind = "event_store_append";

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(event)}\n`, "utf8");

    await expect(store.list()).rejects.toThrow(
      "malformed governance event at line 1: unknown governance event kind: event_store_append",
    );
  });

  test("reports duplicate historical event ids as malformed state", async () => {
    const { path, store } = await makeStore();
    const event = eventFixture({
      timestamp: "2026-05-09T01:00:00.000Z",
      subjectId: "run-1",
    });

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`, "utf8");

    await expect(store.list()).rejects.toThrow(
      `malformed governance event at line 2: duplicate governance event id: ${event.id}`,
    );
  });
});
