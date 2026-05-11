import { describe, expect, test } from "bun:test";
import {
  buildOrchestratorMemorySynthesisPrompt,
  buildOrchestratorPrompt,
  buildOrchestratorQuestionDraftPrompt,
  memorySynthesisPayloadToLearningCandidates,
  parseOrchestratorMemorySynthesisPayload,
  parseOrchestratorPlanPayload,
  parseOrchestratorQuestionDraftPayload,
  planningMemoryFromContextResults,
  type MemorySynthesisEvidence,
} from "../src/lib/orchestrator-agent";
import type { OrchestrationRequestRecord } from "../src/lib/orchestrator-store";
import type { ProjectProfile } from "../src/lib/project-profile";
import type { AgentProfile } from "../src/lib/contracts";

describe("orchestrator agent prompt", () => {
  test("warns that dependent worker tasks do not share unmerged writes", () => {
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: "request-1",
      ancestry: {
        mode: "assigned",
        projectId: "omht",
        goalId: "goal-omht-operations",
        workItemId: "request-1",
      },
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
    expect(prompt).toContain("Batches are execution waves");
    expect(prompt).toContain("later batch wait until all earlier batch actions pass before promotion");
    expect(prompt).toContain("report-only risk reducers before or in the same batch as the single writer task");
    expect(prompt).toContain("Every write task must include its own non-empty `verifyCommands`");
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
    expect(prompt).toContain("Use `codex-researcher` for report-only repository-local research");
    expect(prompt).toContain("Use `codex-content` for report-only content drafting");
    expect(prompt).toContain("Use `codex-operations` for report-only operational analysis");
    expect(prompt).toContain("Use `codex-worker` only for implementation/write tasks");
    expect(prompt).toContain("Advisory role topology:");
    expect(prompt).toContain("This topology grants no dispatch, writer, connector, secret, merge, push, cleanup, rollback, approval, or safety-policy authority.");
    expect(prompt).toContain("Reviewer reviews Writer");
    expect(prompt).toContain("Non-writer tasks must use `resultMode: \"report\"`");
    expect(prompt).toContain("Deterministic request classification:");
    expect(prompt).toContain("- intent: evaluation");
    expect(prompt).toContain("- safe handling: report_only");
    expect(prompt).toContain("Use this classification as an explainable safety hint only.");
    expect(prompt).toContain("It is not permission to dispatch workers or mutate state.");
    expect(prompt).toContain("If classification is `ambiguity_heavy`, prefer blocking questions");
    expect(prompt).toContain("Use plain plan `questions` for ambiguity found while drafting the current plan");
    expect(prompt).toContain("`orchestrator:question-draft` is only for an existing ambiguous blocker");
    expect(prompt).toContain("put it in `prerequisites` or `blockers` and leave `tasks` empty");
    expect(prompt).toContain("Do not turn missing context, missing profile/root/verify data, or host-only runtime work into speculative worker tasks.");
    expect(prompt).toContain("Prefer the simplest safe approach first");
    expect(prompt).toContain("Put rejected paths in `rejectedAlternatives` as advisory context only");
    expect(prompt).toContain("Only `tasks` and `batches` represent the selected executable plan path.");
    expect(prompt).toContain("`/go` materializes only that selected task set.");
    expect(prompt).toContain("Selected ancestry context:");
    expect(prompt).toContain("- projectId: omht");
    expect(prompt).toContain("- goalId: goal-omht-operations");
    expect(prompt).toContain("- workItemId: request-1");
    expect(prompt).toContain("All executable task proposals must set projectId exactly to omht.");
  });

  test("injects selected citation-backed memory for active project planning and preserves recommendation trace", () => {
    const request: OrchestrationRequestRecord = {
      schemaVersion: 1,
      id: "request-memory-plan",
      ancestry: {
        mode: "assigned",
        projectId: "samantha",
        goalId: "goal-memory",
        workItemId: "request-memory-plan",
      },
      source: "remote",
      text: "사만다 다음 메모리 작업 계획",
      senderId: "bk",
      status: "pending_plan",
      createdAt: "2026-05-10T05:00:00.000Z",
    };
    const projects: ProjectProfile[] = [
      {
        schemaVersion: 1,
        id: "samantha",
        repoRoot: "/repo/samantha",
        setupCommands: [],
        verifyCommands: ["bun typecheck"],
        forbiddenChanges: ["state/**"],
      },
      {
        schemaVersion: 1,
        id: "omht",
        repoRoot: "/repo/omht",
        setupCommands: [],
        verifyCommands: ["bun typecheck"],
        forbiddenChanges: [".env"],
      },
    ];
    const memory = planningMemoryFromContextResults([
      {
        kind: "memory",
        status: "ok",
        id: "memory-prefer-small-plans",
        title: "preference memory-prefer-small-plans",
        snippet: "BK prefers the smallest safe plan with explicit citation trace.",
        sourceKind: "memory",
        sourceId: "memory-prefer-small-plans",
        memoryKind: "preference",
        ancestry: request.ancestry,
        citations: [
          { kind: "memory", id: "memory-prefer-small-plans", ancestry: request.ancestry },
          { kind: "decision", id: "decision-small-plans", ancestry: request.ancestry },
        ],
      },
      {
        kind: "project_brief",
        status: "ok",
        id: "brief-omht:currentStrategy:0",
        title: "omht currentStrategy",
        snippet: "OMHT context must not leak into Samantha planning.",
        sourceKind: "project_brief",
        sourceId: "brief-omht",
        memoryKind: "strategy_context",
        ancestry: {
          mode: "assigned",
          projectId: "omht",
          goalId: "goal-omht",
          workItemId: "brief-omht",
        },
        citations: [{ kind: "project_brief", id: "brief-omht" }],
      },
    ], { projectId: "samantha" });

    const prompt = buildOrchestratorPrompt({
      request,
      projectProfiles: projects,
      planningMemory: memory,
    });

    expect(prompt).toContain("Selected source-backed memory context:");
    expect(prompt).toContain("kind=preference status=ok id=memory-prefer-small-plans");
    expect(prompt).toContain("decision:decision-small-plans");
    expect(prompt).not.toContain("OMHT context must not leak");
    expect(prompt).toContain("include it in `recommendationTrace` with exact citations");
    expect(prompt).toContain("If no selected memory snippet influences the recommendation, set `recommendationTrace` to an empty array.");

    const payload = {
      summary: "메모리 기반 계획",
      assumptions: [],
      questions: [],
      scope: ["작은 계획"],
      nonScope: ["multi-writer"],
      risks: [],
      selectedApproach: "기존 선호에 따라 작은 단일 writer 계획을 제안한다.",
      rejectedAlternatives: [],
      tradeoffs: [],
      recommendationTrace: [{
        recommendation: "단일 writer 작업으로 제한",
        reason: "BK의 작은 계획 선호와 writer cap 1 정책을 따른다.",
        citations: [{ kind: "decision" as const, id: "decision-small-plans" }],
      }],
      tasks: [{
        id: "memory-plan-write",
        title: "Implement memory planning trace",
        targetAgent: "codex-worker",
        projectId: "samantha",
        resultMode: "write",
        targetFiles: ["src/lib/orchestrator-agent.ts"],
        forbiddenChanges: ["state/**"],
        setupCommands: [],
        verifyCommands: ["bun typecheck"],
        instructions: "Implement the trace.",
        dependencies: [],
      }],
      batches: [["memory-plan-write"]],
      userMessage: "계획",
    };
    const parsed = parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify(payload)}`);
    expect(parsed.recommendationTrace).toEqual(payload.recommendationTrace);
    const escapedEvent = `codex-json: ${JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: `계획\nORCHESTRATOR_PLAN:${JSON.stringify(payload, null, 2)}`,
      },
    })}`;
    expect(parseOrchestratorPlanPayload(escapedEvent).summary).toBe("메모리 기반 계획");
    const escapedRawPayload = JSON.stringify(payload, null, 2)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
    expect(parseOrchestratorPlanPayload(`non-json event ORCHESTRATOR_PLAN:${escapedRawPayload}`).summary).toBe(
      "메모리 기반 계획",
    );
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      recommendationTrace: [{ recommendation: "bad", reason: "bad", citations: [] }],
    })}`)).toThrow("recommendationTrace[0].citations must include at least one source citation");
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
      selectedApproach: "한 writer task에 구현과 검증을 함께 둔다.",
      rejectedAlternatives: [
        {
          title: "대안 task를 별도로 실행",
          reason: "선택 경로가 아니며 materialization 대상이 아니다.",
          tradeoffs: ["검토 흔적은 남지만 실행 큐에는 들어가지 않는다."],
        },
      ],
      tradeoffs: ["작지만 보수적인 변경을 우선한다."],
      tasks: [task],
      batches: [["write"]],
      userMessage: "계획",
    };

    const parsed = parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify(payload)}`);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.selectedApproach).toBe("한 writer task에 구현과 검증을 함께 둔다.");
    expect(parsed.rejectedAlternatives?.[0]).toMatchObject({
      title: "대안 task를 별도로 실행",
      reason: "선택 경로가 아니며 materialization 대상이 아니다.",
    });
    expect(parsed.tradeoffs).toEqual(["작지만 보수적인 변경을 우선한다."]);
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      questions: ["BK 결정 필요"],
    })}`)).toThrow("plans with questions must not include task proposals");
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      tasks: [],
      batches: [],
    })}`)).toThrow("planned payloads must include at least one task, blocking questions, prerequisites, or blockers");
    const prerequisiteOnly = parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      prerequisites: ["project profile must define a canonical repo root"],
      tasks: [],
      batches: [],
    })}`);
    expect(prerequisiteOnly.tasks).toEqual([]);
    expect(prerequisiteOnly.prerequisites).toEqual(["project profile must define a canonical repo root"]);
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      blockers: ["host-only runtime verification is required"],
    })}`)).toThrow("plans with prerequisites or blockers must not include task proposals");
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      batches: [["missing"]],
    })}`)).toThrow("references unknown task proposal");
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      rejectedAlternatives: [{ title: "대안", reason: "실행 후보처럼 보이면 안 됨", tasks: [task] }],
    })}`)).toThrow("must be advisory only");
    expect(() => parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      questions: ["어떤 범위로 진행할까요?"],
      tasks: [],
      batches: [["write"]],
    })}`)).toThrow("plans with questions must not include batches");
    const questionOnly = parseOrchestratorPlanPayload(`ORCHESTRATOR_PLAN: ${JSON.stringify({
      ...payload,
      questions: ["어떤 범위로 진행할까요?"],
      tasks: [],
      batches: [],
    })}`);
    expect(questionOnly.tasks).toEqual([]);
    expect(questionOnly.batches).toEqual([]);
    expect(questionOnly.rejectedAlternatives?.[0]?.title).toBe("대안 task를 별도로 실행");
  });

  test("builds and validates bounded question draft payloads", () => {
    const prompt = buildOrchestratorQuestionDraftPrompt({
      blocker: "검증 실패 원인이 모호함",
      context: "worker result missing exact fix",
      subject: { type: "run", id: "run-1" },
    });
    expect(prompt).toContain("bounded question-drafting mode");
    expect(prompt).toContain("plain ORCHESTRATOR_PLAN.questions are sufficient");
    expect(prompt).toContain("Do not edit files. Do not create tasks. Do not dispatch workers.");
    expect(prompt).toContain("Do not choose an option, resolve the blocker, approve execution, or advance work.");
    expect(prompt).toContain("Use 2 or 3 concise options.");
    expect(prompt).toContain("The deterministic CEO office may validate your draft and store it as a decision item.");

    const payload = {
      title: "검증 실패 방향 결정",
      prompt: "테스트 보강을 먼저 할까요?",
      options: ["테스트 보강", "계획 수정", "취소"],
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
    expect(() => parseOrchestratorQuestionDraftPayload(`ORCHESTRATOR_QUESTION_DRAFT: ${JSON.stringify({
      ...payload,
      options: ["approve", "revise"],
    })}`)).toThrow("options must not authorize execution");
    expect(() => parseOrchestratorQuestionDraftPayload(`ORCHESTRATOR_QUESTION_DRAFT: ${JSON.stringify({
      ...payload,
      options: ["A", "B", "C", "D"],
    })}`)).toThrow("options must contain 2 or 3 choices");
    expect(() => parseOrchestratorQuestionDraftPayload(`ORCHESTRATOR_QUESTION_DRAFT: ${JSON.stringify({
      ...payload,
      risk: undefined,
    })}`)).toThrow("risk must be a non-empty string");
  });

  test("builds bounded memory synthesis prompt with explicit non-authority language", () => {
    const evidence: MemorySynthesisEvidence[] = [{
      citation: {
        kind: "operator_report",
        id: "operator-report-memory-m7",
      },
      snippet: "BK repeatedly asked for memory writes to remain review candidates first.",
      status: "ok",
    }];

    const prompt = buildOrchestratorMemorySynthesisPrompt({
      evidence,
      projectId: "samantha",
      goalId: "goal-memory",
      workItemId: "work-item-m7",
    });

    expect(prompt).toContain("bounded memory-synthesis mode");
    expect(prompt).toContain("Samantha-provided source evidence");
    expect(prompt).toContain("kind=operator_report id=operator-report-memory-m7");
    expect(prompt).toContain("Do not write memory.");
    expect(prompt).toContain("Do not overwrite project briefs, SOPs, skills, profiles, policies, tasks, actions, runs, or reports.");
    expect(prompt).toContain("Do not dispatch workers. Do not run merge, push, cleanup");
    expect(prompt).toContain("Do not claim any execution authority.");
    expect(prompt).toContain("store valid proposals only as pending_review candidates");
    expect(prompt).toContain("A later deterministic memory write gate and explicit review must approve any durable memory update.");
    expect(prompt).toContain("Cite only the exact source kind/id pairs listed below. Do not invent sources");
    expect(prompt).toContain("ORCHESTRATOR_MEMORY_SYNTHESIS:");
  });

  test("turns valid memory synthesis output into pending review candidates only", () => {
    const evidence: MemorySynthesisEvidence[] = [{
      citation: {
        kind: "operator_report",
        id: "operator-report-memory-m7",
        ancestry: {
          mode: "assigned",
          projectId: "samantha",
          goalId: "goal-memory",
          workItemId: "work-item-m7",
        },
      },
      snippet: "BK wants memory synthesis to produce review candidates before durable writes.",
      status: "ok",
    }];
    const payload = {
      summary: "메모리 후보 1건",
      proposals: [{
        proposedMemoryKind: "preference",
        scope: { type: "project", projectId: "samantha" },
        summary: "Memory synthesis output stays in review.",
        proposedContent: "Memory synthesis output should be captured as a pending review candidate before any durable write.",
        citations: [evidence[0].citation],
        confidence: 0.74,
        staleSourceNotes: [],
        behaviorImpact: "behavior_change",
        behaviorImpactReviewRequired: true,
      }],
      rejectedEvidence: [],
      userMessage: "검토 후보를 만들었습니다.",
    };
    const parsed = parseOrchestratorMemorySynthesisPayload(
      `ORCHESTRATOR_MEMORY_SYNTHESIS: ${JSON.stringify(payload)}`,
      { evidence },
    );
    const agent: AgentProfile = {
      id: "codex-orchestrator",
      role: "spec",
      model: "gpt-5.5",
      writerClass: "non-writer",
      worktreePolicy: "none",
      mergePolicy: "none",
      skillPolicy: { requiredBundles: [], blockedSkills: [] },
    };
    const candidates = memorySynthesisPayloadToLearningCandidates(parsed, {
      agent,
      createdAt: "2026-05-10T03:00:00.000Z",
      synthesisRunId: "memory-synthesis-run-m7",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "memory_synthesis",
      proposedMemoryKind: "preference",
      claimKind: "llm_summary",
      status: "pending_review",
      evidence: [evidence[0].citation],
      attribution: { kind: "llm", agentId: "codex-orchestrator", model: "gpt-5.5" },
      behaviorImpact: "behavior_change",
      behaviorImpactReviewRequired: true,
      synthesisRunId: "memory-synthesis-run-m7",
    });
    expect(candidates[0]).not.toHaveProperty("memory");
    expect(candidates[0]).not.toHaveProperty("projectBriefWrite");
    expect(candidates[0]).not.toHaveProperty("promotionGate");
  });

  test("fails closed for malformed memory synthesis output, missing or invented citations, and unsupported source kinds", () => {
    const evidence: MemorySynthesisEvidence[] = [{
      citation: { kind: "operator_report", id: "operator-report-memory-m7" },
      snippet: "Source-backed memory candidate.",
      status: "ok",
    }];
    const validProposal = {
      proposedMemoryKind: "known_risk",
      scope: { type: "project", projectId: "samantha" },
      summary: "Memory writes need review.",
      proposedContent: "Memory writes remain review candidates until approved.",
      citations: [evidence[0].citation],
      confidence: 0.7,
      staleSourceNotes: [],
      behaviorImpact: "none",
      behaviorImpactReviewRequired: false,
    };
    const raw = (proposal: unknown) => `ORCHESTRATOR_MEMORY_SYNTHESIS: ${JSON.stringify({
      summary: "후보",
      proposals: [proposal],
      rejectedEvidence: [],
      userMessage: "후보",
    })}`;

    expect(() => parseOrchestratorMemorySynthesisPayload("ORCHESTRATOR_MEMORY_SYNTHESIS: {\"summary\":\"후보\",\"proposals\":\"bad\",\"rejectedEvidence\":[],\"userMessage\":\"후보\"}", { evidence })).toThrow(
      "proposals must be an array",
    );
    expect(() => parseOrchestratorMemorySynthesisPayload(raw({ ...validProposal, citations: [] }), { evidence })).toThrow(
      "proposals[0].citations must include at least one source citation",
    );
    expect(() => parseOrchestratorMemorySynthesisPayload(raw({
      ...validProposal,
      citations: [{ kind: "wiki_page", id: "wiki-memory" }],
    }), { evidence })).toThrow("proposals[0].citations[0].kind is invalid");
    expect(() => parseOrchestratorMemorySynthesisPayload(raw({
      ...validProposal,
      citations: [{ kind: "operator_report", id: "operator-report-invented" }],
    }), { evidence })).toThrow("was not provided by Samantha evidence");
  });

  test("rejects behavior-changing memory claims without review flags and direct overwrite payloads", () => {
    const evidence: MemorySynthesisEvidence[] = [{
      citation: { kind: "operator_report", id: "operator-report-memory-m7" },
      snippet: "Behavior-changing memory must be reviewed.",
      status: "stale",
      staleReason: "Report was superseded by a later review.",
    }];
    const proposal = {
      proposedMemoryKind: "sop_document",
      scope: { type: "project", projectId: "samantha" },
      summary: "Agents should always use the new SOP.",
      proposedContent: "Agents should follow this SOP before dispatch decisions.",
      citations: [evidence[0].citation],
      confidence: 0.6,
      staleSourceNotes: ["Source is stale; use only as weak evidence."],
      behaviorImpact: "behavior_change",
      behaviorImpactReviewRequired: true,
    };
    const raw = (candidate: unknown) => `ORCHESTRATOR_MEMORY_SYNTHESIS: ${JSON.stringify({
      summary: "후보",
      proposals: [candidate],
      rejectedEvidence: [],
      userMessage: "후보",
    })}`;

    expect(() => parseOrchestratorMemorySynthesisPayload(raw({
      ...proposal,
      behaviorImpact: "none",
      behaviorImpactReviewRequired: false,
    }), { evidence })).toThrow("behavior-changing claims require behaviorImpact=behavior_change");
    expect(() => parseOrchestratorMemorySynthesisPayload(raw({
      ...proposal,
      staleSourceNotes: [],
    }), { evidence })).toThrow("staleSourceNotes must explain stale or conflicting source evidence");
    expect(() => parseOrchestratorMemorySynthesisPayload(raw({
      ...proposal,
      memoryWrite: { id: "memory-direct-overwrite" },
    }), { evidence })).toThrow("proposals[0].memoryWrite is not allowed");
    expect(() => parseOrchestratorMemorySynthesisPayload(raw({
      ...proposal,
      proposedContent: "Samantha may dispatch workers directly without approval for this SOP.",
    }), { evidence })).toThrow("claims execution authority that memory synthesis cannot grant");
  });
});
