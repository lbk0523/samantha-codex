import { readFile } from "node:fs/promises";
import {
  createGovernanceEvent,
  type GovernanceEventRecord,
  type GovernanceEventSubject,
  type GovernanceRelatedRefs,
} from "./governance-event-store";
import { parseGovernedSubjectType } from "./governance-taxonomy";
import type { ProjectProfile } from "./project-profile";

export const RECOVERY_DRILL_OUTCOMES = ["fixed", "still_blocked", "needs_bk"] as const;

export type RecoveryDrillOutcome = (typeof RECOVERY_DRILL_OUTCOMES)[number];

export type RecoveryDrillFailureMode =
  | "failed_verify"
  | "dirty_worktree"
  | "merge_conflict"
  | "failed_push"
  | "stale_approval"
  | "mistaken_profile_proposal"
  | "blocked_capability_request";

export interface RecoveryDrillGuidance {
  canonicalRoot: string;
  preMerge: string[];
  postMerge: string[];
  rollbackAuthority: string[];
  gates: string[];
}

export interface RecoveryDrill {
  id: string;
  title: string;
  failureMode: RecoveryDrillFailureMode;
  governedSubject: GovernanceEventSubject;
  projectProfileIds: string[];
  signals: string[];
  operatorSteps: string[];
  recoveryGuidance: RecoveryDrillGuidance;
}

export interface RecoveryDrillCatalog {
  schemaVersion: 1;
  drills: RecoveryDrill[];
}

export interface RecoveryDrillOutcomeEventInput {
  drill: RecoveryDrill;
  outcome: RecoveryDrillOutcome;
  timestamp: string;
  actor: string;
  note: string;
  related?: GovernanceRelatedRefs;
}

const FAILURE_MODES = [
  "failed_verify",
  "dirty_worktree",
  "merge_conflict",
  "failed_push",
  "stale_approval",
  "mistaken_profile_proposal",
  "blocked_capability_request",
] as const satisfies readonly RecoveryDrillFailureMode[];

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = oneLine(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requireStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const items = value.map((item, index) => requireString(item, `${label}[${index}]`));
  if (!items.length) throw new Error(`${label} is required`);
  return items;
}

function parseFailureMode(value: unknown): RecoveryDrillFailureMode {
  if (typeof value === "string" && (FAILURE_MODES as readonly string[]).includes(value)) {
    return value as RecoveryDrillFailureMode;
  }
  throw new Error(`unknown recovery drill failure mode: ${String(value)}`);
}

export function parseRecoveryDrillOutcome(value: string): RecoveryDrillOutcome {
  if ((RECOVERY_DRILL_OUTCOMES as readonly string[]).includes(value)) {
    return value as RecoveryDrillOutcome;
  }
  throw new Error(`unsupported recovery drill outcome: ${value}`);
}

function parseGovernedSubject(value: unknown, label: string): GovernanceEventSubject {
  const subject = requireRecord(value, label);
  const type = parseGovernedSubjectType(subject.type);
  return { type, id: requireString(subject.id, `${label}.id`) };
}

function parseGuidance(value: unknown, label: string): RecoveryDrillGuidance {
  const guidance = requireRecord(value, label);
  return {
    canonicalRoot: requireString(guidance.canonicalRoot, `${label}.canonicalRoot`),
    preMerge: requireStringList(guidance.preMerge, `${label}.preMerge`),
    postMerge: requireStringList(guidance.postMerge, `${label}.postMerge`),
    rollbackAuthority: requireStringList(guidance.rollbackAuthority, `${label}.rollbackAuthority`),
    gates: requireStringList(guidance.gates, `${label}.gates`),
  };
}

export function parseRecoveryDrillCatalog(value: unknown): RecoveryDrillCatalog {
  const catalog = requireRecord(value, "recovery drill catalog");
  if (catalog.schemaVersion !== 1) {
    throw new Error(`unsupported recovery drill catalog schemaVersion: ${String(catalog.schemaVersion)}`);
  }
  if (!Array.isArray(catalog.drills)) throw new Error("recovery drill catalog drills must be an array");

  const seen = new Set<string>();
  const drills = catalog.drills.map((item, index): RecoveryDrill => {
    const record = requireRecord(item, `drills[${index}]`);
    const id = requireString(record.id, `drills[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate recovery drill id: ${id}`);
    seen.add(id);

    return {
      id,
      title: requireString(record.title, `drills[${index}].title`),
      failureMode: parseFailureMode(record.failureMode),
      governedSubject: parseGovernedSubject(record.governedSubject, `drills[${index}].governedSubject`),
      projectProfileIds: requireStringList(record.projectProfileIds, `drills[${index}].projectProfileIds`),
      signals: requireStringList(record.signals, `drills[${index}].signals`),
      operatorSteps: requireStringList(record.operatorSteps, `drills[${index}].operatorSteps`),
      recoveryGuidance: parseGuidance(record.recoveryGuidance, `drills[${index}].recoveryGuidance`),
    };
  });

  return { schemaVersion: 1, drills };
}

