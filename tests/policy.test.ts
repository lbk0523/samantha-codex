import { describe, expect, test } from "bun:test";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { validateDispatch } from "../src/lib/policy";

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

describe("validateDispatch", () => {
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
