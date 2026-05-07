import { describe, expect, test } from "bun:test";
import {
  buildOrchestratorPrompt,
  buildOrchestratorQuestionDraftPrompt,
  parseOrchestratorPlanPayload,
  parseOrchestratorQuestionDraftPayload,
} from "../src/lib/orchestrator-agent";
import type { OrchestrationRequestRecord } from "../src/lib/orchestrator-store";
import type { ProjectProfile } from "../src/lib/project-profile";

describe("orchestrator agent prompt", () => {
  test("warns that dependent worker tasks do not share unmerged writes", () => {
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: "request-1",
      source: "remote",
      text: "보고서 작성 후 검증",
      senderId: "bk",
      status: "pending_plan",
      createdAt: "2026-05-06T10:00:00.000Z",
    };
    const project: ProjectProfile = {
      schemaVersion: 1,
      id: "omht",
      repoRoot: "/repo/omht",
      setupCommands: [],
      verifyCommands: ["bun typecheck"],
      forbiddenChanges: ["node_modules/**"],
    };

    const prompt = buildOrchestratorPrompt({
      request,
      projectProfiles: [project],
    });

    expect(prompt).toContain("Each worker task gets its own worktree from the canonical repo.");
    expect(prompt).toContain("Dependent tasks do not see unmerged file changes from earlier worker tasks.");
    expect(prompt).toContain("Do not create a separate verify-only task that depends on files written by an earlier write task.");
    expect(prompt).toContain("Put verification for a write task in that same task's verifyCommands.");
    expect(prompt).toContain("For recovery requests, treat run logs, changed files, and worker worktree paths as evidence only.");
    expect(prompt).toContain("Recovery tasks must use the selected project profile's canonical repoRoot.");
    expect(prompt).toContain("leave `repoRoot` empty and set `projectId`");
    expect(prompt).toContain("Choose task roles deliberately:");
    expect(prompt).toContain("Your output is advisory data only.");
    expect(prompt).toContain("TypeScript validation and BK decisions own all state changes and execution.");
    expect(prompt).toContain("Do not claim that you created tasks, approved actions, changed durable state, merged, pushed, or cleaned up work.");
    expect(prompt).toContain("Use `codex-spec` for report-only requirement shaping");
    expect(prompt).toContain("Use `codex-reviewer` for report-only code review");
    expect(prompt).toContain("Use `codex-evaluator` for report-only validation planning");
    expect(prompt).toContain("Use `codex-worker` only for implementation/write tasks");
    expect(prompt).toContain("Non-writer tasks must use `resultMode: \"report\"`");
  });

  test("rejects unsafe or ambiguous plan payloads before state mutation", () => {
    const task = {
      id: "write",
      title: "Write",
      targetAgent: "codex-worker",
      resultMode: "write",
      targetFiles: ["src/index.ts"],
      forbiddenChanges: ["state/**"],
      verifyCommands: ["bun typecheck"],
      instructions: "Write.",
      dependencies: [],
    };
    const payload = {
      summary: "계획",
      assumptions: [],
      questions: [],
      scope: [],
      nonScope: [],
      risks: [],
      tasks: [task],
      batches: [["write"]],
      userMessage: "계획",
    };

    expect(parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify(payload)}`).tasks).toHaveLength(1);
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      questions: ["BK 결정 필요"],
    })}`)).toThrow("plans with questions must not include task proposals");
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      tasks: [],
      batches: [],
    })}`)).toThrow("planned payloads must include at least one task or blocking questions");
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      batches: [["missing"]],
    })}`)).toThrow("references unknown task proposal");
  });

  test("builds and validates bounded question draft payloads", () => {
    const prompt = buildOrchestratorQuestionDraftPrompt({
      blocker: "검증 실패 원인이 모호함",
      context: "worker result missing exact fix",
      subject: { type: "run", id: "run-1" },
    });
    expect(prompt).toContain("bounded question-drafting mode");
    expect(prompt).toContain("Do not edit files. Do not create tasks. Do not dispatch workers.");
    expect(prompt).toContain("The deterministic CEO office may validate your draft and store it as a decision item.");

    const payload = {
      title: "검증 실패 방향 결정",
      prompt: "테스트 보강을 먼저 할까요?",
      options: ["approve", "revise"],
      risk: "방향 없이 재시도하면 같은 실패가 반복됩니다.",
      userMessage: "BK 결정이 필요합니다.",
    };
    const raw = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: `질문 초안\nORCHESTRATOR_QUESTION_DRAFT: ${JSON.stringify(payload)}`,
      },
    });
    expect(parseOrchestratorQuestionDraftPayload(raw)).toEqual(payload);
    expect(() => parseOrchestratorQuestionDraftPayload("ORCHESTRATOR_QUESTION_DRAFT: {}")).toThrow(
      "options must be a string array",
    );
  });
});
