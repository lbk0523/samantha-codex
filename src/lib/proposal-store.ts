import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOptionalWorkItemAncestry, type WorkItemAncestry } from "./ancestry";
import { compactEntityId } from "./ids";
import {
  isMemoryEntryKind,
  parseMemoryClaimKind,
  parseMemoryEntryKind,
  validateMemorySourceCitation,
  type MemoryClaimKind,
  type MemoryEntryKind,
  type MemorySourceCitation,
} from "./memory-taxonomy";

export type ProposalStatus = "pending_review" | "accepted" | "rejected";
export type LearningCandidateKind =
  | "memory_synthesis"
  | "recurring_preference"
  | "product_heuristic"
  | "repeated_feedback"
  | "known_risk";
export type LearningCandidateStatus = "pending_review" | "accepted" | "rejected" | "archived";
export type LearningCandidateReviewActor = "bk" | "deterministic_operator";
export type LearningCandidateBehaviorImpact = "none" | "behavior_change";

export type LearningCandidateScope =
  | { type: "project"; projectId: string }
  | { type: "cross_project"; projectIds: string[] };

export type LearningCandidateAttribution =
  | { kind: "llm"; agentId: string; model: string }
  | { kind: "operator"; id: string }
  | { kind: "bk"; id: string }
  | { kind: "system"; id: string };

export interface ProposalRecord {
  schemaVersion: 1;
  id: string;
  text: string;
  source: "remote" | "local";
  senderId?: string;
  status: ProposalStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewNote?: string;
}

export interface LearningCandidateRecord {
  schemaVersion: 1;
  id: string;
  kind: LearningCandidateKind;
  proposedMemoryKind: MemoryEntryKind;
  claimKind: MemoryClaimKind;
  scope: LearningCandidateScope;
  summary: string;
  proposedContent: string;
  evidence: MemorySourceCitation[];
  confidence: number;
  attribution: LearningCandidateAttribution;
  ancestry?: WorkItemAncestry;
  status: LearningCandidateStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: LearningCandidateReviewActor;
  reviewNote?: string;
  staleSourceNotes?: string[];
  behaviorImpact?: LearningCandidateBehaviorImpact;
  behaviorImpactReviewRequired?: boolean;
  synthesisRunId?: string;
  supersededByCandidateId?: string;
  promotionGate?: "deterministic_memory_write_gate_required";
}

export interface LearningCandidateFilter {
  status?: LearningCandidateStatus;
  kind?: LearningCandidateKind;
  projectId?: string;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeJsonLines<T>(path: string, items: T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
}

export function buildProposalId(receivedAt: string, disambiguator?: string | number): string {
  const source = disambiguator === undefined ? receivedAt : `${receivedAt}-${disambiguator}`;
  return compactEntityId({
    prefix: "proposal",
    createdAt: receivedAt,
    label: "proposal",
    source,
  });
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function describeUnknown(value: unknown): string {
  if (value === "") return "(empty)";
  if (typeof value === "string") return value;
  return String(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableIdViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (normalized !== value) return [`${label} must be normalized`];
  if (/[\\/]/.test(normalized)) return [`${label} must be a stable id, not a path`];
  return [];
}

function textViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  if (!oneLine(value)) return [`${label} is required`];
  return [];
}

function timestampViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (Number.isNaN(new Date(normalized).getTime())) return [`${label} must be a valid date: ${normalized}`];
  return [];
}

function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

const learningCandidateKinds: readonly LearningCandidateKind[] = [
  "memory_synthesis",
  "recurring_preference",
  "product_heuristic",
  "repeated_feedback",
  "known_risk",
] as const;
const learningCandidateStatuses: readonly LearningCandidateStatus[] = [
  "pending_review",
  "accepted",
  "rejected",
  "archived",
] as const;
const learningCandidateReviewActors: readonly LearningCandidateReviewActor[] = [
  "bk",
  "deterministic_operator",
] as const;
const learningCandidateBehaviorImpacts: readonly LearningCandidateBehaviorImpact[] = [
  "none",
  "behavior_change",
] as const;
const learningCandidateForbiddenMutationFields = new Set([
  "memory",
  "memoryWrite",
  "memoryPatch",
  "memoryMutation",
  "durableMemoryEntry",
  "projectBriefWrite",
  "projectBriefPatch",
  "sop",
  "sopWrite",
  "sopPatch",
  "skill",
  "skillWrite",
  "skillPatch",
  "profile",
  "profileWrite",
  "profilePatch",
  "policy",
  "policyWrite",
  "policyPatch",
  "connector",
  "connectorGrant",
  "connectorPatch",
  "secret",
  "secretGrant",
  "secretPatch",
  "task",
  "taskWrite",
  "taskPatch",
  "action",
  "actionWrite",
  "actionPatch",
  "run",
  "runWrite",
  "runPatch",
  "dispatch",
  "merge",
  "push",
  "cleanup",
]);

function forbiddenMutationFieldViolations(value: unknown, label = "candidate"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenMutationFieldViolations(item, `${label}[${index}]`));
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const current = `${label}.${key}`;
    const violations = learningCandidateForbiddenMutationFields.has(key)
      ? [`${current} is not allowed on learning candidates; promotion requires a later deterministic write gate`]
      : [];
    return [...violations, ...forbiddenMutationFieldViolations(nested, current)];
  });
}

