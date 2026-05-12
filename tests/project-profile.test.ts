import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProjectDefaults,
  applyProjectRemoteScopeDefaults,
  classifyRemoteRequest,
  classifyRemoteRequestIntent,
  inferProjectProfile,
  loadProjectProfiles,
  projectRemoteScopeRisk,
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

  test("composes explicit patch arrays with stricter project forbidden changes", () => {
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
      forbiddenChanges: ["node_modules/**", "app/**"],
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

  test("blocks project policy attempts to loosen global authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-profile-policy-loosen-"));
    try {
      await writeFile(
        join(root, "omht.json"),
        JSON.stringify({
          ...profile,
          repoRoot: "$HOME/projects/omht",
          safetyPolicy: {
            writerCap: 2,
            connectorAccess: ["gmail"],
            forbiddenChanges: ["state/**"],
          },
        }),
        "utf8",
      );

      await expect(loadProjectProfiles(root, { env: { HOME: "/Users/byung" }, homeDir: "/Users/byung" })).rejects.toThrow(
        "safetyPolicy.writerCap must not configure global authority",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applies project safety overlay to remote scope selection and risk defaults", () => {
    const strict: ProjectProfile = {
      ...profile,
      safetyPolicy: {
        forbiddenChanges: ["state/**"],
        allowedRemoteScopeIds: ["planning_report"],
        riskDefaults: { remoteScopes: { planning_report: "medium" } },
      },
    };

    expect(() => selectProjectRemoteScope(strict, { requestedScopeId: "implementation" })).toThrow(
      "project policy omht blocks remote scope: implementation",
    );
    const selected = selectProjectRemoteScope(strict, { requestedScopeId: "planning_report" });
    expect(selected?.id).toBe("planning_report");
    expect(selected ? projectRemoteScopeRisk(strict, selected) : undefined).toBe("medium");
    expect(applyProjectRemoteScopeDefaults({}, strict, selected)).toMatchObject({
      forbiddenChanges: ["node_modules/**", "state/**"],
    });
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

  test("classifies negated recovery wording as report-only, not recovery execution", () => {
    expect(classifyRemoteRequest("복구 실행 없이 실패 원인 분석해줘")).toMatchObject({
      intent: "evaluation",
      resultMode: "report",
      safeHandling: "report_only",
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
    expect(() => inferProjectProfile([profile, samantha], { requestText: "samantha와 omht 다음 작업 계획 보고" })).toThrow(
      "ambiguous project profile match: omht, samantha; specify project id",
    );
  });

  test("loads valid multi-profile fixtures in stable project-id order", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-profile-order-"));
    try {
      await writeFile(
        join(root, "z-file.json"),
        JSON.stringify({ ...profile, id: "zeta", repoRoot: "$HOME/projects/zeta", keywords: ["zeta"] }),
        "utf8",
      );
      await writeFile(
        join(root, "a-file.json"),
        JSON.stringify({ ...profile, id: "alpha", repoRoot: "$HOME/projects/alpha", keywords: ["alpha"] }),
        "utf8",
      );

      const loaded = await loadProjectProfiles(root, { env: { HOME: "/Users/byung" }, homeDir: "/Users/byung" });
      expect(loaded.map((item) => item.id)).toEqual(["alpha", "zeta"]);
      expect(loaded.map((item) => item.repoRoot)).toEqual(["/Users/byung/projects/alpha", "/Users/byung/projects/zeta"]);
      expect(loaded.map((item) => item.repoRootExpression)).toEqual(["$HOME/projects/alpha", "$HOME/projects/zeta"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expands host-local profile repo roots and env overrides without changing profile identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-profile-"));
    try {
      await writeFile(join(root, "omht.json"), JSON.stringify({ ...profile, repoRoot: "$HOME/projects/omht" }), "utf8");

      const [homeProfile] = await loadProjectProfiles(root, {
        env: { HOME: "/Users/byung" },
        homeDir: "/Users/byung",
      });
      expect(homeProfile.repoRoot).toBe("/Users/byung/projects/omht");
      expect(homeProfile.id).toBe("omht");
      expect(homeProfile.repoRootExpression).toBe("$HOME/projects/omht");

      const [overrideProfile] = await loadProjectProfiles(root, {
        env: {
          HOME: "/Users/byung",
          SAMANTHA_PROJECT_OMHT_REPO_ROOT: "~/work/omht",
        },
        homeDir: "/Users/byung",
      });
      expect(overrideProfile.repoRoot).toBe("/Users/byung/work/omht");
      expect(overrideProfile.id).toBe("omht");
      expect(overrideProfile.repoRootExpression).toBe("$HOME/projects/omht");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for duplicate project ids and conflicting project keywords", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-profile-invalid-"));
    try {
      await writeFile(
        join(root, "a.json"),
        JSON.stringify({ ...profile, id: "omht", repoRoot: "$HOME/projects/omht", keywords: ["shared"] }),
        "utf8",
      );
      await writeFile(
        join(root, "b.json"),
        JSON.stringify({ ...profile, id: "omht", repoRoot: "$HOME/projects/other", keywords: ["other"] }),
        "utf8",
      );

      await expect(loadProjectProfiles(root, { env: { HOME: "/Users/byung" }, homeDir: "/Users/byung" })).rejects.toThrow(
        "duplicate project id omht",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const keywordRoot = await mkdtemp(join(tmpdir(), "samantha-codex-profile-keyword-"));
    try {
      await writeFile(
        join(keywordRoot, "a.json"),
        JSON.stringify({ ...profile, id: "omht", repoRoot: "$HOME/projects/omht", keywords: ["shared"] }),
        "utf8",
      );
      await writeFile(
        join(keywordRoot, "b.json"),
        JSON.stringify({ ...profile, id: "samantha", repoRoot: "$HOME/projects/samantha", keywords: ["shared"] }),
        "utf8",
      );

      await expect(loadProjectProfiles(keywordRoot, { env: { HOME: "/Users/byung" }, homeDir: "/Users/byung" })).rejects.toThrow(
        "project identifier shared conflicts with project omht",
      );
    } finally {
      await rm(keywordRoot, { recursive: true, force: true });
    }
  });

  test("fails closed for invalid default scope and invalid repo root expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-profile-invalid-scope-"));
    try {
      await writeFile(
        join(root, "omht.json"),
        JSON.stringify({ ...profile, repoRoot: "$HOME/projects/omht", defaultRemoteScopeId: "missing" }),
        "utf8",
      );
      await expect(loadProjectProfiles(root, { env: { HOME: "/Users/byung" }, homeDir: "/Users/byung" })).rejects.toThrow(
        "defaultRemoteScopeId does not match a remote scope: missing",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const pathRoot = await mkdtemp(join(tmpdir(), "samantha-codex-profile-invalid-path-"));
    try {
      await writeFile(join(pathRoot, "omht.json"), JSON.stringify({ ...profile, repoRoot: "projects/omht" }), "utf8");
      await expect(loadProjectProfiles(pathRoot, { env: { HOME: "/Users/byung" }, homeDir: "/Users/byung" })).rejects.toThrow(
        "repoRoot must resolve to an absolute path: projects/omht",
      );
    } finally {
      await rm(pathRoot, { recursive: true, force: true });
    }
  });
});
