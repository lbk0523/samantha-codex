import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkItemAncestry } from "../src/lib/ancestry";
import { DEFAULT_SAFETY_POLICY } from "../src/lib/policy";
import {
  ProjectBriefStore,
  loadProjectBriefs,
  validateProjectBriefRecord,
  type ProjectBriefRecord,
} from "../src/lib/project-brief-store";
import type { ProjectProfile } from "../src/lib/project-profile";

let tmpRoots: string[] = [];

const ancestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "samantha",
  goalId: "goal-context-memory",
  workItemId: "work-item-phase-8-m3",
};

const profiles: ProjectProfile[] = [
  {
    schemaVersion: 1,
    id: "samantha",
    repoRoot: "/repo/samantha",
    setupCommands: ["bun install"],
    verifyCommands: ["bun typecheck"],
    forbiddenChanges: ["state/**"],
    remoteScopes: [],
  },
  {
    schemaVersion: 1,
    id: "omht",
    repoRoot: "/repo/omht",
    setupCommands: ["bun install"],
    verifyCommands: ["bun typecheck"],
    forbiddenChanges: [".env"],
    remoteScopes: [],
  },
];

async function makeStore(): Promise<{ path: string; store: ProjectBriefStore }> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-project-briefs-"));
  tmpRoots.push(root);
  const path = join(root, "state", "project-briefs.jsonl");
  return { path, store: new ProjectBriefStore(path, { profiles }) };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

function section(text: string, sourceId = "plan-phase-8-m3"): ProjectBriefRecord["sections"]["productContext"] {
  return [
    {
      text,
      citations: [{ kind: "orchestrator_plan", id: sourceId, ancestry }],
    },
  ];
}

function briefFixture(input: Partial<ProjectBriefRecord> = {}): ProjectBriefRecord {
  const projectId = input.projectId ?? "samantha";
  return {
    schemaVersion: 1,
    id: `brief-${projectId}`,
    kind: "project_brief",
    projectId,
    status: "active",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:01:00.000Z",
    reviewedAt: "2026-05-10T00:02:00.000Z",
    reviewDecisionId: `decision-review-${projectId}`,
    ancestry: projectId === "samantha"
      ? ancestry
      : { mode: "assigned", projectId, goalId: `goal-${projectId}`, workItemId: "work-item-phase-8-m3" },
    sections: {
      productContext: section(`${projectId} product context.`, `plan-${projectId}-product`),
      currentStrategy: section(`${projectId} current strategy.`, `plan-${projectId}-strategy`),
      keyConstraints: section(`${projectId} constraints are context, not authority.`, `decision-${projectId}-constraint`),
      knownRisks: section(`${projectId} known risk.`, `gov-event-${projectId}-risk`),
      openQuestions: section(`${projectId} open question.`, `operator-report-${projectId}-question`),
    },
    ...input,
  };
}

