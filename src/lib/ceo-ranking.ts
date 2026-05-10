import type { GoalPriority } from "./ancestry";
import type { CeoDecisionSummary, CeoNextAction, CeoStatusItem } from "./ceo-status";
import type { ProjectQueueSnapshot } from "./project-queues";

export type CeoRankingSignal =
  | "bk_decision"
  | "blocked_recovery"
  | "active_worker"
  | "stale_failure"
  | "audit_gap"
  | "completed_summary";

export interface CeoRankingCandidate {
  rank: number;
  signal: CeoRankingSignal;
  id: string;
  title: string;
  status: string;
  projectId?: string;
  goalId?: string;
  priority?: GoalPriority;
  updatedAt?: string;
  action: CeoNextAction;
  score: number;
  evidence: string[];
  explanation: string;
}

export interface CeoRanking {
  generatedAt: string;
  top?: CeoRankingCandidate;
  candidates: CeoRankingCandidate[];
  tieBreaker: string;
}

export interface BuildCeoRankingInput {
  generatedAt: string;
  needsDecision: CeoDecisionSummary[];
  active: CeoStatusItem[];
  blocked: CeoStatusItem[];
  historicalFailures: CeoStatusItem[];
  completed: CeoStatusItem[];
  nextAction: CeoNextAction;
  projectQueues?: ProjectQueueSnapshot;
}

const baseScores: Record<CeoRankingSignal, number> = {
  bk_decision: 700,
  blocked_recovery: 600,
  stale_failure: 500,
  active_worker: 400,
  audit_gap: 300,
  completed_summary: 100,
};

const priorityScores: Record<GoalPriority, number> = {
  urgent: 35,
  high: 20,
  normal: 10,
  low: 0,
};

export const CEO_RANKING_TIE_BREAKER =
  "score desc, recency desc, project id asc, signal asc, item id asc";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function priorityScore(priority: GoalPriority | undefined): number {
  return priority ? priorityScores[priority] : 0;
}

function evidenceFor(input: {
  signal: CeoRankingSignal;
  status: string;
  projectId?: string;
  goalId?: string;
  priority?: GoalPriority;
  updatedAt?: string;
  detail?: string;
}): string[] {
  return [
    `signal=${input.signal}`,
    `status=${input.status}`,
    input.projectId ? `project=${input.projectId}` : "",
    input.goalId ? `goal=${input.goalId}` : "",
    input.priority ? `priority=${input.priority}` : "",
    input.updatedAt ? `updated=${input.updatedAt}` : "",
    input.detail ? `detail=${oneLine(input.detail)}` : "",
  ].filter(Boolean);
}

function candidateScore(signal: CeoRankingSignal, priority: GoalPriority | undefined): number {
  return baseScores[signal] + priorityScore(priority);
}

function actionForCandidate(input: {
  signal: CeoRankingSignal;
  id: string;
  title: string;
  status: string;
  reason: string;
  nextAction: CeoNextAction;
}): CeoNextAction {
  if (!(input.signal === "active_worker" && input.nextAction.kind === "approve_action") && input.nextAction.targetId === input.id) {
    return input.nextAction;
  }

  if (input.signal === "bk_decision") {
    return {
      kind: "resolve_decision",
      label: `Resolve BK decision: ${input.title}`,
      command: "/now",
      targetId: input.id,
      reason: input.reason,
    };
  }
  if (input.signal === "blocked_recovery" || input.signal === "stale_failure") {
    return {
      kind: "recover",
      label: `Review recovery need: ${input.title}`,
      command: "/problems",
      targetId: input.id,
      reason: input.reason,
    };
  }
  if (input.signal === "active_worker") {
    if (input.status === "pending") {
      return {
        kind: "approve_action",
        label: `Review pending worker action: ${input.title}`,
        command: "/problems",
        targetId: input.id,
        reason: "A worker action is pending, but compact remote /go does not approve individual actions.",
      };
    }
    return {
      kind: "watch_action",
      label: `Watch active work: ${input.title}`,
      command: "/now",
      targetId: input.id,
      reason: input.reason,
    };
  }
  if (input.signal === "audit_gap") {
    return {
      kind: "diagnose",
      label: `Review audit gaps: ${input.title}`,
      command: "bun run samantha status",
      targetId: input.id,
      reason: input.reason,
    };
  }
  return {
    kind: "none",
    label: `Review completed work summary: ${input.title}`,
    targetId: input.id,
    reason: input.reason,
  };
}

