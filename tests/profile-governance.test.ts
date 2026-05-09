import { describe, expect, test } from "bun:test";
import type { AgentProfile, SafetyPolicy, TaskSpec } from "../src/lib/contracts";
import { createDecisionItem, type DecisionItem } from "../src/lib/decision-store";
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
    expect(validateSafetyPolicyGovernance(changedPolicy, DEFAULT_SAFETY_POLICY, [
      approvedDecision({
        kind: "capability_change",
        subjectType: "policy",
        subjectId: safetyPolicyCapabilityId(),
        prompt: "Approve safety policy writerCap change.",
      }),
    ]).ok).toBe(true);
  });
});
