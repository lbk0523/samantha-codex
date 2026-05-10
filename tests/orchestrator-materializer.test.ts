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

const researcher: AgentProfile = {
  ...reviewer,
  id: "codex-researcher",
  role: "researcher",
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

const strictProject = {
  ...project,
  safetyPolicy: {
    forbiddenChanges: ["docs/private/**"],
    allowedRemoteScopeIds: ["planning_report"],
    hostOnlyVerificationNeeds: ["bun run verify:host"],
    dispatchPrerequisites: ["BK must confirm host runtime window"],
  },
  remoteScopes: [
    {
      id: "planning_report",
      label: "Planning report",
      description: "Report-only docs work.",
      risk: "low" as const,
      resultMode: "report" as const,
      targetFiles: ["docs/**"],
      planSteps: ["Read docs.", "Report."],
      successCriteria: ["Report is actionable."],
    },
    {
      id: "implementation",
      label: "Implementation",
      description: "Code work.",
      risk: "medium" as const,
      resultMode: "write" as const,
      targetFiles: ["src/**"],
      planSteps: ["Read code.", "Implement."],
      successCriteria: ["Tests pass."],
    },
  ],
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
  test("copies assigned plan ancestry to materialized tasks and actions", () => {
    const ancestry = {
      mode: "assigned" as const,
      projectId: "samantha",
      goalId: "goal-samantha-operations",
      workItemId: "request-ancestry-flow",
    };
    const result = materializeOrchestratorPlan({
      plan: { ...plan([proposal({ id: "ancestry-report", title: "Ancestry report", targetAgent: "codex-reviewer" })], [["ancestry-report"]]), ancestry },
      agents: [reviewer],
      projects: [project],
      createdAt: "2026-05-07T00:01:00.000Z",
      commandId: "remote-go-ancestry",
    });

    expect(result.ok).toBe(true);
    expect(result.tasks[0]?.ancestry).toEqual(ancestry);
    expect(result.actions[0]?.ancestry).toEqual(ancestry);
  });

  test("rejects unknown or mismatched project proposals before materialization", () => {
    const ancestry = {
      mode: "assigned" as const,
      projectId: "samantha",
      goalId: "goal-samantha-operations",
      workItemId: "request-ancestry-flow",
    };
    const unknown = materializeOrchestratorPlan({
      plan: {
        ...plan([proposal({ id: "unknown-project", title: "Unknown project", targetAgent: "codex-reviewer", projectId: "missing" })], [["unknown-project"]]),
        ancestry,
      },
      agents: [reviewer],
      projects: [project],
      createdAt: "2026-05-07T00:01:00.000Z",
      commandId: "remote-go-unknown-project",
    });
    const mismatched = materializeOrchestratorPlan({
      plan: {
        ...plan([proposal({ id: "missing-project", title: "Missing project", targetAgent: "codex-reviewer", projectId: undefined })], [["missing-project"]]),
        ancestry,
      },
      agents: [reviewer],
      projects: [project],
      createdAt: "2026-05-07T00:01:00.000Z",
      commandId: "remote-go-mismatched-project",
    });

    expect(unknown.ok).toBe(false);
    expect(unknown.violations).toContain("task proposal unknown-project: projectId is unknown: missing");
    expect(unknown.violations).toContain("task proposal unknown-project: projectId must match selected project context: missing != samantha");
    expect(mismatched.ok).toBe(false);
    expect(mismatched.violations).toContain("task proposal missing-project: projectId must match selected project context: (missing) != samantha");
  });

  test("question-only plans produce no tasks or actions", () => {
    const result = materializeOrchestratorPlan({
      plan: {
        ...plan([], []),
        status: "questions",
        ancestry: {
          mode: "unassigned",
          workItemId: "request-needs-project",
          reason: "BK has not selected a project yet",
        },
        payload: {
          ...plan([], []).payload!,
          questions: ["어느 project로 진행할까요?"],
        },
      },
      agents: [worker],
      projects: [project],
      createdAt: "2026-05-07T00:01:00.000Z",
      commandId: "remote-go-question-only",
    });

    expect(result.ok).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.actions).toEqual([]);
  });

  test("materializes reviewer, researcher, and evaluator reports alongside a single writer", () => {
    const tasks = [
      proposal({ id: "review-risk", title: "Review implementation risk", targetAgent: "codex-reviewer" }),
      proposal({ id: "research-context", title: "Research repository context", targetAgent: "codex-researcher" }),
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
      plan: plan(tasks, [["review-risk", "research-context", "plan-verify", "apply-change"]]),
      agents: [worker, reviewer, researcher, evaluator, spec],
      projects: [project],
      createdAt: "2026-05-07T00:01:00.000Z",
      commandId: "remote-go-role-aware",
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.tasks.map((task) => [task.targetAgent, task.resultMode, task.targetFiles])).toEqual([
      ["codex-reviewer", "report", []],
      ["codex-researcher", "report", []],
      ["codex-evaluator", "report", []],
      ["codex-worker", "write", ["src/lib/orchestrator-materializer.ts", "tests/orchestrator-materializer.test.ts"]],
    ]);
    expect(result.actions.map((action) => [action.targetAgent, action.status])).toEqual([
      ["codex-reviewer", "pending"],
      ["codex-researcher", "pending"],
      ["codex-evaluator", "pending"],
      ["codex-worker", "pending"],
    ]);
  });

  test("materializes only the selected task proposals and keeps alternatives advisory", () => {
    const selected = proposal({
      id: "selected-write",
      title: "Selected write path",
      targetAgent: "codex-worker",
      resultMode: "write",
      targetFiles: ["src/lib/orchestrator-materializer.ts", "tests/orchestrator-materializer.test.ts"],
      instructions: "Apply the selected implementation path and verify it.",
    });
    const selectedPlan = plan([selected], [["selected-write"]]);

    const result = materializeOrchestratorPlan({
      plan: {
        ...selectedPlan,
        payload: {
          ...selectedPlan.payload!,
          selectedApproach: "Use one writer task with its own verification.",
          rejectedAlternatives: [
            {
              title: "shadow-task alternative",
              reason: "This is not the selected path and must not create task-shadow-task.",
              tradeoffs: ["Useful context, no execution authority."],
            },
          ],
          tradeoffs: ["Slightly less parallel, keeps writer cap at one."],
        },
      },
      agents: [worker],
      projects: [project],
      createdAt: "2026-05-07T00:01:30.000Z",
      commandId: "remote-go-advisory-alternatives",
    });

    expect(result.ok).toBe(true);
    expect(result.tasks.map((task) => task.id)).toEqual(["task-selected-write"]);
    expect(result.actions.map((action) => action.orchestratorTaskId)).toEqual(["selected-write"]);
    expect(result.tasks.map((task) => task.id)).not.toContain("task-shadow-task");
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

  test("rejects unknown dependencies and effective dependency cycles", () => {
    const unknown = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "use-missing",
          title: "Use missing prerequisite",
          targetAgent: "codex-spec",
          dependencies: ["missing-context"],
        }),
      ], [["use-missing"]]),
      agents: [spec],
      projects: [project],
      createdAt: "2026-05-07T00:03:30.000Z",
      commandId: "remote-go-unknown-dependency",
    });

    expect(unknown.ok).toBe(false);
    expect(unknown.violations).toContain("task proposal use-missing: dependency references unknown task proposal: missing-context");

    const cycle = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "cycle-a",
          title: "Cycle A",
          targetAgent: "codex-spec",
          dependencies: ["cycle-b"],
        }),
        proposal({
          id: "cycle-b",
          title: "Cycle B",
          targetAgent: "codex-reviewer",
        }),
      ], [["cycle-a"], ["cycle-b"]]),
      agents: [spec, reviewer],
      projects: [project],
      createdAt: "2026-05-07T00:03:40.000Z",
      commandId: "remote-go-dependency-cycle",
    });

    expect(cycle.ok).toBe(false);
    expect(cycle.violations).toContain("task proposal dependency cycle: cycle-a -> cycle-b -> cycle-a");
  });

  test("blocks report-only verification after unmerged writer output", () => {
    const result = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "apply-change",
          title: "Apply focused change",
          targetAgent: "codex-worker",
          resultMode: "write",
          targetFiles: ["src/lib/orchestrator-materializer.ts"],
          instructions: "Apply the focused change and run verification inside this task.",
        }),
        proposal({
          id: "verify-output",
          title: "Verify unmerged output",
          targetAgent: "codex-evaluator",
          instructions: "Verify the previous writer output. Do not edit files.",
        }),
      ], [["apply-change"], ["verify-output"]]),
      agents: [worker, evaluator],
      projects: [project],
      createdAt: "2026-05-07T00:03:50.000Z",
      commandId: "remote-go-post-writer-verify",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "task proposal verify-output: report-only tasks must not depend on unmerged writer output from apply-change; put verification in the writer task's verifyCommands",
    );
  });

  test("requires write proposals to carry their own verify commands", () => {
    const result = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "write-with-default-verify-only",
          title: "Write with project default verify only",
          targetAgent: "codex-worker",
          resultMode: "write",
          targetFiles: ["src/lib/orchestrator-materializer.ts"],
          verifyCommands: [],
          instructions: "Apply the change.",
        }),
      ], [["write-with-default-verify-only"]]),
      agents: [worker],
      projects: [project],
      createdAt: "2026-05-07T00:03:55.000Z",
      commandId: "remote-go-missing-writer-verify",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "task proposal write-with-default-verify-only: writer task proposals must include their own verifyCommands",
    );
  });

  test("blocks project-specific forbidden changes before materialization", () => {
    const result = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "touch-private-doc",
          title: "Touch private docs",
          targetAgent: "codex-reviewer",
          targetFiles: ["docs/private/notes.md"],
          forbiddenChanges: [],
        }),
      ], [["touch-private-doc"]]),
      agents: [reviewer],
      projects: [strictProject],
      createdAt: "2026-05-07T00:03:56.000Z",
      commandId: "remote-go-project-forbidden",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "task proposal touch-private-doc: targetFiles entry is forbidden: docs/private/notes.md matches docs/private/**",
    );
    expect(result.tasks).toEqual([
      expect.objectContaining({ forbiddenChanges: ["state/**", "docs/private/**"] }),
    ]);
  });

  test("blocks tasks outside project allowed remote scopes before materialization", () => {
    const result = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "write-source",
          title: "Write source",
          targetAgent: "codex-worker",
          resultMode: "write",
          targetFiles: ["src/lib/policy.ts"],
          instructions: "Apply a focused change.",
        }),
      ], [["write-source"]]),
      agents: [worker],
      projects: [{ ...strictProject, safetyPolicy: { allowedRemoteScopeIds: ["planning_report"] } }],
      createdAt: "2026-05-07T00:03:56.500Z",
      commandId: "remote-go-project-scope",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "task proposal write-source: project policy samantha blocked: resultMode write is outside allowed remote scopes planning_report. Next safe action: revise the plan to an allowed project scope or request governed project policy approval.",
    );
    expect(result.violations).toContain(
      "task proposal write-source: project policy samantha blocked: targetFiles entry src/lib/policy.ts is outside allowed remote scopes planning_report. Next safe action: revise targetFiles to the allowed project scope or request governed project policy approval.",
    );
  });

  test("reports project-specific dispatch prerequisites and host-only verification needs", () => {
    const result = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "strict-doc-report",
          title: "Strict doc report",
          targetAgent: "codex-reviewer",
          targetFiles: ["docs/report.md"],
          forbiddenChanges: [],
        }),
      ], [["strict-doc-report"]]),
      agents: [reviewer],
      projects: [strictProject],
      createdAt: "2026-05-07T00:03:56.700Z",
      commandId: "remote-go-project-prereq",
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      "task proposal strict-doc-report: project policy samantha blocked: dispatch prerequisite is unresolved: BK must confirm host runtime window. Next safe action: satisfy the project prerequisite or revise the plan to keep it as a blocker before /go.",
    );
    expect(result.violations).toContain(
      "task proposal strict-doc-report: project policy samantha blocked: host-only verification is required outside worker dispatch: bun run verify:host. Next safe action: revise the plan to report this as host verification instead of materializing a worker task.",
    );
  });

  test("keeps prerequisites and host-only runtime requirements out of worker tasks", () => {
    const prerequisite = materializeOrchestratorPlan({
      plan: {
        ...plan([], []),
        payload: {
          ...plan([], []).payload!,
          prerequisites: ["canonical repo root is missing from the project profile"],
        },
      },
      agents: [worker],
      projects: [project],
      createdAt: "2026-05-07T00:03:56.000Z",
      commandId: "remote-go-prerequisite",
    });

    expect(prerequisite.ok).toBe(false);
    expect(prerequisite.tasks).toEqual([]);
    expect(prerequisite.actions).toEqual([]);
    expect(prerequisite.violations).toContain(
      "orchestrator plan has prerequisite: canonical repo root is missing from the project profile",
    );

    const hostOnly = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "host-runtime",
          title: "Run host runtime verification",
          targetAgent: "codex-worker",
          resultMode: "write",
          targetFiles: ["src/samantha.ts"],
          verifyCommands: ["bun run verify:host"],
          instructions: "Run host runtime verification.",
        }),
      ], [["host-runtime"]]),
      agents: [worker],
      projects: [project],
      createdAt: "2026-05-07T00:03:57.000Z",
      commandId: "remote-go-host-only",
    });

    expect(hostOnly.ok).toBe(false);
    expect(hostOnly.violations).toContain(
      "task proposal host-runtime: verifyCommands[0] contains a host-only runtime requirement; report it as a blocker/next action instead of a worker task command",
    );
  });

  test("keeps dependent writer actions waiting for report-only prerequisites", () => {
    const result = materializeOrchestratorPlan({
      plan: plan([
        proposal({
          id: "review-risk",
          title: "Review implementation risk",
          targetAgent: "codex-reviewer",
        }),
        proposal({
          id: "apply-change",
          title: "Apply focused change",
          targetAgent: "codex-worker",
          resultMode: "write",
          targetFiles: ["src/lib/orchestrator-materializer.ts"],
          instructions: "Apply the focused change after the risk report passes.",
          dependencies: ["review-risk"],
        }),
      ], [["review-risk"], ["apply-change"]]),
      agents: [worker, reviewer],
      projects: [project],
      createdAt: "2026-05-07T00:03:58.000Z",
      commandId: "remote-go-dependent-writer",
    });

    expect(result.ok).toBe(true);
    expect(result.actions.map((action) => [action.orchestratorTaskId, action.status])).toEqual([
      ["review-risk", "pending"],
      ["apply-change", "waiting"],
    ]);
    expect(result.actions[1]?.dependsOnActionIds).toEqual([result.actions[0]?.id]);
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
