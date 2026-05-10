import { describe, expect, test } from "bun:test";
import type { AgentProfile, SafetyPolicy, TaskSpec } from "../src/lib/contracts";
import { createDecisionItem, type DecisionItem } from "../src/lib/decision-store";
import { createGovernanceEvent, type GovernanceEventRecord } from "../src/lib/governance-event-store";
import {
  createParallelismEvidenceRecord,
  type ParallelismEvidenceRecord,
  type ParallelismWriterConflictSafety,
} from "../src/lib/parallelism-evidence-store";
import {
  CAPABILITY_CHANGE_RISK_CLASS,
  PROFILE_CHANGE_RISK_CLASS,
  agentProfileChangeSummary,
  connectorAccessCapabilityId,
  connectorSecretCapabilityId,
  safetyPolicyCapabilityId,
  secretAccessCapabilityId,
  skillBundleCapabilityId,
  validateSafetyPolicyGovernance,
} from "../src/lib/profile-governance";
import { DEFAULT_SAFETY_POLICY, validateDispatch } from "../src/lib/policy";
import {
  DEFAULT_ADVISORY_ROLE_TOPOLOGY,
  advisoryRoleTopologyCapabilityId,
  advisoryRoleTopologyChangeSummary,
  validateAdvisoryRoleTopologyGovernance,
} from "../src/lib/role-topology";
import {
  projectSafetyPolicyCapabilityId,
  validateProjectSafetyPolicyGovernance,
} from "../src/lib/project-safety-policy";
import type { ProjectProfile } from "../src/lib/project-profile";

const blockedSkills = [
  "using-git-worktrees",
  "dispatching-parallel-agents",
  "subagent-driven-development",
];

const reviewer: AgentProfile = {
  id: "codex-reviewer",
  role: "reviewer",
  model: "gpt-5.5",
  writerClass: "non-writer",
  worktreePolicy: "none",
  mergePolicy: "none",
  skillPolicy: { requiredBundles: [], blockedSkills },
};

const reportTask: TaskSpec = {
  id: "profile-governance-report",
  title: "Profile governance report",
  targetAgent: "codex-reviewer",
  resultMode: "report",
  targetFiles: [],
  forbiddenChanges: ["**/*"],
  verifyCommands: [],
  instructions: "Return a report only.",
  status: "pending",
};

const project: ProjectProfile = {
  schemaVersion: 1,
  id: "samantha",
  repoRoot: "/repo/samantha",
  setupCommands: [],
  verifyCommands: ["bun typecheck"],
  forbiddenChanges: ["state/**", "runs/**"],
  remoteScopes: [
    {
      id: "planning_report",
      label: "Planning report",
      description: "Report only.",
      risk: "low",
      resultMode: "report",
      targetFiles: ["docs/**"],
      planSteps: ["Read docs."],
      successCriteria: ["Report is actionable."],
    },
    {
      id: "implementation",
      label: "Implementation",
      description: "Code changes.",
      risk: "medium",
      resultMode: "write",
      targetFiles: ["src/**"],
      planSteps: ["Read code."],
      successCriteria: ["Tests pass."],
    },
  ],
  safetyPolicy: {
    forbiddenChanges: ["docs/private/**"],
    allowedRemoteScopeIds: ["planning_report"],
    dispatchPrerequisites: ["BK confirms the deployment window"],
    riskDefaults: { remoteScopes: { planning_report: "medium" } },
  },
};

function approvedDecision(input: {
  kind: "agent_profile_change" | "capability_change";
  subjectType: "agent_profile" | "capability" | "policy";
  subjectId: string;
  prompt: string;
  createdAt?: string;
}): DecisionItem {
  const createdAt = input.createdAt ?? "2026-05-09T00:00:00.000Z";
  return {
    ...createDecisionItem({
      kind: input.kind,
      title: `Approve ${input.subjectId}`,
      prompt: input.prompt,
      risk: input.kind === "agent_profile_change" ? PROFILE_CHANGE_RISK_CLASS : CAPABILITY_CHANGE_RISK_CLASS,
      subject: { type: input.subjectType, id: input.subjectId },
      createdAt,
    }),
    status: "resolved",
    updatedAt: "2026-05-09T00:01:00.000Z",
    resolvedAt: "2026-05-09T00:01:00.000Z",
    resolvedBy: "bk",
    resolution: "approved",
    resolutionNote: "Approved after governance review.",
  };
}

