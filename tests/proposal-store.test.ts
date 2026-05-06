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

  test("updates proposal review status", async () => {
    const root = await makeRoot();
    const store = new ProposalStore(join(root, "state", "proposals.jsonl"));

    await store.append(proposal);
    const updated = await store.updateStatus(proposal.id, "accepted", {
      reviewedAt: "2026-05-03T10:10:00.000Z",
      reviewNote: "Ready for task drafting.",
    });

    expect(updated).toMatchObject({
      id: proposal.id,
      status: "accepted",
      reviewedAt: "2026-05-03T10:10:00.000Z",
      reviewNote: "Ready for task drafting.",
    });
    expect(await store.find(proposal.id)).toEqual(updated);
  });

  test("fails review status updates for missing proposals", async () => {
    const root = await makeRoot();
    const store = new ProposalStore(join(root, "state", "proposals.jsonl"));

    await expect(
      store.updateStatus("proposal-missing", "rejected", { reviewedAt: "2026-05-03T10:10:00.000Z" }),
    ).rejects.toThrow("proposal not found");
  });

  test("builds stable proposal ids from timestamps", () => {
    expect(buildProposalId("2026-05-03T10:00:00.000Z")).toBe("proposal-20260503-100000-proposal-407d7c53");
    expect(buildProposalId("2026-05-03T10:00:00.000Z", 123)).toBe("proposal-20260503-100000-proposal-c9ad5446");
  });
});
