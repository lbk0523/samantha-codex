import { describe, expect, test } from "bun:test";
import {
  applyProjectDefaults,
  applyProjectRemoteScopeDefaults,
  selectProjectRemoteScope,
  type ProjectProfile,
} from "../src/lib/project-profile";

const profile: ProjectProfile = {
  schemaVersion: 1,
  id: "omht",
  repoRoot: "/repo/omht",
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

  test("uses the default remote scope when no keyword matches", () => {
    expect(selectProjectRemoteScope(profile, { requestText: "unknown request" })?.id).toBe("implementation");
  });

  test("matches Korean planning and report keywords", () => {
    expect(selectProjectRemoteScope(profile, { requestText: "다음 작업 계획 보고" })?.id).toBe("planning_report");
  });
});