function safeConflictEvidence(): ParallelismWriterConflictSafety {
  return {
    schemaVersion: 1,
    evaluatedAt: "2026-05-10T00:02:00.000Z",
    advisoryOnly: true,
    advisorySafe: true,
    mayIncreaseWriterCap: false,
    writerCap: DEFAULT_SAFETY_POLICY.writerCap,
    candidateCount: 2,
    violations: [],
  };
}

function completeParallelismEvidence(): ParallelismEvidenceRecord {
  return createParallelismEvidenceRecord({
    observedAt: "2026-05-10T00:03:00.000Z",
    planId: "plan-writer-cap-evidence",
    batches: [["task-review", "task-research"], ["task-write"]],
    refs: [
      {
        taskId: "task-review",
        actionId: "action-review",
        runId: "run-review",
        runLogPath: "/runs/run-review.json",
        agentId: "codex-reviewer",
        agentRole: "reviewer",
        resultMode: "report",
        outcome: "pass",
        changedFiles: [],
      },
      {
        taskId: "task-research",
        actionId: "action-research",
        runId: "run-research",
        runLogPath: "/runs/run-research.json",
        agentId: "codex-researcher",
        agentRole: "researcher",
        resultMode: "report",
        outcome: "pass",
        changedFiles: [],
      },
      {
        taskId: "task-write",
        actionId: "action-write",
        runId: "run-write",
        runLogPath: "/runs/run-write.json",
        agentId: "codex-worker",
        agentRole: "writer",
        resultMode: "write",
        outcome: "pass",
        changedFiles: ["src/lib/profile-governance.ts"],
      },
    ],
    verification: { pass: true, summary: "parallel non-writers plus one writer passed" },
    mergeStatus: "completed",
    cleanupStatus: "completed",
    outcome: "pass",
    writerConflictSafety: safeConflictEvidence(),
  });
}

function rollbackDrillEvidence(): GovernanceEventRecord {
  return createGovernanceEvent({
    timestamp: "2026-05-10T00:04:00.000Z",
    actor: "bk",
    source: { kind: "operator_report", id: "recovery-drill:merge-conflict" },
    subject: { type: "run", id: "drill-merge-conflict" },
    kind: "transition_completed",
    riskClass: "medium",
    summary: "Recovery drill merge-conflict outcome=fixed: rollback path verified through operator recovery.",
  });
}