function validateLearningCandidateScope(value: unknown, label = "candidate.scope"): string[] {
  const violations: string[] = [];
  if (!isObject(value)) return [`${label} must be an object`];
  if (value.type === "project") {
    violations.push(...stableIdViolations(value.projectId, `${label}.projectId`));
    return violations;
  }
  if (value.type === "cross_project") {
    if (!Array.isArray(value.projectIds) || value.projectIds.length === 0) {
      violations.push(`${label}.projectIds must include at least one project id`);
    } else {
      const seen = new Set<string>();
      value.projectIds.forEach((projectId, index) => {
        violations.push(...stableIdViolations(projectId, `${label}.projectIds[${index}]`));
        if (typeof projectId === "string") {
          if (seen.has(projectId)) violations.push(`${label}.projectIds[${index}] must be unique: ${projectId}`);
          seen.add(projectId);
        }
      });
    }
    return violations;
  }
  return [`${label}.type is invalid: ${describeUnknown(value.type)}`];
}

function normalizeLearningCandidateScope(scope: LearningCandidateScope): LearningCandidateScope {
  if (scope.type === "project") return { type: "project", projectId: scope.projectId };
  return { type: "cross_project", projectIds: [...new Set(scope.projectIds)].sort() };
}

function validateLearningCandidateAttribution(value: unknown, label = "candidate.attribution"): string[] {
  const violations: string[] = [];
  if (!isObject(value)) return [`${label} must be an object`];
  if (value.kind === "llm") {
    violations.push(...stableIdViolations(value.agentId, `${label}.agentId`));
    violations.push(...textViolations(value.model, `${label}.model`));
    return violations;
  }
  if (value.kind === "operator" || value.kind === "bk" || value.kind === "system") {
    violations.push(...stableIdViolations(value.id, `${label}.id`));
    return violations;
  }
  return [`${label}.kind is invalid: ${describeUnknown(value.kind)}`];
}

function normalizeLearningCandidateAttribution(attribution: LearningCandidateAttribution): LearningCandidateAttribution {
  if (attribution.kind === "llm") {
    return {
      kind: "llm",
      agentId: attribution.agentId,
      model: oneLine(attribution.model),
    };
  }
  return { kind: attribution.kind, id: attribution.id };
}

