import type { WorkItemAncestry } from "./ancestry";
import type { DecisionItem, DecisionResolution, DecisionSubject } from "./decision-store";
import type { GovernanceEventRecord } from "./governance-event-store";
import type { MemoryClaimKind } from "./memory-taxonomy";
import type { OrchestratorPlanRecord } from "./orchestrator-store";

export type DecisionHistoryCitationKind = "decision" | "governance_event" | "ceo_report" | "operator_report" | "orchestrator_plan";
export type DecisionHistoryAuthority = "bk_decision" | "derived_summary";
export type DecisionHistoryGuidanceStatus =
  | "active"
  | "pending"
  | "archived"
  | "rejected"
  | "needs_revision"
  | "canceled"
  | "superseded"
  | "reversed"
  | "stale";

export interface DecisionHistoryScope {
  projectId?: string;
  goalId?: string;
  workItemId?: string;
}

export interface DecisionHistoryCitation {
  kind: DecisionHistoryCitationKind;
  id: string;
  ancestry?: WorkItemAncestry;
}

export interface DecisionHistoryReportSource {
  id: string;
  ancestry?: WorkItemAncestry;
  generatedAt?: string;
  kind?: string;
  reportKind?: "ceo_report" | "operator_report";
}

export interface DecisionHistorySummaryItem {
  id: string;
  sourceDecisionId: string;
  sourceDecisionIds: string[];
  sourceGovernanceEventIds: string[];
  sourceReportIds: string[];
  sourcePlanIds: string[];
  citations: DecisionHistoryCitation[];
  ancestry?: WorkItemAncestry;
  subject?: DecisionSubject;
  decisionKind: DecisionItem["kind"];
  authority: DecisionHistoryAuthority;
  claimKind: MemoryClaimKind;
  guidanceStatus: DecisionHistoryGuidanceStatus;
  activeGuidance: boolean;
  title: string;
  summary: string;
  resolution?: DecisionResolution;
  resolvedBy?: DecisionItem["resolvedBy"];
  resolvedAt?: string;
  staleReasons: string[];
}

export interface DecisionHistoryRisk {
  kind: "conflicting_prior_decisions" | "inactive_decision";
  severity: "risk" | "ambiguity";
  summary: string;
  sourceDecisionIds: string[];
  sourceGovernanceEventIds: string[];
  citations: DecisionHistoryCitation[];
  ancestry?: WorkItemAncestry;
}

export interface DecisionHistorySummary {
  schemaVersion: 1;
  kind: "decision_history_summary";
  generatedAt: string;
  scope?: DecisionHistoryScope;
  active: DecisionHistorySummaryItem[];
  inactive: DecisionHistorySummaryItem[];
  risks: DecisionHistoryRisk[];
  citations: DecisionHistoryCitation[];
}

export interface DecisionHistorySummaryInput {
  decisions: DecisionItem[];
  governanceEvents?: GovernanceEventRecord[];
  reports?: DecisionHistoryReportSource[];
  plans?: OrchestratorPlanRecord[];
  generatedAt?: string;
  scope?: DecisionHistoryScope;
}

function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function subjectKey(subject: DecisionSubject | undefined): string | undefined {
  return subject ? `${subject.type}:${subject.id}` : undefined;
}

function scopeMatchesAncestry(scope: DecisionHistoryScope | undefined, ancestry: WorkItemAncestry | undefined): boolean {
  if (!scope) return true;
  if (!ancestry || ancestry.mode !== "assigned") return false;
  if (scope.projectId && ancestry.projectId !== scope.projectId) return false;
  if (scope.goalId && ancestry.goalId !== scope.goalId) return false;
  if (scope.workItemId && ancestry.workItemId !== scope.workItemId) return false;
  return true;
}

function sameAssignedAncestry(left: WorkItemAncestry | undefined, right: WorkItemAncestry | undefined): boolean {
  if (!left || !right) return false;
  if (left.mode !== "assigned" || right.mode !== "assigned") return false;
  return left.projectId === right.projectId && left.goalId === right.goalId && left.workItemId === right.workItemId;
}

