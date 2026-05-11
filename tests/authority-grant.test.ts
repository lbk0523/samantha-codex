import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthorityGrantStore,
  BASELINE_REPORT_ONLY_AUTOPILOT_GRANT,
  REPORT_ONLY_AUTOPILOT_ACTIONS,
  checkAuthorityGrant,
} from "../src/lib/authority-grant";
import {
  AutopilotEvidenceStore,
  createAutopilotEvidence,
} from "../src/lib/autopilot-evidence-store";

let tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("authority grants", () => {
  test("baseline report-only autopilot authority allows report work but not write work", async () => {
    const report = checkAuthorityGrant([BASELINE_REPORT_ONLY_AUTOPILOT_GRANT], {
      surface: "remote",
      projectId: "samantha",
      scopeId: "planning_report",
      classification: {
        intent: "planning_report",
        resultMode: "report",
        preferredAgentId: "codex-spec",
        safeHandling: "report_only",
        reasons: ["planning/report phrase matched"],
      },
      requiredActions: REPORT_ONLY_AUTOPILOT_ACTIONS,
      at: "2026-05-11T01:00:00.000Z",
    });

    expect(report).toMatchObject({
      allowed: true,
      grant: { id: "authority-grant-remote-report-only-autopilot-baseline" },
    });

    const write = checkAuthorityGrant([BASELINE_REPORT_ONLY_AUTOPILOT_GRANT], {
      surface: "remote",
      projectId: "samantha",
      scopeId: "implementation",
      classification: {
        intent: "implementation",
        resultMode: "write",
        preferredAgentId: "codex-worker",
        safeHandling: "implementation_plan",
        reasons: ["implementation wording matched"],
      },
      requiredActions: REPORT_ONLY_AUTOPILOT_ACTIONS,
      at: "2026-05-11T01:00:00.000Z",
    });

    expect(write).toMatchObject({ allowed: false, reason: "request is not report-only" });
  });

  test("stores authority grants and autopilot evidence as policy/evidence records", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-authority-"));
    tmpRoots.push(root);
    const grantsPath = join(root, "state", "authority-grants.jsonl");
    const evidencePath = join(root, "state", "autopilot-evidence.jsonl");
    const grantStore = new AuthorityGrantStore(grantsPath);
    const evidenceStore = new AutopilotEvidenceStore(evidencePath);

    await grantStore.append({
      ...BASELINE_REPORT_ONLY_AUTOPILOT_GRANT,
      id: "authority-grant-test",
      approval: { type: "bk_decision", decisionId: "decision-authority-test" },
    });
    await evidenceStore.append(createAutopilotEvidence({
      requestId: "request-readonly-plan",
      planId: "plan-readonly-plan",
      authorityGrantId: "authority-grant-test",
      projectId: "samantha",
      scopeId: "planning_report",
      resultMode: "report",
      startedAt: "2026-05-11T01:00:00.000Z",
      completedAt: "2026-05-11T01:01:00.000Z",
      transitions: ["remote_intake", "classify_request", "run_readonly_plan", "record_autopilot_evidence"],
      endpoint: "result",
      status: "completed",
      actionIds: ["action-report"],
      runIds: ["run-report"],
      summary: "Report-only autopilot completed.",
    }));

    expect(await grantStore.list()).toMatchObject([
      { id: "authority-grant-test", approval: { type: "bk_decision" } },
    ]);
    expect(await evidenceStore.list()).toMatchObject([
      {
        requestId: "request-readonly-plan",
        authorityGrantId: "authority-grant-test",
        endpoint: "result",
        status: "completed",
      },
    ]);
    expect(await readFile(grantsPath, "utf8")).toContain("authority-grant-test");
    expect(await readFile(evidencePath, "utf8")).toContain("autopilot-evidence-");
  });
});
