import type { WorkItemAncestry } from "./ancestry";
import type { CeoReportRecord } from "./ceo-report-store";
import type { CeoConversationMemoryReadResult } from "./conversation-memory";
import type { DecisionHistoryCitation, DecisionHistorySummary } from "./decision-history-summary";
import type { GovernanceEventRecord, GovernanceEventSourceKind } from "./governance-event-store";
import type { GovernedMemoryRecord } from "./memory-store";
import { isMemoryEntryKind, type MemoryEntryKind, type MemorySourceCitation } from "./memory-taxonomy";
import type { ProjectBriefReadResult, ProjectBriefRecord, ProjectBriefSectionName } from "./project-brief-store";
import type { WorkerRunLog } from "./run-log";

export type ContextSearchSourceKind =
  | "ceo_report"
  | "operator_report"
  | "run_log"
  | "report_artifact"
  | "decision_history_summary"
  | "project_brief"
  | "memory"
  | "conversation_memory"
  | "governance_event";

export type ContextSearchResultKind =
  | "ceo_report"
  | "operator_report"
  | "report_artifact"
  | "decision_summary"
  | "project_brief"
  | "memory"
  | "conversation_memory"
  | "governance_event"
  | "missing_artifact"
  | "malformed_record";

export type ContextSearchResultStatus = "ok" | "missing" | "malformed" | "stale" | "conflict";

export interface ContextSearchCitation {
  kind: ContextSearchSourceKind | DecisionHistoryCitation["kind"] | MemorySourceCitation["kind"] | GovernanceEventSourceKind;
  id: string;
  ancestry?: WorkItemAncestry;
}

export interface SearchableOperatorReport {
  id: string;
  generatedAt?: string;
  title?: string;
  text: string;
  ancestry?: WorkItemAncestry;
}

export interface SearchableReportArtifact {
  id: string;
  title?: string;
  text?: string;
  source: {
    kind: "operator_report" | "run_log";
    id: string;
  };
  generatedAt?: string;
  ancestry?: WorkItemAncestry;
  missingReason?: string;
}

export interface ContextSearchInput {
  ceoReports?: unknown[];
  operatorReports?: unknown[];
  runLogs?: unknown[];
  reportArtifacts?: unknown[];
  decisionSummaries?: unknown[];
  projectBriefs?: unknown[];
  projectBriefReads?: ProjectBriefReadResult[];
  memoryRecords?: unknown[];
  conversationMemory?: unknown[];
  governanceEvents?: unknown[];
}

export interface ContextSearchQuery {
  text?: string;
  projectId?: string;
  goalId?: string;
  workItemId?: string;
  memoryKind?: MemoryEntryKind;
  source?: {
    kind?: ContextSearchCitation["kind"];
    id: string;
  };
  sourceId?: string;
  limit?: number;
}

export interface ContextSearchResult {
  kind: ContextSearchResultKind;
  status: ContextSearchResultStatus;
  id: string;
  title: string;
  snippet: string;
  sourceKind: ContextSearchSourceKind;
  sourceId: string;
  generatedAt?: string;
  memoryKind?: MemoryEntryKind;
  ancestry?: WorkItemAncestry;
  citations: ContextSearchCitation[];
}

export interface ContextSearchResponse {
  schemaVersion: 1;
  query: ContextSearchQuery;
  results: ContextSearchResult[];
  omittedCount: number;
}

const snippetLength = 280;

function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && oneLine(value) ? oneLine(value) : undefined;
}

function compactSnippet(value: string | undefined): string {
  const text = oneLine(value);
  if (text.length <= snippetLength) return text;
  return `${text.slice(0, snippetLength).trimEnd()}...`;
}

function citationKey(citation: ContextSearchCitation): string {
  return `${citation.kind}:${citation.id}`;
}