describe("ProjectBriefStore", () => {
  test("loads valid reviewed briefs in deterministic project-id order", async () => {
    const { path } = await makeStore();
    const samantha = briefFixture({ projectId: "samantha" });
    const omht = briefFixture({ projectId: "omht" });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(samantha)}\n${JSON.stringify(omht)}\n`, "utf8");

    const loaded = await loadProjectBriefs(path, { projectIds: profiles.map((profile) => profile.id) });

    expect(loaded.map((brief) => brief.projectId)).toEqual(["omht", "samantha"]);
    expect(loaded.map((brief) => brief.id)).toEqual(["brief-omht", "brief-samantha"]);
  });

  test("requires project ids, known projects, and citations for every substantive section entry", async () => {
    expect(validateProjectBriefRecord(briefFixture({ projectId: "" }), { projectIds: ["samantha"] })).toContain(
      "project brief.projectId is required",
    );
    expect(validateProjectBriefRecord(briefFixture({ projectId: "missing" }), { projectIds: ["samantha"] })).toContain(
      "project brief.projectId is unknown: missing",
    );
    expect(validateProjectBriefRecord(briefFixture({
      sections: {
        ...briefFixture().sections,
        productContext: [{ text: "Uncited product context.", citations: [] }],
      },
    }))).toContain("project brief.sections.productContext[0].citations must include at least one source citation");

    const { path, store } = await makeStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(briefFixture({ projectId: "missing" }))}\n`, "utf8");
    await expect(store.list()).rejects.toThrow("project brief line 1.projectId is unknown: missing");
  });

  test("rejects brief fields that attempt to override project profile or runtime authority", () => {
    expect(validateProjectBriefRecord({
      ...briefFixture(),
      repoRoot: "/different/root",
    })).toContain("project brief.repoRoot must not configure project authority; project briefs are context only");

    expect(validateProjectBriefRecord({
      ...briefFixture(),
      safetyPolicy: { allowedRemoteScopeIds: ["implementation"] },
    })).toContain("project brief.safetyPolicy must not configure project authority; project briefs are context only");

    expect(validateProjectBriefRecord({
      ...briefFixture(),
      sections: {
        ...briefFixture().sections,
        keyConstraints: [
          {
            text: "Briefs may describe constraints but cannot set dispatch prerequisites.",
            citations: [{ kind: "decision", id: "decision-constraint" }],
            dispatchPrerequisites: [],
          },
        ],
      },
    })).toContain(
      "project brief.sections.keyConstraints[0].dispatchPrerequisites must not configure project authority; project briefs are context only",
    );
  });

  test("returns explicit no-project-memory results for absent pending-only or archived briefs", async () => {
    const { path, store } = await makeStore();

    await expect(store.readProjectBrief("missing")).rejects.toThrow("project brief projectId is unknown: missing");
    expect(await store.readProjectBrief("samantha")).toEqual({
      status: "no_project_memory",
      projectId: "samantha",
      reason: "absent",
    });

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(briefFixture({
      id: "brief-samantha-pending",
      status: "pending_review",
      reviewedAt: undefined,
      reviewDecisionId: undefined,
    }))}\n`, "utf8");

    expect(await store.readProjectBrief("samantha")).toEqual({
      status: "no_project_memory",
      projectId: "samantha",
      reason: "no_active_project_brief",
    });

    await writeFile(path, `${JSON.stringify(briefFixture({
      id: "brief-samantha-archived",
      status: "archived",
    }))}\n`, "utf8");

    expect(await store.readProjectBrief("samantha")).toEqual({
      status: "no_project_memory",
      projectId: "samantha",
      reason: "no_active_project_brief",
    });
  });

  test("appends new writes only through pending review without overwriting active memory", async () => {
    const { path, store } = await makeStore();
    const pending = briefFixture({
      id: "brief-samantha-pending",
      status: "pending_review",
      reviewedAt: undefined,
      reviewDecisionId: undefined,
    });

    await expect(store.appendPendingReview(pending)).resolves.toMatchObject({
      id: "brief-samantha-pending",
      status: "pending_review",
    });
    await expect(store.appendPendingReview(pending)).rejects.toThrow("project brief already exists: brief-samantha-pending");
    await expect(store.appendPendingReview(briefFixture({ id: "brief-active-write" }))).rejects.toThrow(
      "project brief writes must enter pending_review, not active",
    );

    const raw = await readFile(path, "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(1);
    expect(await store.readProjectBrief("samantha")).toEqual({
      status: "no_project_memory",
      projectId: "samantha",
      reason: "no_active_project_brief",
    });
  });

  test("active briefs must show review evidence and do not expand writer authority", () => {
    expect(validateProjectBriefRecord(briefFixture({ reviewedAt: undefined }))).toContain(
      "project brief.reviewedAt is required for active briefs",
    );
    expect(validateProjectBriefRecord(briefFixture({ reviewDecisionId: undefined }))).toContain(
      "project brief.reviewDecisionId is required for active briefs",
    );
    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
  });
});
