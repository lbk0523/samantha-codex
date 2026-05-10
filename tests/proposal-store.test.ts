import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildLearningCandidateId,
  buildProposalId,
  LearningCandidateStore,
  ProposalStore,
  type LearningCandidateRecord,
  type ProposalRecord,
} from "../src/lib/proposal-store";

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

const candidate: LearningCandidateRecord = {
  schemaVersion: 1,
  id: "learning-candidate-20260510-010000-recurring-preference",
  kind: "recurring_preference",
  proposedMemoryKind: "preference",
  claimKind: "llm_summary",
  scope: { type: "project", projectId: "samantha" },
  summary: "BK prefers minimal deterministic gates before memory writes.",
  proposedContent: "Prefer candidate capture first, then deterministic write-gate promotion.",
  evidence: [
    {
      kind: "operator_report",
      id: "operator-report-memory-review",
      ancestry: {
        mode: "assigned",
        projectId: "samantha",
        goalId: "goal-memory",
        workItemId: "work-item-m5",
      },
    },
  ],
  confidence: 0.82,
  attribution: { kind: "llm", agentId: "codex-spec", model: "gpt-5" },
  ancestry: {
    mode: "assigned",
    projectId: "samantha",
    goalId: "goal-memory",
    workItemId: "work-item-m5",
  },
  status: "pending_review",
  createdAt: "2026-05-10T01:00:00.000Z",
  updatedAt: "2026-05-10T01:00:00.000Z",
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

describe("LearningCandidateStore", () => {
  test("appends, lists, finds, and filters memory learning candidates", async () => {
    const root = await makeRoot();
    const store = new LearningCandidateStore(join(root, "state", "learning-candidates.jsonl"));
    const crossProject: LearningCandidateRecord = {
      ...candidate,
      id: "learning-candidate-20260510-010100-known-risk",
      kind: "known_risk",
      proposedMemoryKind: "known_risk",
      scope: { type: "cross_project", projectIds: ["omht", "samantha"] },
      summary: "Automation host state must not be mutated from a client machine.",
      proposedContent: "Treat host-owned runtime state as out of scope for client-side candidate capture.",
      attribution: { kind: "operator", id: "deterministic-review" },
      claimKind: "operator_note",
      createdAt: "2026-05-10T01:01:00.000Z",
      updatedAt: "2026-05-10T01:01:00.000Z",
    };

    await store.append(candidate);
    await store.append(crossProject);

    expect(await store.list()).toEqual([candidate, crossProject]);
    expect(await store.find(candidate.id)).toEqual(candidate);
    expect(await store.list({ status: "pending_review" })).toEqual([candidate, crossProject]);
    expect(await store.list({ kind: "known_risk" })).toEqual([crossProject]);
    expect((await store.list({ projectId: "omht" })).map((item) => item.id)).toEqual([crossProject.id]);
  });

  test("updates candidate status without promoting memory directly", async () => {
    const root = await makeRoot();
    const store = new LearningCandidateStore(join(root, "state", "learning-candidates.jsonl"));

    await store.append(candidate);
    const accepted = await store.updateStatus(candidate.id, "accepted", {
      reviewedAt: "2026-05-10T01:05:00.000Z",
      reviewedBy: "deterministic_operator",
      reviewNote: "Candidate is useful, but still needs the memory write gate.",
    });

    expect(accepted).toMatchObject({
      id: candidate.id,
      status: "accepted",
      promotionGate: "deterministic_memory_write_gate_required",
      reviewedBy: "deterministic_operator",
      reviewedAt: "2026-05-10T01:05:00.000Z",
    });
    expect(accepted).not.toHaveProperty("memory");
    expect(accepted).not.toHaveProperty("task");

    const archived = await store.updateStatus(candidate.id, "archived", {
      reviewedAt: "2026-05-10T01:06:00.000Z",
      reviewedBy: "bk",
      reviewNote: "Superseded by a narrower candidate.",
      supersededByCandidateId: "learning-candidate-20260510-010700-narrower",
    });
    expect(archived).toMatchObject({
      status: "archived",
      reviewNote: "Superseded by a narrower candidate.",
      supersededByCandidateId: "learning-candidate-20260510-010700-narrower",
    });
  });

  test("rejects duplicates, missing evidence, and LLM candidates not attributed as summaries", async () => {
    const root = await makeRoot();
    const store = new LearningCandidateStore(join(root, "state", "learning-candidates.jsonl"));

    await store.append(candidate);
    await expect(store.append(candidate)).rejects.toThrow("learning candidate already exists");
    await expect(store.append({ ...candidate, id: "learning-candidate-no-evidence", evidence: [] })).rejects.toThrow(
      "candidate.evidence must include at least one source citation",
    );
    await expect(
      store.append({
        ...candidate,
        id: "learning-candidate-llm-observed-fact",
        claimKind: "observed_fact",
      }),
    ).rejects.toThrow("LLM learning candidates must use claimKind llm_summary");
  });

  test("blocks direct mutation payloads for memory, SOPs, skills, profiles, policies, connectors, secrets, tasks, actions, and runs", async () => {
    const root = await makeRoot();
    const store = new LearningCandidateStore(join(root, "state", "learning-candidates.jsonl"));

    await expect(
      store.append({
        ...candidate,
        id: "learning-candidate-direct-memory-write",
        memoryWrite: { id: "memory-direct-write" },
      } as unknown as LearningCandidateRecord),
    ).rejects.toThrow("candidate.memoryWrite is not allowed on learning candidates");
    await expect(
      store.append({
        ...candidate,
        id: "learning-candidate-direct-task-write",
        proposedMutation: { taskPatch: { id: "task-1" } },
      } as unknown as LearningCandidateRecord),
    ).rejects.toThrow("candidate.proposedMutation.taskPatch is not allowed on learning candidates");
    await expect(
      store.append({
        ...candidate,
        id: "learning-candidate-secret-grant",
        reviewPayload: { connectorGrant: "gmail", secretPatch: ".env" },
      } as unknown as LearningCandidateRecord),
    ).rejects.toThrow("candidate.reviewPayload.connectorGrant is not allowed on learning candidates");
  });

  test("enforces deterministic status transitions and review attribution", async () => {
    const root = await makeRoot();
    const store = new LearningCandidateStore(join(root, "state", "learning-candidates.jsonl"));

    await store.append(candidate);
    await expect(
      store.updateStatus(candidate.id, "rejected", {
        reviewedAt: "2026-05-10T01:05:00.000Z",
        reviewedBy: "bk",
      }),
    ).rejects.toThrow("learning candidate rejected requires a review note");

    const rejected = await store.updateStatus(candidate.id, "rejected", {
      reviewedAt: "2026-05-10T01:05:00.000Z",
      reviewedBy: "bk",
      reviewNote: "Not enough repeated evidence yet.",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      reviewedBy: "bk",
      reviewNote: "Not enough repeated evidence yet.",
    });
    await expect(
      store.updateStatus(candidate.id, "accepted", {
        reviewedAt: "2026-05-10T01:06:00.000Z",
        reviewedBy: "bk",
        reviewNote: "Reopen.",
      }),
    ).rejects.toThrow("learning candidate must be pending_review before accepted");
  });

  test("builds stable learning candidate ids from timestamps", () => {
    expect(buildLearningCandidateId({
      createdAt: "2026-05-10T01:00:00.000Z",
      kind: "recurring_preference",
      summary: "Use deterministic gates.",
    })).toBe("learning-candidate-20260510-010000-recurring_preference-a845c2c4");
    expect(buildLearningCandidateId({
      createdAt: "2026-05-10T01:00:00.000Z",
      kind: "known_risk",
      summary: "Avoid direct memory writes.",
      disambiguator: 2,
    })).toBe("learning-candidate-20260510-010000-known_risk-631960a9");
  });
});
