import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../src/lib/contracts";
import { materializeOrchestratorPlan } from "../src/lib/orchestrator-materializer";
import type { OrchestratorPlanRecord, OrchestratorTaskProposal } from "../src/lib/orchestrator-store";

const blockedSkills = [
  "using-git-worktrees",
  "dispatching-parallel-agents",
  "subagent-driven-development",
];

const worker: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: { requiredBundles: [], blockedSkills },
};

const reviewer: AgentProfile = {
  ...worker,
  id: "codex-reviewer",
  role: "reviewer",
  writerClass: "non-writer",
  worktreePolicy: "none",
  mergePolicy: "none",
};

const evaluator: AgentProfile = {
  ...reviewer,
  id: "codex-evaluator",
  role: "evaluator",
};

const spec: AgentProfile = {
  ...reviewer,
  id: "codex-spec",
  role: "spec",
};

const project = {
  schemaVersion: 1 as const,
  id: "samantha",
  repoRoot: "/repo/samantha-codex",
  setupCommands: [],
  verifyCommands: ["bun typecheck"],
  forbiddenChanges: ["state/**"],
};

function proposal(patch: Partial<OrchestratorTaskProposal> & Pick<OrchestratorTaskProposal, "id" | "title" | "targetAgent">): OrchestratorTaskProposal {
  return {
    projectId: "samantha",
    repoRoot: "",
    resultMode: "report",
    targetFiles: [],
    forbiddenChanges: ["state/**"],
    setupCommands: [],
    verifyCommands: ["bun typecheck"],
    instructions: "Inspect the current repo state and return a report. Do not edit files.",
    dependencies: [],
    ...patch,
  };
}

function plan(tasks: OrchestratorTaskProposal[], batches: string[][]): OrchestratorPlanRecord {
  return {
    schemaVersion: 1,
    id: "plan-role-aware-canary",
    requestId: "request-role-aware-canary",
    status: "planned",
    createdAt: "2026-05-07T00:00:00.000Z",
    payload: {
      summary: "Role-aware canary",
      assumptions: [],
      questions: [],
      scope: ["specialist report-only checks", "single writer implementation"],
      nonScope: ["multi-writer execution"],
      risks: [],
      tasks,
      batches,
      userMessage: "Use specialist reports without broadening writer concurrency.",
    },
  };
}

describe("materializeOrchestratorPlan role-aware specialist contract", () => {
  test("materializes report-only specialists alongside a single writer", () => {
    const tasks = [
      proposal({ id: "shape-scope", title: "Shape acceptance criteria", targetAgent: "codex-spec" }),
      proposal({ id: "review-risk", title: "Review implementation risk", targetAgent: "codex-reviewer" }),
      proposal({ id: "plan-verify", title: "Plan validation checks", targetAgent: "codex-evaluator" }),
      proposal({
        id: "apply-change",
        title: "Apply focused change",
        targetAgent: "codex-worker",
        resultMode: "write",
        targetFiles: ["src/lib/orchestrator-materializer.ts", "tests/orchestrator-materializer.test.ts"],
        instructions: "Apply the smallest focused change.",
      }),
    ];

    const result = materializeOrchestratorPlan({
      plan: plan(tasks, [["shape-scope", "review-risk", "plan-verify", "apply-change"]]),
      agents: [worker, reviewer, evaluator, spec],
      projects: [project],
      createdAt: "2026-05-07T00:01:00.000Z",
      commandId: "remote-go-role-aware",
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.tasks.map((task) => [task.targetAgent, task.resultMode, task.targetFiles])).toEqual([
      ["codex-spec", "report", []],
      ["codex-reviewer", "report", []],
      ["codex-evaluator", "report", []],
      ["codex-worker", "write", ["src/lib/orchestrator-materializer.ts", "tests/orchestrator-materializer.test.ts"]],
    ]);
    expect(result.actions.map((action) => [action.targetAgent, action.status])).toEqual([
      ["codex-spec", "pending"],
      ["codex-reviewer", "pending"],
      ["codex-evaluator", "pending"],
      ["codex-worker", "pending"],
    ]);
  });

  test("blocks non-writer proposals that request write behavior", () => {
    const result = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "review-edit",
          title: "Review and edit code",
          targetAgent: "codex-reviewer",
          resultMode: "write",
          targetFiles: ["src/lib/policy.ts"],
        }),
      ], [["review-edit"]]),
      agents: [worker, reviewer],
      projects: [project],
      createdAt: "2026-05-07T00:02:00.000Z",
      commandId: "remote-go-non-writer-write",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain("task proposal review-edit: non-writer tasks must use report resultMode");
    expect(result.violations).toContain("task proposal review-edit: non-writer report tasks must not declare targetFiles");
  });

  test("blocks a batch that exceeds writer cap one", () => {
    const result = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "write-a",
          title: "Write A",
          targetAgent: "codex-worker",
          resultMode: "write",
          targetFiles: ["src/a.ts"],
          instructions: "Write A.",
        }),
        proposal({
          id: "write-b",
          title: "Write B",
          targetAgent: "codex-worker",
          resultMode: "write",
          targetFiles: ["src/b.ts"],
          instructions: "Write B.",
        }),
      ], [["write-a", "write-b"]]),
      agents: [worker],
      projects: [project],
      createdAt: "2026-05-07T00:03:00.000Z",
      commandId: "remote-go-two-writers",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain("batches[0] exceeds writer cap 1: write-a, write-b");
  });

  test("materializes recovery tasks from canonical project roots and rejects old worker worktrees", () => {
    const recoveryTask = proposal({
      id: "recover-failure",
      title: "Recover failed workflow",
      targetAgent: "codex-worker",
      resultMode: "write",
      targetFiles: ["src/recovery.ts"],
      instructions: "Recover from the failed plan using the project profile root.",
    });

    const canonical = materializeOrchestratorPlan({
      plan: plan([recoveryTask], [["recover-failure"]]),
      agents: [worker],
      projects: [project],
      createdAt: "2026-05-07T00:04:00.000Z",
      commandId: "remote-go-recovery",
    });

    expect(canonical.ok).toBe(true);
    expect(canonical.tasks[0]).toMatchObject({ repoRoot: "/repo/samantha-codex" });
    expect(canonical.actions[0]).toMatchObject({ repoRoot: "/repo/samantha-codex" });

    const workerWorktree = materializeOrchestratorPlan({
      plan: plan([
        {
          ...recoveryTask,
          repoRoot: "/repo/.samantha-worktrees/samantha-codex/task-failed",
        },
      ], [["recover-failure"]]),
      agents: [worker],
      projects: [project],
      createdAt: "2026-05-07T00:05:00.000Z",
      commandId: "remote-go-recovery-worktree",
    });

    expect(workerWorktree.ok).toBe(false);
    expect(workerWorktree.violations).toContain("task proposal recover-failure: repoRoot must not point to a Samantha worker worktree");
    expect(workerWorktree.violations).toContain("task proposal recover-failure: repoRoot must match project profile repoRoot for project samantha");
  });
});