function uniqueCitations(citations: ContextSearchCitation[]): ContextSearchCitation[] {
  const seen = new Set<string>();
  const unique: ContextSearchCitation[] = [];
  for (const citation of citations) {
    if (!citation.id) continue;
    const key = citationKey(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }
  return unique;
}

function malformedResult(input: {
  id: string;
  sourceKind: ContextSearchSourceKind;
  reason: string;
  sourceId?: string;
  ancestry?: WorkItemAncestry;
}): ContextSearchResult {
  const sourceId = input.sourceId ?? input.id;
  return {
    kind: "malformed_record",
    status: "malformed",
    id: `malformed:${input.sourceKind}:${sourceId}`,
    title: `Malformed ${input.sourceKind}`,
    snippet: input.reason,
    sourceKind: input.sourceKind,
    sourceId,
    ancestry: input.ancestry,
    citations: [{ kind: input.sourceKind, id: sourceId, ancestry: input.ancestry }],
  };
}

function matchesScope(result: ContextSearchResult, query: ContextSearchQuery): boolean {
  if (!query.projectId && !query.goalId && !query.workItemId) return true;
  if (result.sourceKind === "conversation_memory") return true;
  const ancestry = result.ancestry;
  if (!ancestry || ancestry.mode !== "assigned") return false;
  if (query.projectId && ancestry.projectId !== query.projectId) return false;
  if (query.goalId && ancestry.goalId !== query.goalId) return false;
  if (query.workItemId && ancestry.workItemId !== query.workItemId) return false;
  return true;
}

function resultSearchText(result: ContextSearchResult): string {
  return [
    result.id,
    result.title,
    result.snippet,
    result.sourceKind,
    result.sourceId,
    result.memoryKind,
    result.ancestry?.mode === "assigned" ? result.ancestry.projectId : "",
    ...result.citations.flatMap((citation) => [citation.kind, citation.id]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesText(result: ContextSearchResult, text: string | undefined): boolean {
  const normalized = oneLine(text).toLowerCase();
  if (!normalized) return true;
  return normalized
    .split(/\s+/)
    .every((term) => resultSearchText(result).includes(term));
}

function matchesSource(result: ContextSearchResult, query: ContextSearchQuery): boolean {
  const sourceId = query.source?.id ?? query.sourceId;
  if (!sourceId) return true;
  const kind = query.source?.kind;
  const citations = [
    { kind: result.sourceKind, id: result.sourceId },
    ...result.citations,
  ];
  return citations.some((citation) => citation.id === sourceId && (!kind || citation.kind === kind));
}

function resultTimestamp(result: ContextSearchResult): number {
  return result.generatedAt ? Date.parse(result.generatedAt) || 0 : 0;
}

function applyQuery(results: ContextSearchResult[], query: ContextSearchQuery): ContextSearchResponse {
  const filtered = results
    .filter((result) => !query.memoryKind || result.memoryKind === query.memoryKind)
    .filter((result) => matchesScope(result, query))
    .filter((result) => matchesSource(result, query))
    .filter((result) => matchesText(result, query.text))
    .sort((left, right) =>
      resultTimestamp(right) - resultTimestamp(left) ||
      left.sourceKind.localeCompare(right.sourceKind) ||
      left.id.localeCompare(right.id),
    );
  const limit = query.limit && query.limit > 0 ? query.limit : filtered.length;
  return {
    schemaVersion: 1,
    query,
    results: filtered.slice(0, limit),
    omittedCount: Math.max(0, filtered.length - limit),
  };
}

function indexCeoReport(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "ceo_report", reason: "CEO report must be an object" })];
  }
  const report = value as Partial<CeoReportRecord>;
  const id = requiredString(report.id);
  if (report.schemaVersion !== 1 || !id) {
    return [malformedResult({ id: String(report.id ?? "unknown"), sourceKind: "ceo_report", reason: "CEO report is missing schemaVersion 1 or id" })];
  }
  return [{
    kind: "ceo_report",
    status: "ok",
    id,
    title: `CEO report ${report.overall ?? "unknown"}`,
    snippet: compactSnippet(`overall=${report.overall} next_action=${report.nextActionKind} decisions=${report.decisionCount ?? 0} active=${report.activeCount ?? 0} blocked=${report.blockedCount ?? 0} risks=${report.riskCount ?? 0}`),
    sourceKind: "ceo_report",
    sourceId: id,
    generatedAt: report.generatedAt,
    ancestry: report.ancestry,
    citations: [{ kind: "ceo_report", id, ancestry: report.ancestry }],
  }];
}

