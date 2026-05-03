import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProposalId, ProposalStore, type ProposalRecord } from "../src/lib/proposal-store";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-proposals-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

const proposal: ProposalRecord = {
  schemaVersion: 1,
  id: "proposal-2026-05-03t10-00-00.000z",
  text: "Review the dashboard status output.",
  source: "remote",
  senderId: "12345",
  status: "pending_review",
  createdAt: "2026-05-03T10:00:00.000Z",
};

describe("ProposalStore", () => {
  test("appends, lists, and finds proposals", async () => {
    const root = await makeRoot();
    const store = new ProposalStore(join(root, "state", "proposals.jsonl"));

    await store.append(proposal);

    expect(await store.list()).toEqual([proposal]);
    expect(await store.find(proposal.id)).toEqual(proposal);
  });

  test("rejects duplicate proposal ids", async () => {
    const root = await makeRoot();
    const store = new ProposalStore(join(root, "state", "proposals.jsonl"));

    await store.append(proposal);

    await expect(store.append(proposal)).rejects.toThrow("proposal already exists");
  });

  test("builds stable proposal ids from timestamps", () => {
    expect(buildProposalId("2026-05-03T10:00:00.000Z")).toBe("proposal-2026-05-03t10-00-00.000z");
    expect(buildProposalId("2026-05-03T10:00:00.000Z", 123)).toBe("proposal-2026-05-03t10-00-00.000z-123");
  });
});