export async function loadRecoveryDrillCatalog(path: string): Promise<RecoveryDrillCatalog> {
  return parseRecoveryDrillCatalog(JSON.parse(await readFile(path, "utf8")));
}

export function requiredRecoveryDrillFailureModes(): RecoveryDrillFailureMode[] {
  return [...FAILURE_MODES];
}

export function findRecoveryDrill(catalog: RecoveryDrillCatalog, id: string): RecoveryDrill {
  const drill = catalog.drills.find((item) => item.id === id);
  if (!drill) throw new Error(`unknown recovery drill: ${id}`);
  return drill;
}

function matchingProfiles(drill: RecoveryDrill, profiles: ProjectProfile[] | undefined): ProjectProfile[] {
  if (!profiles?.length) return [];
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return drill.projectProfileIds.flatMap((id) => {
    const profile = byId.get(id);
    return profile ? [profile] : [];
  });
}

function bulletList(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function outcomeLabel(event: GovernanceEventRecord): string {
  if (event.kind === "transition_completed") return "fixed";
  if (event.summary.includes("outcome=needs_bk")) return "needs_bk";
  if (event.kind === "transition_blocked") return "still_blocked";
  return event.kind;
}

export function recoveryDrillSourceId(drillId: string): string {
  return `recovery-drill:${drillId}`;
}

export function formatRecoveryDrillReport(input: {
  drill: RecoveryDrill;
  projectProfiles?: ProjectProfile[];
  events?: GovernanceEventRecord[];
}): string {
  const profiles = matchingProfiles(input.drill, input.projectProfiles);
  const rootLines = profiles.length
    ? profiles.map((profile) => `- ${profile.id}: ${profile.repoRoot}`)
    : input.drill.projectProfileIds.map((id) => `- ${id}: project profile canonical repoRoot`);
  const events = input.events ?? [];
  const eventLines = events.length
    ? events.map(
        (event) =>
          `- ${event.timestamp} outcome=${outcomeLabel(event)} risk=${event.riskClass} actor=${event.actor} summary=${event.summary}`,
      )
    : ["- none recorded"];

  return [
    `Recovery Drill: ${input.drill.title}`,
    "",
    `Id: ${input.drill.id}`,
    `Failure mode: ${input.drill.failureMode}`,
    `Governed subject: ${input.drill.governedSubject.type}:${input.drill.governedSubject.id}`,
    "Docs: docs/ROLLBACK_AND_RECOVERY_DRILLS.md",
    "",
    "Canonical Project Profile Roots:",
    ...rootLines,
    "",
    "Signals:",
    ...bulletList(input.drill.signals),
    "",
    "Operator Steps:",
    ...bulletList(input.drill.operatorSteps),
    "",
    "Recovery Guidance:",
    `- canonical root: ${input.drill.recoveryGuidance.canonicalRoot}`,
    ...input.drill.recoveryGuidance.preMerge.map((item) => `- pre-merge: ${item}`),
    ...input.drill.recoveryGuidance.postMerge.map((item) => `- post-merge: ${item}`),
    ...input.drill.recoveryGuidance.rollbackAuthority.map((item) => `- rollback authority: ${item}`),
    ...input.drill.recoveryGuidance.gates.map((item) => `- gate: ${item}`),
    "",
    "Recorded Outcomes:",
    ...eventLines,
  ].join("\n");
}

export function createRecoveryDrillOutcomeEvent(input: RecoveryDrillOutcomeEventInput): GovernanceEventRecord {
  const eventKind = input.outcome === "fixed" ? "transition_completed" : "transition_blocked";
  const riskClass = input.outcome === "fixed" ? "medium" : "high";
  return createGovernanceEvent({
    timestamp: input.timestamp,
    actor: input.actor,
    source: { kind: "operator_report", id: recoveryDrillSourceId(input.drill.id) },
    subject: input.drill.governedSubject,
    kind: eventKind,
    riskClass,
    summary: `Recovery drill ${input.drill.id} outcome=${input.outcome}: ${input.note}`,
    related: input.related,
  });
}