function learningCandidateMatchesFilter(candidate: LearningCandidateRecord, filter: LearningCandidateFilter): boolean {
  if (filter.status && candidate.status !== filter.status) return false;
  if (filter.kind && candidate.kind !== filter.kind) return false;
  if (filter.projectId) {
    if (candidate.scope.type === "project") return candidate.scope.projectId === filter.projectId;
    return candidate.scope.projectIds.includes(filter.projectId);
  }
  return true;
}

export function validateLearningCandidateRecord(value: unknown): string[] {
  const violations: string[] = [];
  if (!isObject(value)) return ["learning candidate must be an object"];
  const candidate = value as Partial<LearningCandidateRecord>;
  violations.push(...forbiddenMutationFieldViolations(candidate));
  if (candidate.schemaVersion !== 1) violations.push("learning candidate schemaVersion must be 1");
  violations.push(...stableIdViolations(candidate.id, "candidate.id"));
  if (!hasValue(learningCandidateKinds, candidate.kind)) {
    violations.push(`candidate.kind is invalid: ${describeUnknown(candidate.kind)}`);
  }
  if (!isMemoryEntryKind(candidate.proposedMemoryKind)) {
    violations.push(`candidate.proposedMemoryKind is invalid: ${describeUnknown(candidate.proposedMemoryKind)}`);
  }
  try {
    parseMemoryClaimKind(candidate.claimKind);
  } catch {
    violations.push(`candidate.claimKind is invalid: ${describeUnknown(candidate.claimKind)}`);
  }
  violations.push(...validateLearningCandidateScope(candidate.scope));
  violations.push(...textViolations(candidate.summary, "candidate.summary"));
  violations.push(...textViolations(candidate.proposedContent, "candidate.proposedContent"));
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
    violations.push("candidate.evidence must include at least one source citation");
  } else {
    candidate.evidence.forEach((citation, index) => {
      violations.push(...validateMemorySourceCitation(citation, `candidate.evidence[${index}]`));
    });
  }
  if (typeof candidate.confidence !== "number" || candidate.confidence <= 0 || candidate.confidence > 1) {
    violations.push("candidate.confidence must be greater than 0 and less than or equal to 1");
  }
  violations.push(...validateLearningCandidateAttribution(candidate.attribution));
  if (candidate.attribution?.kind === "llm" && candidate.claimKind !== "llm_summary") {
    violations.push("LLM learning candidates must use claimKind llm_summary until approved by a deterministic write gate");
  }
  if (candidate.ancestry !== undefined) {
    try {
      parseOptionalWorkItemAncestry(candidate.ancestry);
    } catch (err) {
      violations.push(`candidate.ancestry ${String((err as Error).message)}`);
    }
  }
  if (!hasValue(learningCandidateStatuses, candidate.status)) {
    violations.push(`candidate.status is invalid: ${describeUnknown(candidate.status)}`);
  }
  violations.push(...timestampViolations(candidate.createdAt, "candidate.createdAt"));
  violations.push(...timestampViolations(candidate.updatedAt, "candidate.updatedAt"));
  if (candidate.reviewedAt !== undefined) violations.push(...timestampViolations(candidate.reviewedAt, "candidate.reviewedAt"));
  if (candidate.reviewedBy !== undefined && !hasValue(learningCandidateReviewActors, candidate.reviewedBy)) {
    violations.push(`candidate.reviewedBy is invalid: ${describeUnknown(candidate.reviewedBy)}`);
  }
  if (candidate.reviewNote !== undefined) violations.push(...textViolations(candidate.reviewNote, "candidate.reviewNote"));
  if (candidate.staleSourceNotes !== undefined) {
    if (!Array.isArray(candidate.staleSourceNotes) || candidate.staleSourceNotes.some((note) => typeof note !== "string" || !oneLine(note))) {
      violations.push("candidate.staleSourceNotes must be a non-empty string array");
    }
  }
  if (candidate.behaviorImpact !== undefined && !hasValue(learningCandidateBehaviorImpacts, candidate.behaviorImpact)) {
    violations.push(`candidate.behaviorImpact is invalid: ${describeUnknown(candidate.behaviorImpact)}`);
  }
  if (
    candidate.behaviorImpact === "behavior_change" &&
    candidate.behaviorImpactReviewRequired !== true
  ) {
    violations.push("behavior-changing learning candidates must require explicit review");
  }
  if (
    candidate.behaviorImpactReviewRequired !== undefined &&
    typeof candidate.behaviorImpactReviewRequired !== "boolean"
  ) {
    violations.push("candidate.behaviorImpactReviewRequired must be a boolean");
  }
  if (candidate.synthesisRunId !== undefined) {
    violations.push(...stableIdViolations(candidate.synthesisRunId, "candidate.synthesisRunId"));
  }
  if (candidate.supersededByCandidateId !== undefined) {
    violations.push(...stableIdViolations(candidate.supersededByCandidateId, "candidate.supersededByCandidateId"));
  }
  if (
    candidate.promotionGate !== undefined &&
    candidate.promotionGate !== "deterministic_memory_write_gate_required"
  ) {
    violations.push(`candidate.promotionGate is invalid: ${describeUnknown(candidate.promotionGate)}`);
  }
  if (candidate.status === "accepted" && candidate.promotionGate !== "deterministic_memory_write_gate_required") {
    violations.push("accepted learning candidates must require the deterministic memory write gate before promotion");
  }
  return violations;
}

