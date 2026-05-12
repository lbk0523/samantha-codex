import { readFile } from "node:fs/promises";
import type { CeoTurnActor, CeoTurnRecord } from "./ceo-turn-store";
import type { MemoryEntryKind, MemorySourceCitation } from "./memory-taxonomy";
import {
  buildLearningCandidateId,
  parseLearningCandidateRecord,
  type LearningCandidateAttribution,
  type LearningCandidateKind,
  type LearningCandidateRecord,
  type LearningCandidateScope,
} from "./proposal-store";

export const CEO_CONVERSATION_MEMORY_ID = "CEO_Conversation_MEMORY.md";

export type CeoConversationMemoryStatus = "ok" | "missing";

export interface CeoConversationMemoryReadResult {
  schemaVersion: 1;
  id: string;
  status: CeoConversationMemoryStatus;
  summary: string;
  sourcePath?: string;
  missingReason?: string;
}

export type ConversationMemoryCandidateCategory =
  | "durable_decision"
  | "product_direction"
  | "rejected_path"
  | "important_progress";

interface CandidateRule {
  category: ConversationMemoryCandidateCategory;
  label: string;
  kind: LearningCandidateKind;
  proposedMemoryKind: MemoryEntryKind;
  pattern: RegExp;
  behaviorImpact: "none" | "behavior_change";
}

const conversationMemorySummaryLimit = 2800;
const candidateTextLimit = 360;
const defaultProjectId = "samantha";

const secretPatterns = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/i,
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S+/i,
  /\b(?:api[_-]?key|token|password|secret|private[_ -]?key)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];

const candidateRules: CandidateRule[] = [
  {
    category: "durable_decision",
    label: "Durable decision",
    kind: "memory_synthesis",
    proposedMemoryKind: "decision_summary",
    pattern: /\b(decided|decision|from now on|we will|must keep|must not|should keep)\b|결정|정했다|하기로|앞으로|반드시|유지해야/i,
    behaviorImpact: "behavior_change",
  },
  {
    category: "product_direction",
    label: "Product direction",
    kind: "product_heuristic",
    proposedMemoryKind: "strategy_context",
    pattern: /\b(product direction|roadmap|north star|target product|primary surface|command bot|natural ceo|ceo conversation)\b|제품 방향|로드맵|북극성|주요 표면|명령봇|자연어 CEO|CEO 대화/i,
    behaviorImpact: "behavior_change",
  },
  {
    category: "rejected_path",
    label: "Rejected path",
    kind: "product_heuristic",
    proposedMemoryKind: "known_risk",
    pattern: /\b(reject|rejected|avoid|do not|don't|not the path|wrong path|abandon)\b|거절|폐기|하지 마|하지 않는다|버린다|피하|아니다/i,
    behaviorImpact: "behavior_change",
  },
  {
    category: "important_progress",
    label: "Important progress",
    kind: "memory_synthesis",
    proposedMemoryKind: "artifact_reference",
    pattern: /\b(completed|implemented|fixed|shipped|progress|stage [0-9]+|phase [0-9]+)\b|완료|구현|수정됨|진행|고쳤|끝냈|단계|페이즈/i,
    behaviorImpact: "none",
  },
];

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, limit: number): string {
  const normalized = oneLine(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}...`;
}

export function containsSecretLikeText(value: string): boolean {
  return secretPatterns.some((pattern) => pattern.test(value));
}

export function redactSecretLikeText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b((?:api[_-]?key|token|password|secret|private[_ -]?key))\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]");
}

export function summarizeCeoConversationMemory(content: string, limit = conversationMemorySummaryLimit): string {
  const redacted = redactSecretLikeText(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit).trimEnd()}...`;
}