function indexOperatorReport(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "operator_report", reason: "operator report must be an object" })];
  }
  const report = value as Partial<SearchableOperatorReport>;
  const id = requiredString(report.id);
  const text = requiredString(report.text);
  if (!id || !text) {
    return [malformedResult({ id: String(report.id ?? "unknown"), sourceKind: "operator_report", reason: "operator report is missing id or text" })];
  }
  return [{
    kind: "operator_report",
    status: "ok",
    id,
    title: oneLine(report.title) || `Operator report ${id}`,
    snippet: compactSnippet(text),
    sourceKind: "operator_report",
    sourceId: id,
    generatedAt: report.generatedAt,
    ancestry: report.ancestry,
    citations: [{ kind: "operator_report", id, ancestry: report.ancestry }],
  }];
}

function extractAgentMessages(output: string | undefined): string[] {
  const messages: string[] = [];
  for (const line of (output ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as { item?: { type?: string; text?: string } };
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        messages.push(event.item.text);
      }
    } catch {
      // Worker stdout can include plain text and partial JSON; search treats it as source text below.
    }
  }
  return messages;
}

function runLogArtifactText(runLog: WorkerRunLog): string {
  const output = [runLog.result.command?.stdout, runLog.result.command?.stderr].filter(Boolean).join("\n");
  const agentMessage = extractAgentMessages(output).at(-1);
  return oneLine(agentMessage) || oneLine(runLog.result.evaluation?.harness?.note) || oneLine(output);
}

function indexRunLog(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "run_log", reason: "run log must be an object" })];
  }
  const runLog = value as Partial<WorkerRunLog>;
  const runId = requiredString(runLog.runId);
  if (runLog.schemaVersion !== 1 || !runId || !runLog.task || !runLog.result) {
    return [malformedResult({ id: String(runLog.runId ?? "unknown"), sourceKind: "run_log", reason: "run log is missing schemaVersion 1, runId, task, or result" })];
  }
  if (runLog.task?.resultMode !== "report") return [];
  const text = runLogArtifactText(runLog as WorkerRunLog);
  const citation = { kind: "run_log" as const, id: runId, ancestry: runLog.ancestry };
  if (!text) {
    return [{
      kind: "missing_artifact",
      status: "missing",
      id: `missing-artifact:${runId}`,
      title: `Missing report artifact for ${runLog.task.id}`,
      snippet: "Report-only run did not expose an artifact preview, agent message, harness note, stdout, or stderr.",
      sourceKind: "run_log",
      sourceId: runId,
      generatedAt: runLog.finishedAt,
      memoryKind: "artifact_reference",
      ancestry: runLog.ancestry,
      citations: [citation],
    }];
  }
  return [{
    kind: "report_artifact",
    status: "ok",
    id: `artifact:${runId}`,
    title: runLog.task.title,
    snippet: compactSnippet(text),
    sourceKind: "run_log",
    sourceId: runId,
    generatedAt: runLog.finishedAt,
    memoryKind: "artifact_reference",
    ancestry: runLog.ancestry,
    citations: uniqueCitations([
      citation,
      { kind: "report_artifact", id: `artifact:${runId}`, ancestry: runLog.ancestry },
    ]),
  }];
}