export function parseLearningCandidateRecord(value: unknown): LearningCandidateRecord {
  if (!isObject(value)) throw new Error("learning candidate must be an object");
  const candidate = value as unknown as LearningCandidateRecord;
  const violations = validateLearningCandidateRecord(candidate);
  if (violations.length > 0) throw new Error(violations[0]);
  return {
    schemaVersion: 1,
    id: candidate.id,
    kind: candidate.kind,
    proposedMemoryKind: parseMemoryEntryKind(candidate.proposedMemoryKind),
    claimKind: parseMemoryClaimKind(candidate.claimKind),
    scope: normalizeLearningCandidateScope(candidate.scope),
    summary: oneLine(candidate.summary),
    proposedContent: oneLine(candidate.proposedContent),
    evidence: candidate.evidence.map((citation) => ({
      kind: citation.kind,
      id: citation.id,
      ancestry: parseOptionalWorkItemAncestry(citation.ancestry),
    })),
    confidence: candidate.confidence,
    attribution: normalizeLearningCandidateAttribution(candidate.attribution),
    ancestry: parseOptionalWorkItemAncestry(candidate.ancestry),
    status: candidate.status,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    reviewedAt: candidate.reviewedAt,
    reviewedBy: candidate.reviewedBy,
    reviewNote: candidate.reviewNote ? oneLine(candidate.reviewNote) : undefined,
    ...(candidate.staleSourceNotes
      ? { staleSourceNotes: candidate.staleSourceNotes.map(oneLine) }
      : {}),
    ...(candidate.behaviorImpact ? { behaviorImpact: candidate.behaviorImpact } : {}),
    ...(candidate.behaviorImpactReviewRequired !== undefined
      ? { behaviorImpactReviewRequired: candidate.behaviorImpactReviewRequired }
      : {}),
    ...(candidate.synthesisRunId ? { synthesisRunId: candidate.synthesisRunId } : {}),
    supersededByCandidateId: candidate.supersededByCandidateId,
    ...(candidate.promotionGate ? { promotionGate: candidate.promotionGate } : {}),
  };
}

export function buildLearningCandidateId(input: {
  createdAt: string;
  kind: LearningCandidateKind;
  summary: string;
  disambiguator?: string | number;
}): string {
  const source = input.disambiguator === undefined
    ? `${input.kind}-${input.summary}`
    : `${input.kind}-${input.summary}-${input.disambiguator}`;
  return compactEntityId({
    prefix: "learning-candidate",
    createdAt: input.createdAt,
    label: input.kind,
    source,
  });
}

export class ProposalStore {
  constructor(private readonly path: string) {}

