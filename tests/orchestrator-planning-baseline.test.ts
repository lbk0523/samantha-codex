import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile } from "../src/lib/contracts";
import {
  parseOrchestratorPlanPayload,
  parseOrchestratorQuestionDraftPayload,
  parseOrchestratorSynthesisPayload,
} from "../src/lib/orchestrator-agent";
import { materializeOrchestratorPlan } from "../src/lib/orchestrator-materializer";
import type { OrchestratorPlanPayload, OrchestratorPlanRecord, OrchestratorTaskProposal } from "../src/lib/orchestrator-store";
import type { ProjectProfile } from "../src/lib/project-profile";
import { RemoteActionStore } from "../src/lib/remote-action-store";
import { TaskStore } from "../src/lib/task-store";

const blockedSkills = ["using-git-worktrees", "dispatching-parallel-agents", "subagent-driven-development"];
const writer: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: { requiredBundles: [], blockedSkills },
};
const nonWriter = (id: "codex-reviewer" | "codex-evaluator" | "codex-spec", role: AgentProfile["role"]): AgentProfile => ({
  ...writer,
  id,
  role,
  writerClass: "non-writer",
  worktreePolicy: "none",
  mergePolicy: "none",
});
const agents = [
  writer,
  nonWriter("codex-reviewer", "reviewer"),
  nonWriter("codex-evaluator", "evaluator"),
  nonWriter("codex-spec", "spec"),
];
const project: ProjectProfile = {
  schemaVersion: 1,
  id: "samantha",
  repoRoot: "/repo/samantha-codex",
  setupCommands: [],
  verifyCommands: ["bun typecheck"],
  forbiddenChanges: ["state/**", "runs/**", ".samantha-worktrees/**"],
};

let tmpRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

function task(id: string, patch: Partial<OrchestratorTaskProposal> = {}): OrchestratorTaskProposal {
  return {
    id,
    title: id,
    targetAgent: "codex-worker",
    projectId: "samantha",
    repoRoot: "",
    resultMode: "write",
    targetFiles: ["src/lib/orchestrator-materializer.ts"],
    forbiddenChanges: project.forbiddenChanges,
    setupCommands: [],
    verifyCommands: ["bun typecheck"],
    instructions: "Apply the smallest safe change and verify it inside this task.",
    dependencies: [],
    ...patch,
  };
}

function reportTask(id: string, targetAgent: OrchestratorTaskProposal["targetAgent"]): OrchestratorTaskProposal {
  return task(id, {
    targetAgent,
    resultMode: "report",
    targetFiles: [],
    forbiddenChanges: ["**/*"],
    verifyCommands: ["git status --short"],
    instructions: "Inspect the repository and report. Do not edit files.",
  });
}

function payload(tasks: OrchestratorTaskProposal[], batches: string[][], patch: Partial<OrchestratorPlanPayload> = {}): OrchestratorPlanPayload {
  return {
    summary: "baseline",
    assumptions: [],
    questions: [],
    scope: [],
    nonScope: [],
    risks: [],
    tasks,
    batches,
    userMessage: "baseline",
    ...patch,
  };
}

function plan(planPayload: OrchestratorPlanPayload, status: OrchestratorPlanRecord["status"] = "planned"): OrchestratorPlanRecord {
  return {
    schemaVersion: 1,
    id: `plan-${planPayload.summary.replace(/\s+/g, "-")}`,
    requestId: "request-phase4-p1",
    status,
    createdAt: "2026-05-08T00:01:00.000Z",
    payload: planPayload,
  };
}

function agentEvent(marker: string, value: unknown): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: `${marker} ${JSON.stringify(value)}` },
  });
}

const raw = (marker: string, value: unknown): string => `${marker} ${JSON.stringify(value)}`;

