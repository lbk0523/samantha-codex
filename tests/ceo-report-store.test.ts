import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCeoReportId, CeoReportStore, type CeoReportRecord } from "../src/lib/ceo-report-store";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-ceo-report-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("CeoReportStore", () => {
  test("appends generated report audit records", async () => {
    const root = await makeRoot();
    const store = new CeoReportStore(join(root, "state", "ceo-reports.jsonl"));
    const generatedAt = "2026-05-07T11:01:00.000Z";
    const outboxFile = "remote-20260507-110100-ceo-notify-needs-decision-abc12345.md";
    const record: CeoReportRecord = {
      schemaVersion: 1,
      id: buildCeoReportId({ generatedAt, outboxFile, overall: "needs_decision" }),
      kind: "ceo_notify",
      generatedAt,
      outboxFile,
      outboxPath: join(root, "outbox", outboxFile),
      deliveryStatePath: join(root, "state", "telegram-replies.json"),
      overall: "needs_decision",
      nextActionKind: "resolve_decision",
      decisionCount: 1,
      activeCount: 0,
      blockedCount: 0,
      riskCount: 0,
    };

    await store.append(record);

    expect(await store.list()).toEqual([record]);
  });

  test("returns existing record for duplicate report ids with identical content", async () => {
    const root = await makeRoot();
    const store = new CeoReportStore(join(root, "state", "ceo-reports.jsonl"));
    const record: CeoReportRecord = {
      schemaVersion: 1,
      id: "ceo-report-20260507-110100-needs-decision-abc12345",
      kind: "ceo_notify",
      generatedAt: "2026-05-07T11:01:00.000Z",
      outboxFile: "remote-20260507-110100-ceo-notify-needs-decision-abc12345.md",
      outboxPath: join(root, "outbox", "remote-20260507-110100-ceo-notify-needs-decision-abc12345.md"),
      deliveryStatePath: join(root, "state", "telegram-replies.json"),
      overall: "needs_decision",
      nextActionKind: "resolve_decision",
      decisionCount: 1,
      activeCount: 0,
      blockedCount: 0,
      riskCount: 0,
    };
    await store.append(record);

    await expect(store.append(record)).resolves.toEqual(record);
    expect(await store.list()).toEqual([record]);
  });

  test("keeps the first record when duplicate report ids are regenerated with changed counters", async () => {
    const root = await makeRoot();
    const store = new CeoReportStore(join(root, "state", "ceo-reports.jsonl"));
    const record: CeoReportRecord = {
      schemaVersion: 1,
      id: "ceo-report-20260507-110100-needs-decision-abc12345",
      kind: "ceo_notify",
      generatedAt: "2026-05-07T11:01:00.000Z",
      outboxFile: "remote-20260507-110100-ceo-notify-needs-decision-abc12345.md",
      outboxPath: join(root, "outbox", "remote-20260507-110100-ceo-notify-needs-decision-abc12345.md"),
      deliveryStatePath: join(root, "state", "telegram-replies.json"),
      overall: "needs_decision",
      nextActionKind: "resolve_decision",
      decisionCount: 1,
      activeCount: 0,
      blockedCount: 0,
      riskCount: 0,
    };
    await store.append(record);

    await expect(store.append({ ...record, decisionCount: 2 })).resolves.toEqual(record);
    expect(await store.find(record.id)).toEqual(record);
    expect(await store.list()).toEqual([record]);
  });
});
