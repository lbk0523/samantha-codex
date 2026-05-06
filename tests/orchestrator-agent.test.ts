import { describe, expect, test } from "bun:test";
import { buildOrchestratorPrompt } from "../src/lib/orchestrator-agent";
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
  });
});