function indexReportArtifact(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "report_artifact", reason: "report artifact must be an object" })];
  }
  const artifact = value as Partial<SearchableReportArtifact>;
  const id = requiredString(artifact.id);
  const sourceId = isObject(artifact.source) ? requiredString(artifact.source.id) : undefined;
  if (!id || !isObject(artifact.source) || !sourceId) {
    return [malformedResult({ id: String(artifact.id ?? "unknown"), sourceKind: "report_artifact", reason: "report artifact is missing id or source" })];
  }
  const sourceKind = artifact.source.kind === "operator_report" ? "operator_report" : "run_log";
  const status: ContextSearchResultStatus = artifact.missingReason || !oneLine(artifact.text) ? "missing" : "ok";
  return [{
    kind: status === "missing" ? "missing_artifact" : "report_artifact",
    status,
    id,
    title: oneLine(artifact.title) || `Report artifact ${id}`,
    snippet: status === "missing" ? oneLine(artifact.missingReason) || "Report artifact content is missing." : compactSnippet(artifact.text),
    sourceKind: "report_artifact",
    sourceId: id,
    generatedAt: artifact.generatedAt,
    memoryKind: "artifact_reference",
    ancestry: artifact.ancestry,
    citations: uniqueCitations([
      { kind: "report_artifact", id, ancestry: artifact.ancestry },
      { kind: sourceKind, id: sourceId, ancestry: artifact.ancestry },
    ]),
  }];
}

function indexDecisionSummary(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "decision_history_summary", reason: "decision history summary must be an object" })];
  }
  const summary = value as Partial<DecisionHistorySummary>;
  if (summary.schemaVersion !== 1 || summary.kind !== "decision_history_summary") {
    return [malformedResult({ id: "decision-history-summary", sourceKind: "decision_history_summary", reason: "decision history summary is missing schemaVersion 1 or kind" })];
  }
  const results: ContextSearchResult[] = [];
  for (const item of [...(summary.active ?? []), ...(summary.inactive ?? [])]) {
    const status: ContextSearchResultStatus = item.activeGuidance ? "ok" : "stale";
    results.push({
      kind: "decision_summary",
      status,
      id: item.id,
      title: item.title,
      snippet: compactSnippet(item.summary),
      sourceKind: "decision_history_summary",
      sourceId: item.id,
      generatedAt: summary.generatedAt,
      memoryKind: "decision_summary",
      ancestry: item.ancestry,
      citations: uniqueCitations(item.citations.map((citation) => ({
        kind: citation.kind,
        id: citation.id,
        ancestry: citation.ancestry,
      }))),
    });
  }
  for (const risk of summary.risks ?? []) {
    results.push({
      kind: "decision_summary",
      status: risk.kind === "conflicting_prior_decisions" ? "conflict" : "stale",
      id: `decision-risk:${risk.kind}:${risk.sourceDecisionIds.join("+")}`,
      title: risk.kind,
      snippet: compactSnippet(risk.summary),
      sourceKind: "decision_history_summary",
      sourceId: `decision-risk:${risk.kind}:${risk.sourceDecisionIds.join("+")}`,
      generatedAt: summary.generatedAt,
      memoryKind: "decision_summary",
      ancestry: risk.ancestry,
      citations: uniqueCitations(risk.citations.map((citation) => ({
        kind: citation.kind,
        id: citation.id,
        ancestry: citation.ancestry,
      }))),
    });
  }
  return results;
}

function sectionMemoryKind(section: ProjectBriefSectionName): MemoryEntryKind {
  if (section === "currentStrategy") return "strategy_context";
  if (section === "knownRisks") return "known_risk";
  return "project_brief";
}

