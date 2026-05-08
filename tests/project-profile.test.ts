import { describe, expect, test } from "bun:test";
import {
  applyProjectDefaults,
  applyProjectRemoteScopeDefaults,
  classifyRemoteRequest,
  classifyRemoteRequestIntent,
  inferProjectProfile,
  selectProjectRemoteScope,
  type ProjectProfile,
} from "../src/lib/project-profile";

const profile: ProjectProfile = {
  schemaVersion: 1,
  id: "omht",
  repoRoot: "/repo/omht",
  keywords: ["omht", "ohmt"],
  setupCommands: ["bun install"],
  verifyCommands: ["bun typecheck"],
  forbiddenChanges: ["node_modules/**"],
  defaultRemoteScopeId: "implementation",
  remoteScopes: [
    {
      id: "implementation",
      label: "Implementation",
      description: "Code changes.",
      risk: "medium",
      resultMode: "write",
      targetFiles: ["app/**", "lib/**"],
      keywords: ["fix"],
      planSteps: ["Read code.", "Implement."],
      successCriteria: ["Verification passes."],
    },
    {
      id: "planning_report",
      label: "Planning report",
      description: "Document changes.",
      risk: "low",
      resultMode: "report",
      targetFiles: ["docs/**"],
      keywords: ["report", "보고"],
      planSteps: ["Read docs.", "Write report."],
      successCriteria: ["Report is actionable."],
    },
  ],
};

describe("project profiles", () => {
  test("apply default setup, verify, and forbidden changes to draft patches", () => {
    expect(applyProjectDefaults({ targetFiles: ["tests/unit/foo.test.ts"] }, profile)).toEqual({
      projectId: "omht",
      repoRoot: "/repo/omht",
      targetFiles: ["tests/unit/foo.test.ts"],
      forbiddenChanges: ["node_modules/**"],
      setupCommands: ["bun install"],
      verifyCommands: ["bun typecheck"],
    });
  });

  test("preserves explicit patch arrays over defaults", () => {
    expect(
      applyProjectDefaults(
        {
          setupCommands: ["bun install --frozen-lockfile"],
          verifyCommands: ["bun test tests/unit/foo.test.ts"],
          forbiddenChanges: ["app/**"],
        },
        profile,
      ),
    ).toMatchObject({
      setupCommands: ["bun install --frozen-lockfile"],
      verifyCommands: ["bun test tests/unit/foo.test.ts"],
      forbiddenChanges: ["app/**"],
    });
  });

  test("selects and applies remote scope defaults", () => {
    const scope = selectProjectRemoteScope(profile, { requestText: "write report" });

    expect(scope?.id).toBe("planning_report");
    expect(applyProjectRemoteScopeDefaults({}, profile, scope)).toMatchObject({
      projectId: "omht",
      repoRoot: "/repo/omht",
      targetFiles: ["docs/**"],
      forbiddenChanges: ["node_modules/**"],
      setupCommands: ["bun install"],
      verifyCommands: ["bun typecheck"],
      resultMode: "report",
    });
  });

  test("falls back to report scope when no deterministic write intent matches", () => {
    expect(selectProjectRemoteScope(profile, { requestText: "unknown request" })?.id).toBe("planning_report");
    expect(selectProjectRemoteScope(profile, { requestText: "대충 알아서 수정해줘" })?.id).toBe("planning_report");
  });

  test("matches Korean planning and report keywords", () => {
    expect(selectProjectRemoteScope(profile, { requestText: "다음 작업 계획 보고" })?.id).toBe("planning_report");
  });

  test("classifies Korean planning and implementation intent before keyword fallback", () => {
    expect(classifyRemoteRequestIntent("다음 작업 계획 보고")).toBe("planning_report");
    expect(classifyRemoteRequestIntent("구현 계획 보고")).toBe("planning_report");
    expect(classifyRemoteRequestIntent("다음 작업 구현")).toBe("implementation");
    expect(classifyRemoteRequestIntent("계획대로 구현 시작")).toBe("implementation");
    expect(selectProjectRemoteScope(profile, { requestText: "다음 작업 구현" })?.id).toBe("implementation");
  });

  test("classifies mixed Korean and English request intents deterministically", () => {
    expect(classifyRemoteRequest("classifier 구현해줘").intent).toBe("implementation");
    expect(classifyRemoteRequest("수정하지 말고 planning report만 작성해줘").intent).toBe("planning_report");
    expect(classifyRemoteRequest("Review 리스크만 검토해줘 no code changes").intent).toBe("review");
    expect(classifyRemoteRequest("요구사항 spec acceptance criteria 정리해줘").intent).toBe("spec");
    expect(classifyRemoteRequest("테스트 전략 evaluate 해줘 without editing").intent).toBe("evaluation");
    expect(classifyRemoteRequest("failed plan 복구해줘").intent).toBe("recovery");
    expect(classifyRemoteRequest("대충 알아서 수정해줘").intent).toBe("ambiguity_heavy");
    expect(classifyRemoteRequest("unknown request")).toMatchObject({
      intent: "ambiguity_heavy",
      resultMode: "report",
      safeHandling: "questions_first",
    });
  });

  test("does not fall back to unsafe implementation when only write scopes exist", () => {
    const writeOnly: ProjectProfile = {
      ...profile,
      remoteScopes: [profile.remoteScopes![0]],
    };

    expect(selectProjectRemoteScope(writeOnly, { requestText: "unknown request" })).toBeUndefined();
    expect(selectProjectRemoteScope(writeOnly, { requestText: "리뷰만 해줘" })).toBeUndefined();
    expect(selectProjectRemoteScope(writeOnly, { requestText: "버그 수정해줘" })?.id).toBe("implementation");
  });

  test("infers project profiles from project keywords", () => {
    const samantha: ProjectProfile = {
      ...profile,
      id: "samantha",
      repoRoot: "/repo/samantha",
      keywords: ["samantha", "samantha-codex", "사만다"],
    };

    expect(inferProjectProfile([profile, samantha], { requestText: "samantha 프로젝트 대시보드 개선 계획 보고" })?.id).toBe("samantha");
    expect(inferProjectProfile([profile, samantha], { requestText: "ohmt 프로젝트 작업 재개 계획 보고" })?.id).toBe("omht");
    expect(inferProjectProfile([profile, samantha], { requestText: "다음 작업 계획 보고" })).toBeUndefined();
  });
});