describe("Phase 4 P1 orchestrator planning baseline fixtures", () => {
  test("accepts representative request fixtures for current materialization behavior", () => {
    const cases = [
      {
        request: "구현해줘",
        plan: payload([task("implementation", {
          targetFiles: ["tests/orchestrator-planning-baseline.test.ts"],
          verifyCommands: ["bun test tests/orchestrator-planning-baseline.test.ts"],
        })], [["implementation"]]),
        expected: [["codex-worker", "write", ["tests/orchestrator-planning-baseline.test.ts"]]],
      },
      {
        request: "수정하지 말고 계획 리포트만 작성해줘",
        plan: payload([reportTask("planning-report", "codex-spec")], [["planning-report"]]),
        expected: [["codex-spec", "report", []]],
      },
      {
        request: "Review the plan, tighten the spec, and evaluate tests without editing files.",
        plan: payload([
          reportTask("review-risk", "codex-reviewer"),
          reportTask("shape-spec", "codex-spec"),
          reportTask("evaluate-tests", "codex-evaluator"),
        ], [["review-risk", "shape-spec", "evaluate-tests"]]),
        expected: [["codex-reviewer", "report", []], ["codex-spec", "report", []], ["codex-evaluator", "report", []]],
      },
      {
        request: "실패한 plan을 복구하되 이전 worker worktree는 증거로만 써줘",
        plan: payload([task("recover-plan", {
          targetFiles: ["src/lib/recovery-continuity.ts", "tests/recovery-continuity.test.ts"],
          instructions: "Recover using the canonical project profile root.",
        })], [["recover-plan"]]),
        expected: [["codex-worker", "write", ["src/lib/recovery-continuity.ts", "tests/recovery-continuity.test.ts"]]],
      },
    ];

    for (const item of cases) {
      expect(item.request).toBeTruthy();
      const parsed = parseOrchestratorPlanPayload(agentEvent("ORCHESTRATOR_PLAN:", item.plan));
      const result = materializeOrchestratorPlan({
        plan: plan(parsed),
        agents,
        projects: [project],
        createdAt: "2026-05-08T00:02:00.000Z",
        commandId: "remote-go-baseline",
      });
      expect(result.ok, item.request).toBe(true);
      expect(result.violations, item.request).toEqual([]);
      expect(result.tasks.map((candidate) => [candidate.targetAgent, candidate.resultMode, candidate.targetFiles])).toEqual(item.expected);
      expect(result.tasks.every((candidate) => candidate.repoRoot === project.repoRoot)).toBe(true);
    }
  });

  test("keeps ambiguous work question-only and validates question drafts", () => {
    const ambiguous = payload([], [], {
      summary: "ambiguous",
      questions: ["어떤 프로젝트와 파일 범위를 대상으로 할까요?"],
      risks: ["추측으로 실행하면 잘못된 프로젝트를 수정할 수 있다."],
    });
    const parsed = parseOrchestratorPlanPayload(agentEvent("ORCHESTRATOR_PLAN:", ambiguous));
    const result = materializeOrchestratorPlan({
      plan: plan(parsed, "questions"),
      agents,
      projects: [project],
      createdAt: "2026-05-08T00:03:00.000Z",
      commandId: "remote-go-ambiguous",
    });

    expect(parsed.tasks).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("orchestrator plan must be planned: questions");
    expect(result.violations).toContain("orchestrator plan still has open questions");
    expect(parseOrchestratorQuestionDraftPayload(agentEvent("ORCHESTRATOR_QUESTION_DRAFT:", {
      title: "작업 범위 확인",
      prompt: "어떤 프로젝트와 파일 범위를 먼저 처리할까요?",
      options: ["계획 리포트만", "작은 구현 task", "취소"],
      risk: "범위 없이 진행하면 unsafe delegation이 될 수 있습니다.",
      userMessage: "BK 결정이 필요합니다.",
    })).options).toEqual(["계획 리포트만", "작은 구현 task", "취소"]);
  });

  test("validates plan and synthesis payload boundaries", () => {
    const valid = payload([task("write-baseline")], [["write-baseline"]]);
    expect(parseOrchestratorPlanPayload(agentEvent("ORCHESTRATOR_PLAN:", valid)).tasks).toHaveLength(1);
    expect(() => parseOrchestratorPlanPayload(raw("ORCHESTRATOR_PLAN:", { ...valid, questions: ["진행할까요?"] }))).toThrow(
      "plans with questions must not include task proposals",
    );
    expect(() => parseOrchestratorPlanPayload(raw("ORCHESTRATOR_PLAN:", { ...valid, tasks: [], batches: [] }))).toThrow(
      "planned payloads must include at least one task, blocking questions, prerequisites, or blockers",
    );
    expect(() => parseOrchestratorPlanPayload(raw("ORCHESTRATOR_PLAN:", { ...valid, batches: [["missing"]] }))).toThrow(
      "references unknown task proposal",
    );

    const synthesis = {
      outcome: "mixed",
      summary: "일부 task는 통과했고 하나는 실패했습니다.",
      nextActions: ["텔레그램: /recover"],
      risks: ["재시도 전에 실패 원인 확인 필요"],
      userMessage: "결과 요약입니다.",
    };
    expect(parseOrchestratorSynthesisPayload(agentEvent("ORCHESTRATOR_SYNTHESIS:", synthesis))).toMatchObject({ outcome: "mixed" });
    expect(parseOrchestratorSynthesisPayload(raw("ORCHESTRATOR_SYNTHESIS:", { ...synthesis, outcome: "blocked" }))).toMatchObject({
      outcome: "blocked",
    });
    expect(parseOrchestratorSynthesisPayload(raw("ORCHESTRATOR_SYNTHESIS:", { ...synthesis, outcome: "needs-BK", nextActions: ["텔레그램: /now"] }))).toMatchObject({
      outcome: "needs-BK",
    });
    expect(() => parseOrchestratorSynthesisPayload(raw("ORCHESTRATOR_SYNTHESIS:", { ...synthesis, outcome: "unknown" }))).toThrow(
      "outcome must be pass, mixed, failed, blocked, or needs-BK",
    );
    expect(() => parseOrchestratorSynthesisPayload(raw("ORCHESTRATOR_SYNTHESIS:", { ...synthesis, nextActions: [] }))).toThrow(
      "nextActions must contain exactly one safe Telegram command",
    );
    expect(() =>
      parseOrchestratorSynthesisPayload(raw("ORCHESTRATOR_SYNTHESIS:", { ...synthesis, nextActions: ["텔레그램: /recover 또는 /problems"] })),
    ).toThrow(
      "nextActions must contain exactly one safe Telegram command",
    );
    expect(() => parseOrchestratorSynthesisPayload(raw("ORCHESTRATOR_SYNTHESIS:", { ...synthesis, nextActions: ["텔레그램: /run_latest"] }))).toThrow(
      "nextActions must contain exactly one safe Telegram command",
    );
  });

  test("rejects required negative materialization fixtures", () => {
    const cases: Array<{ name: string; tasks: OrchestratorTaskProposal[]; batches: string[][]; projects?: ProjectProfile[]; violations: string[] }> = [
      {
        name: "unsafe delegation",
        tasks: [task("review-edit", { targetAgent: "codex-reviewer", resultMode: "write", targetFiles: ["src/lib/policy.ts"] })],
        batches: [["review-edit"]],
        violations: [
          "task proposal review-edit: non-writer tasks must use report resultMode",
          "task proposal review-edit: non-writer report tasks must not declare targetFiles",
        ],
      },
      {
        name: "overbroad targetFiles",
        tasks: [task("whole-repo-write", { targetFiles: ["**/*"] })],
        batches: [["whole-repo-write"]],
        violations: ["task proposal whole-repo-write: targetFiles entry is too broad: **/*"],
      },
      {
        name: "missing verify",
        tasks: [task("missing-verify", { verifyCommands: [] })],
        batches: [["missing-verify"]],
        projects: [{ ...project, verifyCommands: [] }],
        violations: ["task proposal missing-verify: verifyCommands must not be empty"],
      },
      {
        name: "stale worker worktree root",
        tasks: [task("stale-root", { repoRoot: "/repo/.samantha-worktrees/samantha-codex/task-old" })],
        batches: [["stale-root"]],
        violations: [
          "task proposal stale-root: repoRoot must not point to a Samantha worker worktree",
          "task proposal stale-root: repoRoot must match project profile repoRoot for project samantha",
        ],
      },
      {
        name: "parallel writers",
        tasks: [task("write-a", { targetFiles: ["src/a.ts"] }), task("write-b", { targetFiles: ["src/b.ts"] })],
        batches: [["write-a", "write-b"]],
        violations: ["batches[0] exceeds writer cap 1: write-a, write-b"],
      },
    ];

    for (const item of cases) {
      const result = materializeOrchestratorPlan({
        plan: plan(payload(item.tasks, item.batches, { summary: item.name })),
        agents,
        projects: item.projects ?? [project],
        createdAt: "2026-05-08T00:04:00.000Z",
        commandId: "remote-go-negative",
      });
      expect(result.ok, item.name).toBe(false);
      for (const violation of item.violations) expect(result.violations, item.name).toContain(violation);
    }
  });

  test("keeps invalid materialization from mutating task or action stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-planning-baseline-"));
    tmpRoots.push(root);
    const taskStore = new TaskStore(join(root, "tasks.jsonl"));
    const actionStore = new RemoteActionStore(join(root, "remote-actions.jsonl"));
    const invalid = materializeOrchestratorPlan({
      plan: plan(payload([task("unsafe-write", { targetFiles: ["**/*"], verifyCommands: [] })], [["unsafe-write"]])),
      agents,
      projects: [project],
      createdAt: "2026-05-08T00:05:00.000Z",
      commandId: "remote-go-no-mutation",
    });

    if (invalid.ok) {
      for (const candidate of invalid.tasks) await taskStore.append(candidate);
      for (const action of invalid.actions) await actionStore.append(action);
    }
    expect(invalid.ok).toBe(false);
    expect(await taskStore.list()).toEqual([]);
    expect(await actionStore.list()).toEqual([]);
  });
});
