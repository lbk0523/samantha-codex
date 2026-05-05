import { describe, expect, test } from "bun:test";
import { applyProjectDefaults, type ProjectProfile } from "../src/lib/project-profile";

const profile: ProjectProfile = {
  schemaVersion: 1,
  id: "omht",
  repoRoot: "/repo/omht",
  setupCommands: ["bun install"],
  verifyCommands: ["bun typecheck"],
  forbiddenChanges: ["node_modules/**"],
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
});