function indexProjectBrief(brief: ProjectBriefRecord): ContextSearchResult[] {
  const generatedAt = brief.updatedAt;
  const projectAncestry = brief.ancestry ?? {
    mode: "assigned" as const,
    projectId: brief.projectId,
    goalId: "project-brief",
    workItemId: brief.id,
  };
  const status: ContextSearchResultStatus = brief.status === "active" ? "ok" : "stale";
  const results: ContextSearchResult[] = [];
  for (const [section, entries] of Object.entries(brief.sections) as [ProjectBriefSectionName, ProjectBriefRecord["sections"][ProjectBriefSectionName]][]) {
    entries.forEach((entry, index) => {
      const memoryKind = sectionMemoryKind(section);
      results.push({
        kind: "project_brief",
        status,
        id: `${brief.id}:${section}:${index}`,
        title: `${brief.projectId} ${section}`,
        snippet: compactSnippet(entry.text),
        sourceKind: "project_brief",
        sourceId: brief.id,
        generatedAt,
        memoryKind,
        ancestry: projectAncestry,
        citations: uniqueCitations([
          { kind: "project_brief", id: brief.id, ancestry: projectAncestry },
          ...entry.citations.map((citation) => ({
            kind: citation.kind,
            id: citation.id,
            ancestry: citation.ancestry,
          })),
        ]),
      });
    });
  }
  return results;
}

function indexProjectBriefValue(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "project_brief", reason: "project brief must be an object" })];
  }
  const brief = value as Partial<ProjectBriefRecord>;
  if (brief.schemaVersion !== 1 || brief.kind !== "project_brief" || !requiredString(brief.id) || !requiredString(brief.projectId) || !isObject(brief.sections)) {
    return [malformedResult({ id: String(brief.id ?? "unknown"), sourceKind: "project_brief", reason: "project brief is missing schemaVersion 1, kind, id, projectId, or sections" })];
  }
  try {
    return indexProjectBrief(brief as ProjectBriefRecord);
  } catch (err) {
    return [malformedResult({
      id: String(brief.id ?? "unknown"),
      sourceKind: "project_brief",
      reason: `project brief could not be indexed: ${(err as Error).message}`,
    })];
  }
}

function indexProjectBriefRead(read: ProjectBriefReadResult): ContextSearchResult[] {
  if (read.status === "project_memory") return indexProjectBrief(read.brief);
  const ancestry: WorkItemAncestry = {
    mode: "assigned",
    projectId: read.projectId,
    goalId: "project-brief",
    workItemId: `missing-project-brief-${read.projectId}`,
  };
  return [{
    kind: "project_brief",
    status: "missing",
    id: `missing-project-brief:${read.projectId}`,
    title: `No active project brief for ${read.projectId}`,
    snippet: read.reason === "absent" ? "No project brief records exist for this project." : "Project brief records exist, but none are active.",
    sourceKind: "project_brief",
    sourceId: `missing-project-brief:${read.projectId}`,
    memoryKind: "project_brief",
    ancestry,
    citations: [{ kind: "project_brief", id: `missing-project-brief:${read.projectId}`, ancestry }],
  }];
}

function indexMemoryRecord(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "memory", reason: "memory record must be an object" })];
  }
  const record = value as Partial<GovernedMemoryRecord>;
  const id = requiredString(record.id);
  if (record.schemaVersion !== 1 || !id || !isMemoryEntryKind(record.kind) || !requiredString(record.summary)) {
    return [malformedResult({ id: String(record.id ?? "unknown"), sourceKind: "memory", reason: "memory record is missing schemaVersion 1, id, kind, or summary" })];
  }
  const status: ContextSearchResultStatus = record.status === "active" ? "ok" : "stale";
  return [{
    kind: "memory",
    status,
    id,
    title: `${record.kind} ${id}`,
    snippet: compactSnippet(record.summary),
    sourceKind: "memory",
    sourceId: id,
    generatedAt: record.updatedAt,
    memoryKind: record.kind,
    ancestry: record.ancestry,
    citations: uniqueCitations([
      { kind: "memory", id, ancestry: record.ancestry },
      ...((record.citations ?? []) as MemorySourceCitation[]).map((citation) => ({
        kind: citation.kind,
        id: citation.id,
        ancestry: citation.ancestry,
      })),
      ...(record.approvalDecisionId ? [{ kind: "decision" as const, id: record.approvalDecisionId, ancestry: record.ancestry }] : []),
    ]),
  }];
}

