import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkItemAncestry } from "../src/lib/ancestry";
import { CeoReportStore, type CeoReportRecord } from "../src/lib/ceo-report-store";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { buildDecisionHistorySummary } from "../src/lib/decision-history-summary";
import { createDecisionItem } from "../src/lib/decision-store";
import { GovernanceEventStore, createGovernanceEvent } from "../src/lib/governance-event-store";
import type { ProjectBriefRecord } from "../src/lib/project-brief-store";
import { buildSearchableContext, searchContext } from "../src/lib/context-search";
import type { WorkerRunLog } from "../src/lib/run-log";

let tmpRoots: string[] = [];

const ancestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "samantha",
  goalId: "goal-memory",
  workItemId: "work-m6",
};

const otherAncestry: WorkItemAncestry = {
  mode: "assigned",
  projectId: "omht",
  goalId: "goal-omht",
  workItemId: "work-omht",
};

const task: TaskSpec = {
  id: "task-report-context",
  ancestry,
  title: "Review memory context",
  targetAgent: "codex-reviewer",
  resultMode: "report",
  targetFiles: [],
  forbiddenChanges: ["state/**"],
  verifyCommands: [],
  instructions: "Review source-backed context.",
  status: "completed",
};

const agent: AgentProfile = {
  id: "codex-reviewer",
  role: "reviewer",
  model: "gpt-5.5",
  writerClass: "non-writer",
  worktreePolicy: "none",
  mergePolicy: "none",
  skillPolicy: { requiredBundles: [], blockedSkills: [] },
};

function reportRunLog(input: Partial<WorkerRunLog> = {}): WorkerRunLog {
  return {
    schemaVersion: 1,
    ancestry,
    runId: "run-report-context",
    startedAt: "2026-05-10T01:00:00.000Z",
    finishedAt: "2026-05-10T01:01:00.000Z",
    task,
    agent,
    input: { repoRoot: "/repo/samantha", allocate: false, execute: true },
    result: {
      preparation: {
        taskId: task.id,
        agentId: agent.id,
        worktreePath: "/worktree",
        codex: { prompt: "prompt", command: ["codex", "exec"] },
      },
      setupResults: [],
      command: {
        command: ["codex", "exec"],
        exitCode: 0,
        stdout: `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "Artifact: use compact citations for Phase 8 search.",
          },
        })}\n`,
        stderr: "",
      },
      evaluation: {
        pass: true,
        harness: { status: "pass", note: "report-only", commit: "" },
        changedFiles: [],
        scopeViolations: [],
        verifyResults: [],
      },
      pass: true,
    },
    ...input,
  };
}

function projectBrief(): ProjectBriefRecord {
  return {
    schemaVersion: 1,
    id: "brief-samantha-active",
    kind: "project_brief",
    projectId: "samantha",
    status: "active",
    createdAt: "2026-05-10T01:02:00.000Z",
    updatedAt: "2026-05-10T01:03:00.000Z",
    reviewedAt: "2026-05-10T01:04:00.000Z",
    reviewDecisionId: "decision-review-brief",
    ancestry,
    sections: {
      productContext: [
        {
          text: "Samantha is a deterministic CEO office.",
          citations: [{ kind: "operator_report", id: "operator-report-context", ancestry }],
        },
      ],
      currentStrategy: [
        {
          text: "Use source-backed compact snippets before bounded planning.",
          citations: [{ kind: "decision", id: "decision-memory-strategy", ancestry }],
        },
      ],
      keyConstraints: [],
      knownRisks: [
        {
          text: "Search results must not mutate memory or source ledgers.",
          citations: [{ kind: "governance_event", id: "gov-event-memory-risk", ancestry }],
        },
      ],
      openQuestions: [],
    },
  };
}