  async list(): Promise<ProposalRecord[]> {
    return readJsonLines<ProposalRecord>(this.path);
  }

  async find(id: string): Promise<ProposalRecord | undefined> {
    return (await this.list()).find((proposal) => proposal.id === id);
  }

  async append(proposal: ProposalRecord): Promise<void> {
    const proposals = await this.list();
    if (proposals.some((existing) => existing.id === proposal.id)) {
      throw new Error(`proposal already exists: ${proposal.id}`);
    }
    await writeJsonLines(this.path, [...proposals, proposal]);
  }

  async updateStatus(
    id: string,
    status: ProposalStatus,
    input: { reviewedAt: string; reviewNote?: string },
  ): Promise<ProposalRecord> {
    const proposals = await this.list();
    const index = proposals.findIndex((proposal) => proposal.id === id);
    if (index === -1) throw new Error(`proposal not found: ${id}`);

    const updated: ProposalRecord = {
      ...proposals[index],
      status,
      reviewedAt: input.reviewedAt,
      reviewNote: input.reviewNote,
    };
    const next = [...proposals];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }
}

export class LearningCandidateStore {
  constructor(private readonly path: string) {}

  async list(filter: LearningCandidateFilter = {}): Promise<LearningCandidateRecord[]> {
    const candidates = (await readJsonLines<unknown>(this.path)).map(parseLearningCandidateRecord);
    return Object.keys(filter).length ? candidates.filter((candidate) => learningCandidateMatchesFilter(candidate, filter)) : candidates;
  }

  async find(id: string): Promise<LearningCandidateRecord | undefined> {
    return (await this.list()).find((candidate) => candidate.id === id);
  }

  async append(candidate: LearningCandidateRecord): Promise<LearningCandidateRecord> {
    const normalized = parseLearningCandidateRecord(candidate);
    if (normalized.status !== "pending_review") {
      throw new Error(`learning candidate must start as pending_review: ${normalized.status}`);
    }
    const candidates = await this.list();
    if (candidates.some((existing) => existing.id === normalized.id)) {
      throw new Error(`learning candidate already exists: ${normalized.id}`);
    }
    await writeJsonLines(this.path, [...candidates, normalized]);
    return normalized;
  }

  async updateStatus(
    id: string,
    status: LearningCandidateStatus,
    input: {
      reviewedAt: string;
      reviewedBy: LearningCandidateReviewActor;
      reviewNote?: string;
      supersededByCandidateId?: string;
    },
  ): Promise<LearningCandidateRecord> {
    const candidates = await this.list();
    const index = candidates.findIndex((candidate) => candidate.id === id);
    if (index === -1) throw new Error(`learning candidate not found: ${id}`);
    if (!hasValue(learningCandidateStatuses, status)) throw new Error(`candidate.status is invalid: ${describeUnknown(status)}`);
    if (!hasValue(learningCandidateReviewActors, input.reviewedBy)) {
      throw new Error(`candidate.reviewedBy is invalid: ${describeUnknown(input.reviewedBy)}`);
    }

    const current = candidates[index];
    if (current.status === "archived") throw new Error("learning candidate already archived");
    if ((status === "accepted" || status === "rejected") && current.status !== "pending_review") {
      throw new Error(`learning candidate must be pending_review before ${status}: ${current.status}`);
    }
    if ((status === "rejected" || status === "archived") && !input.reviewNote?.trim()) {
      throw new Error(`learning candidate ${status} requires a review note`);
    }

    const updated: LearningCandidateRecord = parseLearningCandidateRecord({
      ...current,
      status,
      updatedAt: input.reviewedAt,
      reviewedAt: input.reviewedAt,
      reviewedBy: input.reviewedBy,
      reviewNote: input.reviewNote,
      supersededByCandidateId: input.supersededByCandidateId,
      promotionGate: status === "accepted" ? "deterministic_memory_write_gate_required" : undefined,
    });
    const next = [...candidates];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }
}