function indexConversationMemory(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "conversation_memory", reason: "conversation memory must be an object" })];
  }
  const memory = value as Partial<CeoConversationMemoryReadResult>;
  const id = requiredString(memory.id);
  if (memory.schemaVersion !== 1 || !id || !requiredString(memory.summary)) {
    return [malformedResult({ id: String(memory.id ?? "unknown"), sourceKind: "conversation_memory", reason: "conversation memory is missing schemaVersion 1, id, or summary" })];
  }
  const status: ContextSearchResultStatus = memory.status === "missing" ? "missing" : "ok";
  return [{
    kind: "conversation_memory",
    status,
    id,
    title: "CEO conversation memory",
    snippet: compactSnippet(memory.summary),
    sourceKind: "conversation_memory",
    sourceId: id,
    memoryKind: "strategy_context",
    citations: [{ kind: "conversation_memory", id }],
  }];
}

function indexGovernanceEvent(value: unknown): ContextSearchResult[] {
  if (!isObject(value)) {
    return [malformedResult({ id: "unknown", sourceKind: "governance_event", reason: "governance event must be an object" })];
  }
  const event = value as Partial<GovernanceEventRecord>;
  const id = requiredString(event.id);
  if (event.schemaVersion !== 1 || !id || !event.source || !event.subject) {
    return [malformedResult({ id: String(event.id ?? "unknown"), sourceKind: "governance_event", reason: "governance event is missing schemaVersion 1, id, source, or subject" })];
  }
  return [{
    kind: "governance_event",
    status: event.kind === "audit_gap_recorded" ? "stale" : "ok",
    id,
    title: `${event.kind} ${event.subject.type}:${event.subject.id}`,
    snippet: compactSnippet(event.summary),
    sourceKind: "governance_event",
    sourceId: id,
    generatedAt: event.timestamp,
    ancestry: event.ancestry,
    citations: uniqueCitations([
      { kind: "governance_event", id, ancestry: event.ancestry },
      { kind: event.source.kind, id: event.source.id, ancestry: event.ancestry },
      ...(event.related?.decisionIds ?? []).map((id) => ({ kind: "decision" as const, id, ancestry: event.ancestry })),
      ...(event.related?.actionIds ?? []).map((id) => ({ kind: "remote_action" as const, id, ancestry: event.ancestry })),
      ...(event.related?.runIds ?? []).map((id) => ({ kind: "run_log" as const, id, ancestry: event.ancestry })),
    ]),
  }];
}

export function buildSearchableContext(input: ContextSearchInput): ContextSearchResult[] {
  return [
    ...(input.ceoReports ?? []).flatMap(indexCeoReport),
    ...(input.operatorReports ?? []).flatMap(indexOperatorReport),
    ...(input.runLogs ?? []).flatMap(indexRunLog),
    ...(input.reportArtifacts ?? []).flatMap(indexReportArtifact),
    ...(input.decisionSummaries ?? []).flatMap(indexDecisionSummary),
    ...(input.projectBriefs ?? []).flatMap(indexProjectBriefValue),
    ...(input.projectBriefReads ?? []).flatMap(indexProjectBriefRead),
    ...(input.memoryRecords ?? []).flatMap(indexMemoryRecord),
    ...(input.conversationMemory ?? []).flatMap(indexConversationMemory),
    ...(input.governanceEvents ?? []).flatMap(indexGovernanceEvent),
  ];
}

export function searchContext(input: ContextSearchInput, query: ContextSearchQuery = {}): ContextSearchResponse {
  return applyQuery(buildSearchableContext(input), query);
}