export async function readCeoConversationMemory(
  path: string,
  options: { id?: string; summaryLimit?: number } = {},
): Promise<CeoConversationMemoryReadResult> {
  const id = options.id ?? CEO_CONVERSATION_MEMORY_ID;
  try {
    const content = await readFile(path, "utf8");
    return {
      schemaVersion: 1,
      id,
      status: "ok",
      summary: summarizeCeoConversationMemory(content, options.summaryLimit),
      sourcePath: path,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return {
      schemaVersion: 1,
      id,
      status: "missing",
      summary: "CEO conversation memory file is missing.",
      sourcePath: path,
      missingReason: "absent",
    };
  }
}

function attributionForTurn(actor: CeoTurnActor, turnId: string): LearningCandidateAttribution {
  if (actor === "bk") return { kind: "bk", id: turnId };
  if (actor === "operator") return { kind: "operator", id: turnId };
  return { kind: "system", id: turnId };
}

function scopeForProject(projectId: string | undefined): LearningCandidateScope {
  return { type: "project", projectId: projectId ?? defaultProjectId };
}

function candidateEvidence(input: {
  turn: CeoTurnRecord;
  conversationMemory?: CeoConversationMemoryReadResult;
}): MemorySourceCitation[] {
  const evidence: MemorySourceCitation[] = [{ kind: "ceo_turn", id: input.turn.id }];
  if (input.conversationMemory?.status === "ok") {
    evidence.push({ kind: "conversation_memory", id: input.conversationMemory.id });
  }
  return evidence;
}

function progressSignal(input: { turn: CeoTurnRecord; responseText?: string }): string {
  if (input.turn.responseBoundary.kind === "blocker") return "";
  const linked = input.turn.linkedStateIds;
  const linkedCount = [
    linked.requestIds,
    linked.planIds,
    linked.decisionIds,
    linked.taskIds,
    linked.actionIds,
    linked.runIds,
    linked.reportIds,
  ].reduce((count, ids) => count + (ids?.length ?? 0), 0);
  if (linkedCount === 0 || input.turn.detectedIntent.kind === "status_request") return "";
  return [input.turn.text, input.responseText ?? ""].join(" ");
}

function sourceTextForRule(input: {
  rule: CandidateRule;
  turn: CeoTurnRecord;
  responseText?: string;
}): string {
  if (input.rule.category === "important_progress") {
    return progressSignal({ turn: input.turn, responseText: input.responseText });
  }
  return input.turn.text;
}

function contentForRule(input: {
  rule: CandidateRule;
  turn: CeoTurnRecord;
  sourceText: string;
}): string {
  const source = clip(input.sourceText, candidateTextLimit);
  return `${input.rule.label}: ${source}. Treat this as planning context only; promotion requires the deterministic memory write gate.`;
}

export function buildConversationMemoryCandidates(input: {
  turn: CeoTurnRecord;
  conversationMemory?: CeoConversationMemoryReadResult;
  responseText?: string;
  projectId?: string;
}): LearningCandidateRecord[] {
  const evidence = candidateEvidence(input);
  const candidates: LearningCandidateRecord[] = [];
  for (const rule of candidateRules) {
    const sourceText = sourceTextForRule({ rule, turn: input.turn, responseText: input.responseText });
    if (!sourceText || !rule.pattern.test(sourceText)) continue;
    if (containsSecretLikeText(sourceText)) continue;

    const summary = `${rule.label}: ${clip(sourceText, 140)}`;
    candidates.push(parseLearningCandidateRecord({
      schemaVersion: 1,
      id: buildLearningCandidateId({
        createdAt: input.turn.createdAt,
        kind: rule.kind,
        summary,
        disambiguator: rule.category,
      }),
      kind: rule.kind,
      proposedMemoryKind: rule.proposedMemoryKind,
      claimKind: rule.category === "important_progress"
        ? "observed_fact"
        : input.turn.actor === "bk"
          ? "bk_decision"
          : "operator_note",
      scope: scopeForProject(input.projectId),
      summary,
      proposedContent: contentForRule({ rule, turn: input.turn, sourceText }),
      evidence,
      confidence: rule.category === "important_progress" ? 0.72 : 0.78,
      attribution: attributionForTurn(input.turn.actor, input.turn.id),
      status: "pending_review",
      createdAt: input.turn.createdAt,
      updatedAt: input.turn.createdAt,
      behaviorImpact: rule.behaviorImpact,
      behaviorImpactReviewRequired: rule.behaviorImpact === "behavior_change",
    }));
  }
  return candidates;
}