function candidate(input: {
  signal: CeoRankingSignal;
  id: string;
  title: string;
  status: string;
  reason: string;
  nextAction: CeoNextAction;
  projectId?: string;
  goalId?: string;
  priority?: GoalPriority;
  updatedAt?: string;
  detail?: string;
}): Omit<CeoRankingCandidate, "rank"> {
  const score = candidateScore(input.signal, input.priority);
  const evidence = evidenceFor(input);
  return {
    signal: input.signal,
    id: input.id,
    title: oneLine(input.title),
    status: input.status,
    projectId: input.projectId,
    goalId: input.goalId,
    priority: input.priority,
    updatedAt: input.updatedAt,
    action: actionForCandidate(input),
    score,
    evidence,
    explanation: `ranked by ${input.signal} with score ${score}; ties use ${CEO_RANKING_TIE_BREAKER}`,
  };
}

function compareCandidates(
  left: Omit<CeoRankingCandidate, "rank">,
  right: Omit<CeoRankingCandidate, "rank">,
): number {
  return (
    right.score - left.score ||
    timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
    (left.projectId ?? "").localeCompare(right.projectId ?? "") ||
    left.signal.localeCompare(right.signal) ||
    left.id.localeCompare(right.id)
  );
}

function auditGapCandidates(input: BuildCeoRankingInput): Array<Omit<CeoRankingCandidate, "rank">> {
  const queues = input.projectQueues;
  if (!queues) return [];
  const sections = [
    ...queues.projects,
    queues.unassigned,
    queues.legacy,
  ];
  return sections
    .filter((section) => section.counts.auditGaps > 0)
    .map((section) =>
      candidate({
        signal: "audit_gap",
        id: `audit-gap:${section.bucket.label}`,
        title: section.bucket.kind === "project" ? `project ${section.bucket.label}` : section.bucket.label,
        status: `${section.counts.auditGaps} audit gap(s)`,
        reason: `${section.counts.auditGaps} audit gap(s) remain visible for operator review; this is not budget enforcement.`,
        nextAction: input.nextAction,
        projectId: section.bucket.projectId,
        updatedAt: input.generatedAt,
        detail: `audit_gaps=${section.counts.auditGaps}`,
      }),
    );
}

export function buildCeoRanking(input: BuildCeoRankingInput): CeoRanking {
  const candidates: Array<Omit<CeoRankingCandidate, "rank">> = [
    ...input.needsDecision.map((decision) =>
      candidate({
        signal: "bk_decision",
        id: decision.id,
        title: decision.title,
        status: decision.status,
        reason: decision.reason,
        nextAction: input.nextAction,
        projectId: decision.projectId,
        goalId: decision.goalId,
        priority: decision.priority,
        updatedAt: decision.updatedAt,
        detail: decision.subject,
      }),
    ),
    ...input.blocked.map((item) =>
      candidate({
        signal: "blocked_recovery",
        id: item.id,
        title: item.title,
        status: item.status,
        reason: item.detail ?? "Blocked work remains open until fixed or explicitly closed.",
        nextAction: input.nextAction,
        projectId: item.projectId,
        goalId: item.goalId,
        priority: item.priority,
        updatedAt: item.updatedAt,
        detail: item.detail,
      }),
    ),
    ...input.historicalFailures.map((item) =>
      candidate({
        signal: "stale_failure",
        id: item.id,
        title: item.title,
        status: item.status,
        reason: item.detail ?? "Historical failure remains unresolved.",
        nextAction: input.nextAction,
        projectId: item.projectId,
        goalId: item.goalId,
        priority: item.priority,
        updatedAt: item.updatedAt,
        detail: item.detail,
      }),
    ),
    ...input.active.map((item) =>
      candidate({
        signal: "active_worker",
        id: item.id,
        title: item.title,
        status: item.status,
        reason: item.detail ?? "Active work state is in progress.",
        nextAction: input.nextAction,
        projectId: item.projectId,
        goalId: item.goalId,
        priority: item.priority,
        updatedAt: item.updatedAt,
        detail: item.detail,
      }),
    ),
    ...auditGapCandidates(input),
    ...input.completed.map((item) =>
      candidate({
        signal: "completed_summary",
        id: item.id,
        title: item.title,
        status: item.status,
        reason: item.detail ?? "Routine completed-work summary.",
        nextAction: input.nextAction,
        projectId: item.projectId,
        goalId: item.goalId,
        priority: item.priority,
        updatedAt: item.updatedAt,
        detail: item.detail,
      }),
    ),
  ];

  const ranked = candidates
    .sort(compareCandidates)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return {
    generatedAt: input.generatedAt,
    top: ranked[0],
    candidates: ranked,
    tieBreaker: CEO_RANKING_TIE_BREAKER,
  };
}
