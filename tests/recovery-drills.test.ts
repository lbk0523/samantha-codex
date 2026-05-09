import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GovernanceEventRecord } from "../src/lib/governance-event-store";
import {
  createRecoveryDrillOutcomeEvent,
  findRecoveryDrill,
  formatRecoveryDrillReport,
  loadRecoveryDrillCatalog,
  requiredRecoveryDrillFailureModes,
} from "../src/lib/recovery-drills";
import type { ProjectProfile } from "../src/lib/project-profile";

let tmpRoots: string[] = [];

const catalogPath = resolve("references/governance/recovery-drills.json");

const projectProfile: ProjectProfile = {
  schemaVersion: 1,
  id: "samantha",
  repoRoot: "$HOME/projects/samantha-codex",
  keywords: ["samantha"],
  setupCommands: ["bun install"],
  verifyCommands: ["bun typecheck"],
  forbiddenChanges: ["state/**"],
};

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("rollback and recovery drills", () => {
  test("catalog covers required G9 failure modes with canonical-root recovery guidance", async () => {
    const catalog = await loadRecoveryDrillCatalog(catalogPath);

    expect(catalog.drills.map((drill) => drill.failureMode).sort()).toEqual(
      requiredRecoveryDrillFailureModes().sort(),
    );

    for (const drill of catalog.drills) {
      const text = JSON.stringify(drill);
      expect(drill.projectProfileIds).toContain("samantha");
      expect(drill.recoveryGuidance.canonicalRoot.toLowerCase()).toContain("canonical");
      expect(drill.operatorSteps.join("\n")).toContain("drills:record");
      expect(drill.recoveryGuidance.gates.length).toBeGreaterThan(0);
      expect(text).not.toContain(".samantha-worktrees");
      expect(text).not.toMatch(/\/Users\/|\/home\//);
    }
  });

  test("drill reports include roots, docs, guidance, and recorded outcomes", async () => {
    const catalog = await loadRecoveryDrillCatalog(catalogPath);
    const drill = findRecoveryDrill(catalog, "failed-push");
    const event = createRecoveryDrillOutcomeEvent({
      drill,
      outcome: "still_blocked",
      timestamp: "2026-05-09T01:00:00.000Z",
      actor: "bk",
      note: "Remote rejected the push; waiting for BK branch policy decision.",
      related: { runIds: ["run-failed-push"] },
    });

    const report = formatRecoveryDrillReport({ drill, projectProfiles: [projectProfile], events: [event] });

    expect(report).toContain("Recovery Drill: Failed Push");
    expect(report).toContain("Docs: docs/ROLLBACK_AND_RECOVERY_DRILLS.md");
    expect(report).toContain("- samantha: $HOME/projects/samantha-codex");
    expect(report).toContain("outcome=still_blocked");
    expect(report).toContain("cleanup gate");
    expect(report).not.toContain(".samantha-worktrees");
  });

  test("outcome events distinguish fixed, still blocked, and needs BK", async () => {
    const catalog = await loadRecoveryDrillCatalog(catalogPath);
    const drill = findRecoveryDrill(catalog, "stale-approval");

    const fixed = createRecoveryDrillOutcomeEvent({
      drill,
      outcome: "fixed",
      timestamp: "2026-05-09T01:00:00.000Z",
      actor: "bk",
      note: "Stale decision rejected and fresh approval requested.",
    });
    const stillBlocked = createRecoveryDrillOutcomeEvent({
      drill,
      outcome: "still_blocked",
      timestamp: "2026-05-09T01:01:00.000Z",
      actor: "bk",
      note: "Multiple current decisions still need cleanup.",
    });
    const needsBk = createRecoveryDrillOutcomeEvent({
      drill,
      outcome: "needs_bk",
      timestamp: "2026-05-09T01:02:00.000Z",
      actor: "bk",
      note: "BK must decide whether to revise or cancel.",
    });

    expect(fixed).toMatchObject({ kind: "transition_completed", riskClass: "medium" });
    expect(stillBlocked).toMatchObject({ kind: "transition_blocked", riskClass: "high" });
    expect(needsBk).toMatchObject({ kind: "transition_blocked", riskClass: "high" });
    expect(needsBk.summary).toContain("outcome=needs_bk");
  });

  test("CLI records drill outcomes in the append-only governance audit and reports them", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-recovery-drills-"));
    tmpRoots.push(root);
    const state = join(root, "state");

    const record = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "drills:record",
        "failed-verify",
        "--outcome=needs_bk",
        "--note=BK must choose whether to revise the recovery plan.",
        "--timestamp=2026-05-09T01:00:00.000Z",
        "--run-id=run-failed-verify",
        `--state-dir=${state}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [recordStdout, recordStderr, recordExit] = await Promise.all([
      new Response(record.stdout).text(),
      new Response(record.stderr).text(),
      record.exited,
    ]);

    expect({ recordStderr, recordExit }).toMatchObject({ recordStderr: "", recordExit: 0 });
    const event = JSON.parse(recordStdout) as GovernanceEventRecord;
    expect(event).toMatchObject({
      source: { kind: "operator_report", id: "recovery-drill:failed-verify" },
      subject: { type: "run", id: "drill-failed-verify" },
      kind: "transition_blocked",
      riskClass: "high",
      related: { runIds: ["run-failed-verify"] },
    });

    const rawEvents = await readFile(join(state, "governance-events.jsonl"), "utf8");
    expect(rawEvents).toContain(event.id);

    const show = Bun.spawn(
      ["bun", "run", "src/samantha.ts", "drills:show", "failed-verify", `--state-dir=${state}`],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [showStdout, showStderr, showExit] = await Promise.all([
      new Response(show.stdout).text(),
      new Response(show.stderr).text(),
      show.exited,
    ]);

    expect({ showStderr, showExit }).toMatchObject({ showStderr: "", showExit: 0 });
    expect(showStdout).toContain("Recovery Drill: Failed Worker Verification");
    expect(showStdout).toContain("Canonical Project Profile Roots:");
    expect(showStdout).toContain("outcome=needs_bk");
    expect(showStdout).toContain("BK must choose whether to revise the recovery plan.");
  });
});