function governedSubjectKey(decision: DecisionItem): string | undefined {
  const subject = decision.subject;
  if (!subject) return undefined;
  const typeByDecisionSubject: Partial<Record<DecisionSubject["type"], string>> = {
    orchestrator_plan: "plan",
    remote_action: "action",
    task: "task",
    run: "run",
    agent_profile: "agent_profile",
    capability: "capability",
    policy: "policy",
  };
  const type = typeByDecisionSubject[subject.type];
  return type ? `${type}:${subject.id}` : undefined;
}

function eventMatchesDecision(event: GovernanceEventRecord, decision: DecisionItem): boolean {
  if (event.related?.decisionIds?.includes(decision.id)) return true;
  if (event.source.kind === "decision" && event.source.id === decision.id) return true;
  return governedSubjectKey(decision) === `${event.subject.type}:${event.subject.id}`;
}

function reportMatchesDecision(report: DecisionHistoryReportSource, decision: DecisionItem, scope: DecisionHistoryScope | undefined): boolean {
  if (scope) return scopeMatchesAncestry(scope, report.ancestry);
  return sameAssignedAncestry(report.ancestry, decision.ancestry);
}

function reportCitationKind(report: DecisionHistoryReportSource): "ceo_report" | "operator_report" {
  if (report.reportKind) return report.reportKind;
  return report.kind === "operator_report" ? "operator_report" : "ceo_report";
}

function planForDecision(decision: DecisionItem, plans: OrchestratorPlanRecord[]): OrchestratorPlanRecord | undefined {
  if (decision.subject?.type !== "orchestrator_plan") return undefined;
  return plans.find((plan) => plan.id === decision.subject?.id);
}

function decisionResolutionStatus(resolution: DecisionResolution | undefined): DecisionHistoryGuidanceStatus | undefined {
  if (resolution === "rejected") return "rejected";
  if (resolution === "needs_revision") return "needs_revision";
  if (resolution === "canceled") return "canceled";
  return undefined;
}

function isBkActiveResolution(decision: DecisionItem): boolean {
  return decision.status === "resolved" && decision.resolvedBy === "bk" && (decision.resolution === "approved" || decision.resolution === "answered");
}

function laterSameSubjectDecisions(decision: DecisionItem, decisions: DecisionItem[]): DecisionItem[] {
  const key = subjectKey(decision.subject);
  if (!key) return [];
  const decisionTime = timestamp(decision.resolvedAt ?? decision.updatedAt ?? decision.createdAt);
  return decisions.filter((candidate) => {
    if (candidate.id === decision.id || subjectKey(candidate.subject) !== key) return false;
    return timestamp(candidate.resolvedAt ?? candidate.updatedAt ?? candidate.createdAt) > decisionTime;
  });
}

function reversalDecision(decision: DecisionItem, decisions: DecisionItem[]): DecisionItem | undefined {
  if (!isBkActiveResolution(decision)) return undefined;
  return laterSameSubjectDecisions(decision, decisions).find(
    (candidate) =>
      candidate.status === "resolved" &&
      candidate.resolvedBy === "bk" &&
      (candidate.resolution === "rejected" || candidate.resolution === "needs_revision" || candidate.resolution === "canceled"),
  );
}

function supersedingDecision(decision: DecisionItem, decisions: DecisionItem[]): DecisionItem | undefined {
  if (!isBkActiveResolution(decision)) return undefined;
  return laterSameSubjectDecisions(decision, decisions).find(isBkActiveResolution);
}

