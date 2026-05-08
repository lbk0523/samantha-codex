import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { DEFAULT_SAFETY_POLICY, validateAgentProfile, validateDispatch } from "../src/lib/policy";

const worker: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: {
    requiredBundles: [],
    blockedSkills: [
      "using-git-worktrees",
      "dispatching-parallel-agents",
      "subagent-driven-development",
    ],
  },
};

const validTask: TaskSpec = {
  id: "task-1",
  title: "change a focused file",
  targetAgent: "codex-worker",
  targetFiles: ["src/lib/policy.ts"],
  forbiddenChanges: ["state/**", "worktrees/**"],
  verifyCommands: ["bun test tests/policy.test.ts"],
  instructions: "Keep the policy test fixture passing.",
  expectedCommitSubject: "test: update policy fixture",
  status: "pending",
};

const reviewer: AgentProfile = {
  ...worker,
  id: "codex-reviewer",
  role: "reviewer",
  writerClass: "non-writer",
  worktreePolicy: "none",
  mergePolicy: "none",
};

describe("validateDispatch", () => {
  test("keeps the default writer cap at one", () => {
    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
  });

  test("accepts bundled agent profile contracts", async () => {
    const dir = join(import.meta.dir, "..", "references", "agent-profiles");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    const profiles = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(join(dir, file), "utf8")) as AgentProfile),
    );

    expect(profiles.map((profile) => profile.id)).toEqual([
      "codex-content",
      "codex-evaluator",
      "codex-operations",
      "codex-orchestrator",
      "codex-researcher",
      "codex-reviewer",
      "codex-spec",
      "codex-worker",
    ]);
    expect(profiles.flatMap((profile) => validateAgentProfile(profile))).toEqual([]);
  });

  test("blocks profiles with unknown roles", () => {
    const result = validateAgentProfile({ ...reviewer, id: "codex-unknown", role: "unknown" } as unknown as AgentProfile);

    expect(result).toContain("agent profile role is unknown: unknown");
  });

  test("keeps codex-worker as the only writer profile", () => {
    const result = validateAgentProfile({ ...worker, id: "codex-reviewer" });

    expect(result).toContain("only codex-worker may be a writer profile");
  });

  test("allows a writer task with target files, forbidden changes, and worktree isolation", () => {
    const result = validateDispatch(validTask, worker);

    expect(result.mayDispatch).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("blocks writer tasks without target files", () => {
    const result = validateDispatch({ ...validTask, targetFiles: [] }, worker);

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain("writer tasks must declare targetFiles");
  });

  test("allows report-only writer tasks without target files", () => {
    const result = validateDispatch(
      { ...validTask, resultMode: "report", targetFiles: [], forbiddenChanges: ["**/*"] },
      worker,
    );

    expect(result.mayDispatch).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("allows non-writer report-only tasks without target files", () => {
    const result = validateDispatch(
      {
        ...validTask,
        targetAgent: "codex-reviewer",
        resultMode: "report",
        targetFiles: [],
        forbiddenChanges: ["**/*"],
      },
      reviewer,
    );

    expect(result.mayDispatch).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("blocks non-writer tasks that can write", () => {
    const result = validateDispatch(
      {
        ...validTask,
        targetAgent: "codex-reviewer",
        resultMode: "write",
        targetFiles: ["src/lib/policy.ts"],
      },
      reviewer,
    );

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain("non-writer tasks must use report resultMode");
    expect(result.violations).toContain("non-writer report tasks must not declare targetFiles");
  });

  test("blocks non-writer profiles that claim worktree or merge ownership", () => {
    const result = validateDispatch(
      {
        ...validTask,
        targetAgent: "codex-reviewer",
        resultMode: "report",
        targetFiles: [],
        forbiddenChanges: ["**/*"],
      },
      { ...reviewer, worktreePolicy: "per-task", mergePolicy: "samantha-controlled" },
    );

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain("non-writer agents must not allocate worktrees");
    expect(result.violations).toContain("non-writer agents must not use merge policy");
  });

  test("blocks writer profiles that do not reserve worktrees for Samantha", () => {
    const result = validateDispatch(validTask, { ...worker, worktreePolicy: "none" });

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain("writer agents must use per-task worktrees");
  });

  test("blocks profiles that can use orchestration-conflicting skills", () => {
    const result = validateDispatch(validTask, {
      ...worker,
      skillPolicy: { requiredBundles: [], blockedSkills: [] },
    });

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain("agent profile must block skill: using-git-worktrees");
  });
});