describe("agent profile and capability governance", () => {
  test("rejects an unapproved model/profile authority change before dispatch use", () => {
    const changed = { ...reviewer, model: "gpt-6" };
    const result = validateDispatch(reportTask, changed);

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain(
      "agent profile codex-reviewer has unapproved governed authority change: model: gpt-5.5 -> gpt-6",
    );
  });

  test("accepts an approved profile authority change and keeps non-writers report-only", () => {
    const changed = { ...reviewer, model: "gpt-6" };
    const result = validateDispatch(reportTask, changed, undefined, [
      approvedDecision({
        kind: "agent_profile_change",
        subjectType: "agent_profile",
        subjectId: "codex-reviewer",
        prompt: agentProfileChangeSummary(changed),
      }),
    ]);

    expect(result.mayDispatch).toBe(true);
    expect(result.violations).toEqual([]);
    expect(changed.worktreePolicy).toBe("none");
    expect(changed.mergePolicy).toBe("none");
  });

  test("rejects stale governed approvals for the wrong profile, capability, or policy subject", () => {
    const changedProfile = { ...reviewer, model: "gpt-6" };
    const profileResult = validateDispatch(reportTask, changedProfile, undefined, [
      approvedDecision({
        kind: "agent_profile_change",
        subjectType: "agent_profile",
        subjectId: "codex-worker",
        prompt: agentProfileChangeSummary(changedProfile),
      }),
    ]);

    const skillChanged: AgentProfile = {
      ...reviewer,
      skillPolicy: {
        ...reviewer.skillPolicy,
        requiredBundles: [{ id: "web-research", source: "local", ref: "skills/web-research" }],
      },
    };
    const capabilityResult = validateDispatch(reportTask, skillChanged, undefined, [
      approvedDecision({
        kind: "agent_profile_change",
        subjectType: "agent_profile",
        subjectId: skillChanged.id,
        prompt: agentProfileChangeSummary(skillChanged),
      }),
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: skillBundleCapabilityId("codex-worker"),
        prompt: "Stale skill bundle approval for a different profile.",
      }),
    ]);
    const changedPolicy: SafetyPolicy = { ...DEFAULT_SAFETY_POLICY, writerCap: 2 };
    const policyResult = validateSafetyPolicyGovernance(changedPolicy, DEFAULT_SAFETY_POLICY, [
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: safetyPolicyCapabilityId(),
        prompt: "Wrong subject type for safety policy change.",
      }),
    ]);

    expect(profileResult.violations).toContain(
      "agent profile codex-reviewer has unapproved governed authority change: model: gpt-5.5 -> gpt-6",
    );
    expect(capabilityResult.violations).toContain(
      "agent profile codex-reviewer has unapproved allowed skill bundle capability: web-research@local@skills/web-research",
    );
    expect(policyResult.violations).toEqual([
      "safety policy has unapproved governed capability change: writerCap: 1 -> 2",
    ]);
  });

  test("requires separate governed capability approval for allowed skill bundles", () => {
    const changed: AgentProfile = {
      ...reviewer,
      skillPolicy: {
        ...reviewer.skillPolicy,
        requiredBundles: [{ id: "web-research", source: "local", ref: "skills/web-research" }],
      },
    };
    const profileApproval = approvedDecision({
      kind: "agent_profile_change",
      subjectType: "agent_profile",
      subjectId: changed.id,
      prompt: agentProfileChangeSummary(changed),
    });

    expect(validateDispatch(reportTask, changed, undefined, [profileApproval]).violations).toContain(
      "agent profile codex-reviewer has unapproved allowed skill bundle capability: web-research@local@skills/web-research",
    );
    expect(validateDispatch(reportTask, changed, undefined, [
      profileApproval,
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: skillBundleCapabilityId(changed.id),
        prompt: "Allow web-research skill bundle for codex-reviewer.",
      }),
    ]).mayDispatch).toBe(true);
  });

  test("requires governed capability approval for connector or secret access grants", () => {
    const agentId = reviewer.id;
    const secretName = "OPERATIONS_API_KEY";
    const changed: AgentProfile = {
      ...reviewer,
      connectorAccess: [
        { connector: "gmail", capabilityId: connectorAccessCapabilityId(agentId, "gmail") },
      ],
      secretAccess: [
        { secretName, capabilityId: secretAccessCapabilityId(agentId, secretName) },
      ],
    };
    const violations = validateDispatch(reportTask, changed).violations;

    expect(violations).toContain("agent profile codex-reviewer is missing approved connector capability records: gmail");
    expect(violations).toContain("agent profile codex-reviewer is missing approved secret capability records: 1 secret grant(s)");
    expect(JSON.stringify(violations)).not.toContain(secretName);
    expect(validateDispatch(reportTask, changed, undefined, [
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: connectorAccessCapabilityId(agentId, "gmail"),
        prompt: "Grant gmail connector access as a governed capability record; no connector implementation is enabled.",
      }),
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: secretAccessCapabilityId(agentId, secretName),
        prompt: "Grant one named secret reference as a governed capability record without exposing the value.",
      }),
    ]).mayDispatch).toBe(true);
  });

  test("rejects connector or secret access outside governed capability records", () => {
    const secretName = "OPERATIONS_API_KEY";
    const changed = {
      ...reviewer,
      connectorAccess: ["gmail"],
      secretAccess: [secretName],
    } as unknown as AgentProfile;
    const result = validateDispatch(reportTask, changed, undefined, [
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: connectorSecretCapabilityId(changed.id),
        prompt: "Broad connector/secret approval is not a governed capability record.",
      }),
    ]);

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain(
      "agent profile codex-reviewer has connector/secret access outside governed capability records: connectorAccess, secretAccess",
    );
    expect(JSON.stringify(result.violations)).not.toContain(secretName);
  });

  test("keeps report-only agents read-only even when an approved skill suggests broader action", () => {
    const changed: AgentProfile = {
      ...reviewer,
      skillPolicy: {
        ...reviewer.skillPolicy,
        requiredBundles: [{ id: "write-helper", source: "local", ref: "skills/write-helper" }],
      },
    };
    const writeTask: TaskSpec = {
      ...reportTask,
      resultMode: "write",
      targetFiles: ["src/lib/policy.ts"],
    };
    const result = validateDispatch(writeTask, changed, undefined, [
      approvedDecision({
        kind: "agent_profile_change",
        subjectType: "agent_profile",
        subjectId: changed.id,
        prompt: agentProfileChangeSummary(changed),
      }),
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: skillBundleCapabilityId(changed.id),
        prompt: "Allow write-helper methodology for report-only review; no execution authority is granted.",
      }),
    ]);

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain("non-writer tasks must use report resultMode");
    expect(result.violations).toContain("non-writer report tasks must not declare targetFiles");
  });

  test("blocks orchestration-conflicting skill bundles even with capability approval", () => {
    const changed: AgentProfile = {
      ...reviewer,
      skillPolicy: {
        ...reviewer.skillPolicy,
        requiredBundles: [{ id: "using-git-worktrees", source: "local", ref: "skills/using-git-worktrees" }],
      },
    };
    const result = validateDispatch(reportTask, changed, undefined, [
      approvedDecision({
        kind: "agent_profile_change",
        subjectType: "agent_profile",
        subjectId: changed.id,
        prompt: agentProfileChangeSummary(changed),
      }),
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: skillBundleCapabilityId(changed.id),
        prompt: "Attempt to allow a worktree skill.",
      }),
    ]);

    expect(result.mayDispatch).toBe(false);
    expect(result.violations).toContain(
      "agent profile required skill bundle is blocked by safety policy: using-git-worktrees",
    );
  });

  test("rejects unapproved safety policy changes", () => {
    const changedPolicy: SafetyPolicy = { ...DEFAULT_SAFETY_POLICY, writerCap: 2 };

    expect(validateSafetyPolicyGovernance(changedPolicy, DEFAULT_SAFETY_POLICY).violations).toEqual([
      "safety policy has unapproved governed capability change: writerCap: 1 -> 2",
    ]);
    const approvedWriterCap = validateSafetyPolicyGovernance(changedPolicy, DEFAULT_SAFETY_POLICY, [
      approvedDecision({
        kind: "capability_change",
        subjectType: "policy",
        subjectId: safetyPolicyCapabilityId(),
        prompt: "Approve safety policy writerCap change with auditable diff: writerCap: 1 -> 2.",
      }),
    ]);
    expect(approvedWriterCap.ok).toBe(false);
    expect(approvedWriterCap.violations).toContain(
      "safety policy writerCap increase is missing complete dogfood evidence",
    );
    expect(approvedWriterCap.violations).toContain(
      "safety policy writerCap change is missing deterministic writer conflict evidence",
    );
    expect(approvedWriterCap.violations).toContain(
      "safety policy writerCap increase is missing merge and cleanup evidence",
    );
    expect(approvedWriterCap.violations).toContain(
      "safety policy writerCap increase is missing completed rollback drill evidence",
    );
  });

  test("blocks writerCap increase when evidence is partial or the diff is not auditable", () => {
    const changedPolicy: SafetyPolicy = { ...DEFAULT_SAFETY_POLICY, writerCap: 2 };
    const approvedWithoutDiff = approvedDecision({
      kind: "capability_change",
      subjectType: "policy",
      subjectId: safetyPolicyCapabilityId(),
      prompt: "Approve safety policy writerCap change.",
    });
    const partial = validateSafetyPolicyGovernance(changedPolicy, DEFAULT_SAFETY_POLICY, [approvedWithoutDiff], {
      writerConflictSafety: safeConflictEvidence(),
      parallelismEvidence: [
        createParallelismEvidenceRecord({
          observedAt: "2026-05-10T00:03:00.000Z",
          planId: "plan-partial-evidence",
          batches: [["task-review", "task-research"]],
          refs: [
            {
              taskId: "task-review",
              agentId: "codex-reviewer",
              agentRole: "reviewer",
              resultMode: "report",
              outcome: "pass",
              changedFiles: [],
            },
            {
              taskId: "task-research",
              agentId: "codex-researcher",
              agentRole: "researcher",
              resultMode: "report",
              outcome: "pass",
              changedFiles: [],
            },
          ],
          verification: { pass: true, summary: "report-only dogfood passed" },
          mergeStatus: "not_applicable",
          cleanupStatus: "not_applicable",
          outcome: "pass",
        }),
      ],
    });

    expect(partial.ok).toBe(false);
    expect(partial.violations).toContain("approved safety policy change is missing auditable diff: writerCap: 1 -> 2");
    expect(partial.violations).toContain("safety policy writerCap increase is missing complete dogfood evidence");
    expect(partial.violations).toContain("safety policy writerCap increase is missing merge and cleanup evidence");
    expect(partial.violations).toContain("safety policy writerCap increase is missing completed rollback drill evidence");
  });

  test("allows writerCap governance check with complete evidence and BK approval", () => {
    const changedPolicy: SafetyPolicy = { ...DEFAULT_SAFETY_POLICY, writerCap: 2 };
    const result = validateSafetyPolicyGovernance(changedPolicy, DEFAULT_SAFETY_POLICY, [
      approvedDecision({
        kind: "capability_change",
        subjectType: "policy",
        subjectId: safetyPolicyCapabilityId(),
        prompt: "Approve safety policy writerCap change with auditable diff: writerCap: 1 -> 2.",
      }),
    ], {
      writerConflictSafety: safeConflictEvidence(),
      parallelismEvidence: [completeParallelismEvidence()],
      governanceEvents: [rollbackDrillEvidence()],
    });

    expect(result).toEqual({ ok: true, violations: [] });
  });

  test("keeps default writerCap at one unless a governed policy value is explicitly supplied", () => {
    const unchanged = validateSafetyPolicyGovernance(DEFAULT_SAFETY_POLICY, DEFAULT_SAFETY_POLICY);

    expect(unchanged).toEqual({ ok: true, violations: [] });
    expect(DEFAULT_SAFETY_POLICY.writerCap).toBe(1);
  });

  test("governs advisory topology changes as capability metadata without dispatch authority", () => {
    const changedTopology = {
      ...DEFAULT_ADVISORY_ROLE_TOPOLOGY,
      relationships: [
        ...DEFAULT_ADVISORY_ROLE_TOPOLOGY.relationships,
        { from: "reviewer" as const, relation: "advises" as const, to: "writer" as const, description: "Extra advisory metadata." },
      ],
    };
    const missing = validateAdvisoryRoleTopologyGovernance(changedTopology);
    const approved = validateAdvisoryRoleTopologyGovernance(changedTopology, DEFAULT_ADVISORY_ROLE_TOPOLOGY, [
      approvedDecision({
        kind: "capability_change",
        subjectType: "capability",
        subjectId: advisoryRoleTopologyCapabilityId(),
        prompt: advisoryRoleTopologyChangeSummary(changedTopology),
      }),
    ]);

    expect(missing.ok).toBe(false);
    expect(missing.violations[0]).toContain("advisory role topology has unapproved governed capability change");
    expect(approved.ok).toBe(true);
    expect(validateDispatch(reportTask, reviewer).mayDispatch).toBe(true);
  });

  test("requires governed approval when project policy expands authority", () => {
    const loosened: ProjectProfile = {
      ...project,
      safetyPolicy: {
        forbiddenChanges: [],
        allowedRemoteScopeIds: ["planning_report", "implementation"],
        riskDefaults: { remoteScopes: { planning_report: "low" } },
      },
    };
    const missing = validateProjectSafetyPolicyGovernance(project, loosened);
    const approved = validateProjectSafetyPolicyGovernance(project, loosened, [
      approvedDecision({
        kind: "capability_change",
        subjectType: "policy",
        subjectId: projectSafetyPolicyCapabilityId("samantha"),
        prompt: "Approve project policy authority expansion for Samantha.",
      }),
    ]);

    expect(missing.ok).toBe(false);
    expect(missing.violations[0]).toContain("project policy samantha has unapproved governed authority expansion");
    expect(missing.violations[0]).toContain("allowedRemoteScopeIds expanded: implementation");
    expect(missing.violations[0]).toContain("forbiddenChanges removed: docs/private/**");
    expect(missing.violations[0]).toContain("riskDefaults lowered for planning_report: medium -> low");
    expect(approved.ok).toBe(true);
  });
});
