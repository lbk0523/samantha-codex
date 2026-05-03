import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProposalRecord } from "../src/lib/proposal-store";
import {
  buildTaskDraftId,
  checkTaskDraft,
  parseTaskDraftUpdatePatch,
  TaskDraftStore,
  taskDraftFromProposal,
  taskSpecFromDraft,
  type TaskDraftRecord,
} from "../src/lib/task-draft-store";

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

  test("checks whether drafts can be promoted to tasks", () => {
    expect(checkTaskDraft(draft, { knownAgentIds: ["codex-worker"] })).toMatchObject({
      ok: false,
      violations: ["targetFiles must not be empty", "verifyCommands must not be empty"],
    });

    const ready = {
      ...draft,
      targetFiles: ["src/lib/task-draft-store.ts"],
      verifyCommands: ["bun test tests/task-draft-store.test.ts"],
    };
    expect(checkTaskDraft(ready, { knownAgentIds: ["codex-worker"] })).toEqual({
      ok: true,
      draftId: draft.id,
      violations: [],
    });
    expect(checkTaskDraft({ ...ready, targetAgent: "missing-agent" }, { knownAgentIds: ["codex-worker"] }).violations).toContain(
      "targetAgent is unknown: missing-agent",
    );
  });

  test("converts ready drafts into pending task specs", () => {
    const task = taskSpecFromDraft({
      ...draft,
      targetFiles: ["src/lib/task-draft-store.ts"],
      verifyCommands: ["bun test tests/task-draft-store.test.ts"],
    });

    expect(task).toMatchObject({
      id: "task-2026-05-04t10-00-00.000z-10",
      status: "pending",
      targetAgent: "codex-worker",
      targetFiles: ["src/lib/task-draft-store.ts"],
      verifyCommands: ["bun test tests/task-draft-store.test.ts"],
    });
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

  test("updates editable draft fields and marks drafts approved", async () => {
    const root = await makeRoot();
    const store = new TaskDraftStore(join(root, "state", "task-drafts.jsonl"));

    await store.append(draft);
    const updated = await store.update(
      draft.id,
      {
        targetFiles: ["src/lib/task-draft-store.ts"],
        verifyCommands: ["bun test tests/task-draft-store.test.ts"],
      },
      "2026-05-04T10:03:00.000Z",
    );
    const approved = await store.markApproved(draft.id, "2026-05-04T10:04:00.000Z");

    expect(updated.targetFiles).toEqual(["src/lib/task-draft-store.ts"]);
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBe("2026-05-04T10:04:00.000Z");
    await expect(store.update(draft.id, { title: "Nope" }, "2026-05-04T10:05:00.000Z")).rejects.toThrow(
      "task draft is not editable",
    );
  });

  test("parses only allowed draft update fields", () => {
    const patch = parseTaskDraftUpdatePatch({
      title: "Updated title",
      targetFiles: ["src/lib/task-draft-store.ts"],
      status: "approved",
    });

    expect(patch).toEqual({
      title: "Updated title",
      targetAgent: undefined,
      targetFiles: ["src/lib/task-draft-store.ts"],
      forbiddenChanges: undefined,
      verifyCommands: undefined,
      instructions: undefined,
    });
    expect(() => parseTaskDraftUpdatePatch({ targetFiles: "src/lib/task-draft-store.ts" })).toThrow(
      "targetFiles must be a string array",
    );
  });
});