function statusForDecision(input: {
  decision: DecisionItem;
  decisions: DecisionItem[];
  plan?: OrchestratorPlanRecord;
}): { status: DecisionHistoryGuidanceStatus; staleReasons: string[]; relatedDecision?: DecisionItem } {
  const { decision, decisions, plan } = input;
  const staleReasons: string[] = [];

  if (decision.status === "archived") {
    if (decision.archiveReason) staleReasons.push(decision.archiveReason);
    return { status: "archived", staleReasons };
  }
  if (decision.status === "pending") return { status: "pending", staleReasons: ["BK has not resolved this decision."] };

  const resolutionStatus = decisionResolutionStatus(decision.resolution);
  if (resolutionStatus) {
    if (decision.resolutionNote) staleReasons.push(decision.resolutionNote);
    return { status: resolutionStatus, staleReasons };
  }

  if (plan?.status === "superseded") {
    staleReasons.push(`Subject plan ${plan.id} was superseded.`);
    return { status: "superseded", staleReasons };
  }

  const reversedBy = reversalDecision(decision, decisions);
  if (reversedBy) {
    staleReasons.push(`Later BK decision ${reversedBy.id} reversed this decision.`);
    return { status: "reversed", staleReasons, relatedDecision: reversedBy };
  }

  const supersededBy = supersedingDecision(decision, decisions);
  if (supersededBy) {
    staleReasons.push(`Later BK decision ${supersededBy.id} superseded this decision.`);
    return { status: "superseded", staleReasons, relatedDecision: supersededBy };
  }

  if (decision.kind === "orchestrator_plan_approval") {
    if (!plan) {
      staleReasons.push(`Subject plan ${decision.subject?.id ?? "unknown"} is missing.`);
      return { status: "stale", staleReasons };
    }
    if (plan.status !== "planned" && plan.status !== "approved") {
      staleReasons.push(`Subject plan ${plan.id} is ${plan.status}.`);
      return { status: "stale", staleReasons };
    }
  }

  if (isBkActiveResolution(decision)) return { status: "active", staleReasons };

  staleReasons.push("Decision is a derived or unresolved summary, not a BK-approved source of authority.");
  return { status: "stale", staleReasons };
}

function decisionSummaryText(decision: DecisionItem, status: DecisionHistoryGuidanceStatus): string {
  const prefix = decision.resolvedBy === "bk" ? "BK decision" : "Derived decision prompt";
  const note = oneLine(decision.resolutionNote) || oneLine(decision.prompt);
  return `${prefix}: ${decision.title}. status=${status}${decision.resolution ? ` resolution=${decision.resolution}` : ""}${note ? ` note=${note}` : ""}`;
}