function ceoReport(input: Partial<CeoReportRecord> = {}): CeoReportRecord {
  return {
    schemaVersion: 1,
    id: "ceo-report-memory-context",
    ancestry,
    kind: "ceo_notify",
    generatedAt: "2026-05-10T01:05:00.000Z",
    outboxFile: "remote-20260510-010500-ceo-notify-stable.md",
    outboxPath: "/outbox/remote-20260510-010500-ceo-notify-stable.md",
    deliveryStatePath: "/state/telegram-replies.json",
    overall: "idle",
    nextActionKind: "none",
    decisionCount: 0,
    activeCount: 1,
    blockedCount: 0,
    riskCount: 1,
    ...input,
  };
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("searchable context surface", () => {
  test("retrieves compact citation-backed context by project, goal, work-item, memory kind, and source id", () => {
    const decision = {
      ...createDecisionItem({
        ancestry,
        title: "Use derived memory summaries",
        prompt: "Should search expose derived summaries only?",
        kind: "manual",
        source: "system",
        subject: { type: "policy", id: "policy-memory-search" },
        createdAt: "2026-05-10T01:06:00.000Z",
      }),
      id: "decision-memory-strategy",
      status: "resolved" as const,
      updatedAt: "2026-05-10T01:07:00.000Z",
      resolvedAt: "2026-05-10T01:07:00.000Z",
      resolvedBy: "bk" as const,
      resolution: "approved" as const,
      resolutionNote: "Use derived search context only.",
    };
    const governanceEvent = createGovernanceEvent({
      id: "gov-event-memory-risk",
      ancestry,
      timestamp: "2026-05-10T01:08:00.000Z",
      actor: "system",
      source: { kind: "decision", id: decision.id },
      subject: { type: "memory", id: "context-search" },
      kind: "risk_classified",
      riskClass: "low",
      summary: "Context search is read-only and citation-backed.",
      related: { decisionIds: [decision.id] },
    });
    const summary = buildDecisionHistorySummary({
      decisions: [decision],
      governanceEvents: [governanceEvent],
      generatedAt: "2026-05-10T01:09:00.000Z",
      scope: { projectId: "samantha", goalId: "goal-memory", workItemId: "work-m6" },
    });
    const input = {
      ceoReports: [ceoReport(), ceoReport({ id: "ceo-report-omht", ancestry: otherAncestry })],
      operatorReports: [{
        id: "operator-report-context",
        title: "Operator memory review",
        text: "Operator report says compact citation search is enough.",
        generatedAt: "2026-05-10T01:10:00.000Z",
        ancestry,
      }],
      runLogs: [reportRunLog()],
      decisionSummaries: [summary],
      projectBriefs: [projectBrief()],
      governanceEvents: [governanceEvent],
    };

    const byProject = searchContext(input, { projectId: "samantha" });
    expect(byProject.results.every((result) => result.ancestry?.mode === "assigned" && result.ancestry.projectId === "samantha")).toBe(true);
    expect(byProject.results.map((result) => result.id)).not.toContain("ceo-report-omht");

    const byGoal = searchContext(input, { goalId: "goal-memory" });
    expect(byGoal.results.length).toBeGreaterThan(0);
    expect(byGoal.results.every((result) => result.ancestry?.mode === "assigned" && result.ancestry.goalId === "goal-memory")).toBe(true);

    const byWorkItem = searchContext(input, { workItemId: "work-m6" });
    expect(byWorkItem.results.length).toBeGreaterThan(0);
    expect(byWorkItem.results.every((result) => result.ancestry?.mode === "assigned" && result.ancestry.workItemId === "work-m6")).toBe(true);

    const knownRisks = searchContext(input, { memoryKind: "known_risk" });
    expect(knownRisks.results).toHaveLength(1);
    expect(knownRisks.results[0]).toMatchObject({
      kind: "project_brief",
      sourceKind: "project_brief",
      memoryKind: "known_risk",
      status: "ok",
    });
    expect(knownRisks.results[0].snippet).toContain("must not mutate memory");
    expect(knownRisks.results[0].citations).toContainEqual({ kind: "governance_event", id: "gov-event-memory-risk", ancestry });

    const bySource = searchContext(input, { source: { kind: "decision", id: decision.id } });
    expect(bySource.results.some((result) => result.kind === "decision_summary")).toBe(true);
    expect(bySource.results.some((result) => result.citations.some((citation) => citation.kind === "decision" && citation.id === decision.id))).toBe(true);

    const artifact = searchContext(input, { memoryKind: "artifact_reference", text: "compact citations" });
    expect(artifact.results).toHaveLength(1);
    expect(artifact.results[0]).toMatchObject({
      kind: "report_artifact",
      sourceKind: "run_log",
      sourceId: "run-report-context",
      status: "ok",
    });
    expect(artifact.results[0].snippet.length).toBeLessThanOrEqual(283);
    expect(artifact.results[0].citations).toContainEqual({ kind: "run_log", id: "run-report-context", ancestry });
  });

  test("reports missing artifacts and malformed records as searchable results", () => {
    const missingRunLog = reportRunLog({
      runId: "run-report-missing",
      result: {
        ...reportRunLog().result,
        command: { command: ["codex", "exec"], exitCode: 0, stdout: "", stderr: "" },
        evaluation: {
          pass: true,
          changedFiles: [],
          scopeViolations: [],
          verifyResults: [],
        },
      },
    });
    const response = searchContext({
      runLogs: [missingRunLog],
      governanceEvents: [{ schemaVersion: 1, summary: "missing id" }],
      reportArtifacts: [{
        id: "artifact-missing-preview",
        source: { kind: "operator_report", id: "operator-report-missing" },
        missingReason: "Artifact preview was declared but not available.",
        ancestry,
      }],
    });

    expect(response.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "missing_artifact",
        status: "missing",
        sourceKind: "report_artifact",
        sourceId: "artifact-missing-preview",
      }),
      expect.objectContaining({
        kind: "missing_artifact",
        status: "missing",
        sourceKind: "run_log",
        sourceId: "run-report-missing",
      }),
      expect.objectContaining({
        kind: "malformed_record",
        status: "malformed",
        sourceKind: "governance_event",
        snippet: "governance event is missing schemaVersion 1, id, source, or subject",
      }),
    ]));
  });

  test("search is read-only against source records and backing stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-context-search-"));
    tmpRoots.push(root);
    const ceoPath = join(root, "state", "ceo-reports.jsonl");
    const governancePath = join(root, "state", "governance-events.jsonl");
    await mkdir(dirname(ceoPath), { recursive: true });

    const ceoStore = new CeoReportStore(ceoPath);
    const governanceStore = new GovernanceEventStore(governancePath);
    const report = ceoReport();
    const event = createGovernanceEvent({
      id: "gov-event-read-only",
      ancestry,
      timestamp: "2026-05-10T01:11:00.000Z",
      actor: "system",
      source: { kind: "operator_report", id: "operator-report-context" },
      subject: { type: "memory", id: "context-search" },
      kind: "transition_completed",
      riskClass: "low",
      summary: "Read-only search verification.",
    });
    await ceoStore.append(report);
    await governanceStore.append(event);
    const ceoBefore = await readFile(ceoPath, "utf8");
    const governanceBefore = await readFile(governancePath, "utf8");
    const input = {
      ceoReports: await ceoStore.list(),
      governanceEvents: await governanceStore.list(),
      projectBriefs: [projectBrief()],
      runLogs: [reportRunLog()],
    };
    const snapshotBefore = JSON.stringify(input);

    const results = buildSearchableContext(input);
    const response = searchContext(input, { projectId: "samantha", sourceId: "operator-report-context" });

    expect(results.length).toBeGreaterThan(0);
    expect(response.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(input)).toBe(snapshotBefore);
    expect(await readFile(ceoPath, "utf8")).toBe(ceoBefore);
    expect(await readFile(governancePath, "utf8")).toBe(governanceBefore);
  });
});
