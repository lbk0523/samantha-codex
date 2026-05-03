import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProposalRecord } from "../src/lib/proposal-store";
import { buildTaskDraftId, TaskDraftStore, taskDraftFromProposal, type TaskDraftRecord } from "../src/lib/task-draft-store";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-task-drafts-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

const proposal: ProposalRecord = {
  schemaVersion: 1,
  id: "proposal-2026-05-04t10-00-00.000z-10",
  text: "Improve proposal copy/paste UX.\nKeep Telegram as the main surface.",
  source: "remote",
  senderId: "12345",
  status: "accepted",
  createdAt: "2026-05-04T10:00:00.000Z",
  reviewedAt: "2026-05-04T10:01:00.000Z",
};

const draft: TaskDraftRecord = taskDraftFromProposal(proposal, "2026-05-04T10:02:00.000Z");

describe("TaskDraftStore", () => {
  test("builds deterministic draft ids from proposal ids", () => {
    expect(buildTaskDraftId(proposal.id)).toBe("draft-2026-05-04t10-00-00.000z-10");
  });

  test("creates conservative task drafts from accepted proposals", () => {
    expect(draft).toMatchObject({
      id: "draft-2026-05-04t10-00-00.000z-10",
      sourceProposalId: proposal.id,
      status: "drafted",
      title: "Improve proposal copy/paste UX.",
      targetAgent: "codex-worker",
      targetFiles: [],
      verifyCommands: [],
      instructions: proposal.text,
    });
  });

  test("blocks drafts from unaccepted proposals", () => {
    expect(() => taskDraftFromProposal({ ...proposal, status: "pending_review" }, "2026-05-04T10:02:00.000Z")).toThrow(
      "proposal must be accepted",
    );
  });

  test("appends, lists, and finds task drafts", async () => {
    const root = await makeRoot();
    const store = new TaskDraftStore(join(root, "state", "task-drafts.jsonl"));

    await store.append(draft);

    expect(await store.list()).toEqual([draft]);
    expect(await store.find(draft.id)).toEqual(draft);
  });

  test("rejects duplicate drafts for the same proposal", async () => {
    const root = await makeRoot();
    const store = new TaskDraftStore(join(root, "state", "task-drafts.jsonl"));

    await store.append(draft);

    await expect(store.append({ ...draft, id: "draft-other" })).rejects.toThrow(
      "task draft already exists for proposal",
    );
  });
});