function uniqueCitations(citations: DecisionHistoryCitation[]): DecisionHistoryCitation[] {
  const seen = new Set<string>();
  const unique: DecisionHistoryCitation[] = [];
  for (const citation of citations) {
    const key = `${citation.kind}:${citation.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }
  return unique;
}

function buildItem(input: {
  decision: DecisionItem;
  decisions: DecisionItem[];
  governanceEvents: GovernanceEventRecord[];
  reports: DecisionHistoryReportSource[];
  plans: OrchestratorPlanRecord[];
  scope?: DecisionHistoryScope;
}): DecisionHistorySummaryItem {
  const plan = planForDecision(input.decision, input.plans);
  const status = statusForDecision({ decision: input.decision, decisions: input.decisions, plan });
  const events = input.governanceEvents.filter((event) => eventMatchesDecision(event, input.decision));
  const reports = input.reports.filter((report) => reportMatchesDecision(report, input.decision, input.scope));
  const relatedDecisionIds = status.relatedDecision ? [status.relatedDecision.id] : [];
  const sourceDecisionIds = [input.decision.id, ...relatedDecisionIds];
  const sourcePlanIds = plan ? [plan.id] : [];
  const citations = uniqueCitations([
    { kind: "decision", id: input.decision.id, ancestry: input.decision.ancestry },
    ...relatedDecisionIds.map((id) => ({ kind: "decision" as const, id, ancestry: input.decisions.find((decision) => decision.id === id)?.ancestry })),
    ...events.map((event) => ({ kind: "governance_event" as const, id: event.id, ancestry: event.ancestry })),
    ...reports.map((report) => ({ kind: reportCitationKind(report), id: report.id, ancestry: report.ancestry })),
    ...sourcePlanIds.map((id) => ({ kind: "orchestrator_plan" as const, id, ancestry: plan?.ancestry })),
  ]);

  return {
    id: `decision-summary:${input.decision.id}`,
    sourceDecisionId: input.decision.id,
    sourceDecisionIds,
    sourceGovernanceEventIds: events.map((event) => event.id),
    sourceReportIds: reports.map((report) => report.id),
    sourcePlanIds,
    citations,
    ancestry: input.decision.ancestry ?? plan?.ancestry,
    subject: input.decision.subject,
    decisionKind: input.decision.kind,
    authority: input.decision.resolvedBy === "bk" ? "bk_decision" : "derived_summary",
    claimKind: input.decision.resolvedBy === "bk" ? "bk_decision" : "llm_summary",
    guidanceStatus: status.status,
    activeGuidance: status.status === "active",
    title: input.decision.title,
    summary: decisionSummaryText(input.decision, status.status),
    resolution: input.decision.resolution,
    resolvedBy: input.decision.resolvedBy,
    resolvedAt: input.decision.resolvedAt,
    staleReasons: status.staleReasons,
  };
}

function conflictRisks(items: DecisionHistorySummaryItem[], governanceEvents: GovernanceEventRecord[]): DecisionHistoryRisk[] {
  const bySubject = new Map<string, DecisionHistorySummaryItem[]>();
  for (const item of items) {
    const key = subjectKey(item.subject);
    if (!key || item.authority !== "bk_decision") continue;
    bySubject.set(key, [...(bySubject.get(key) ?? []), item]);
  }

  const risks: DecisionHistoryRisk[] = [];
  for (const [key, subjectItems] of bySubject.entries()) {
    const active = subjectItems.filter((item) => item.activeGuidance);
    const inactiveContradictions = subjectItems.filter((item) =>
      item.guidanceStatus === "rejected" ||
      item.guidanceStatus === "needs_revision" ||
      item.guidanceStatus === "canceled" ||
      item.guidanceStatus === "reversed",
    );
    if (active.length === 0 || inactiveContradictions.length === 0) continue;

    const sourceDecisionIds = [...new Set([...active, ...inactiveContradictions].flatMap((item) => item.sourceDecisionIds))];
    const eventIds = governanceEvents
      .filter((event) => sourceDecisionIds.some((id) => event.related?.decisionIds?.includes(id) || (event.source.kind === "decision" && event.source.id === id)))
      .map((event) => event.id);
    const citations = uniqueCitations([
      ...sourceDecisionIds.map((id) => ({ kind: "decision" as const, id })),
      ...eventIds.map((id) => ({ kind: "governance_event" as const, id })),
    ]);
    risks.push({
      kind: "conflicting_prior_decisions",
      severity: "ambiguity",
      summary: `Conflicting BK decisions exist for ${key}; planner must surface the ambiguity instead of treating one as silent policy.`,
      sourceDecisionIds,
      sourceGovernanceEventIds: eventIds,
      citations,
      ancestry: active[0]?.ancestry ?? inactiveContradictions[0]?.ancestry,
    });
  }
  return risks;
}

function inactiveDecisionRisks(items: DecisionHistorySummaryItem[]): DecisionHistoryRisk[] {
  return items
    .filter((item) => item.guidanceStatus === "reversed" || item.guidanceStatus === "superseded" || item.guidanceStatus === "stale")
    .map((item) => ({
      kind: "inactive_decision" as const,
      severity: "risk" as const,
      summary: `Decision ${item.sourceDecisionId} is ${item.guidanceStatus}; do not present it as active guidance.`,
      sourceDecisionIds: item.sourceDecisionIds,
      sourceGovernanceEventIds: item.sourceGovernanceEventIds,
      citations: item.citations,
      ancestry: item.ancestry,
    }));
}

export function buildDecisionHistorySummary(input: DecisionHistorySummaryInput): DecisionHistorySummary {
  const governanceEvents = input.governanceEvents ?? [];
  const reports = input.reports ?? [];
  const plans = input.plans ?? [];
  const scopedDecisions = input.decisions
    .filter((decision) => scopeMatchesAncestry(input.scope, decision.ancestry ?? planForDecision(decision, plans)?.ancestry))
    .slice()
    .sort((left, right) =>
      timestamp(left.resolvedAt ?? left.updatedAt ?? left.createdAt) - timestamp(right.resolvedAt ?? right.updatedAt ?? right.createdAt) ||
      left.id.localeCompare(right.id),
    );

  const items = scopedDecisions.map((decision) =>
    buildItem({
      decision,
      decisions: scopedDecisions,
      governanceEvents,
      reports,
      plans,
      scope: input.scope,
    }),
  );
  const active = items.filter((item) => item.activeGuidance);
  const inactive = items.filter((item) => !item.activeGuidance);
  const risks = [...conflictRisks(items, governanceEvents), ...inactiveDecisionRisks(inactive)];

  return {
    schemaVersion: 1,
    kind: "decision_history_summary",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scope: input.scope,
    active,
    inactive,
    risks,
    citations: uniqueCitations(items.flatMap((item) => item.citations)),
  };
}
