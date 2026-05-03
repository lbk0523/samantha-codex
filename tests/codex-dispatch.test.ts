import { describe, expect, test } from "bun:test";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { buildCodexWorkerPrompt, prepareCodexDispatch } from "../src/lib/codex-dispatch";

const agent: AgentProfile = {
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

const task: TaskSpec = {
  id: "task-dispatch-fixture",
  title: "Prepare a Codex dispatch",
  targetAgent: "codex-worker",
  targetFiles: ["src/lib/codex-dispatch.ts"],
  forbiddenChanges: ["state/**", "worktrees/**"],
  verifyCommands: ["bun test tests/codex-dispatch.test.ts"],
  instructions: "Keep dispatch prompt construction deterministic.",
  expectedCommitSubject: "feat: prepare codex dispatch",
  status: "pending",
};

describe("codex dispatch preparation", () => {
  test("builds a prompt that keeps orchestration in Samantha", () => {
    const prompt = buildCodexWorkerPrompt(task, agent);

    expect(prompt).toContain("Samantha owns orchestration");
    expect(prompt).toContain("Do not create worktrees");
    expect(prompt).toContain("src/lib/codex-dispatch.ts");
    expect(prompt).toContain("HARNESS_RESULT");
  });

  test("builds a strict read-only prompt for non-writer agents", () => {
    const prompt = buildCodexWorkerPrompt(
      {
        ...task,
        targetAgent: "codex-reviewer",
        targetFiles: [],
        forbiddenChanges: ["**/*"],
      },
      {
        ...agent,
        id: "codex-reviewer",
        role: "reviewer",
        writerClass: "non-writer",
        worktreePolicy: "none",
        mergePolicy: "none",
      },
    );

    expect(prompt).toContain("This is a non-writer task");
    expect(prompt).toContain("- (none; read-only task)");
    expect(prompt).toContain("- **/*");
  });

  test("builds a non-interactive codex exec command rooted at the worktree", () => {
    const prepared = prepareCodexDispatch(task, agent, "/tmp/samantha-worktree");

    expect(prepared.command.slice(0, 7)).toEqual([
      "codex",
      "exec",
      "--cd",
      "/tmp/samantha-worktree",
      "--sandbox",
      "workspace-write",
      "--json",
    ]);
    expect(prepared.command).toContain("--model");
    expect(prepared.command).toContain("gpt-5.5");
  });
});
