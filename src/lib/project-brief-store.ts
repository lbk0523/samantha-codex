import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOptionalWorkItemAncestry, type WorkItemAncestry } from "./ancestry";
import {
  parseMemorySourceKind,
  validateMemorySourceCitation,
  type MemorySourceCitation,
} from "./memory-taxonomy";
import type { ProjectProfile } from "./project-profile";

export type ProjectBriefStatus = "pending_review" | "active" | "archived";

export type ProjectBriefSectionName =
  | "productContext"
  | "currentStrategy"
  | "keyConstraints"
  | "knownRisks"
  | "openQuestions";

export interface ProjectBriefSectionEntry {
  text: string;
  citations: MemorySourceCitation[];
}

export type ProjectBriefSections = Record<ProjectBriefSectionName, ProjectBriefSectionEntry[]>;

export interface ProjectBriefRecord {
  schemaVersion: 1;
  id: string;
  kind: "project_brief";
  projectId: string;
  status: ProjectBriefStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewDecisionId?: string;
  supersedesBriefId?: string;
  ancestry?: WorkItemAncestry;
  sections: ProjectBriefSections;
}

export type ProjectBriefReadResult =
  | { status: "project_memory"; projectId: string; brief: ProjectBriefRecord }
  | { status: "no_project_memory"; projectId: string; reason: "absent" | "no_active_project_brief" };

export interface ProjectBriefValidationOptions {
  projectIds?: string[];
  label?: string;
}

export interface ProjectBriefLoadOptions {
  projectIds?: string[];
}

const projectBriefStatuses: readonly ProjectBriefStatus[] = ["pending_review", "active", "archived"];
const projectBriefSectionNames: readonly ProjectBriefSectionName[] = [
  "productContext",
  "currentStrategy",
  "keyConstraints",
  "knownRisks",
  "openQuestions",
];

const allowedTopLevelFields = new Set([
  "schemaVersion",
  "id",
  "kind",
  "projectId",
  "status",
  "createdAt",
  "updatedAt",
  "reviewedAt",
  "reviewDecisionId",
  "supersedesBriefId",
  "ancestry",
  "sections",
]);

const allowedSectionEntryFields = new Set(["text", "citations"]);

const blockedAuthorityFields = new Set([
  "repoRoot",
  "repoRootExpression",
  "runtimeRoot",
  "resolvedRuntimeRoot",
  "remoteScopes",
  "defaultRemoteScopeId",
  "safetyPolicy",
  "safetyOverlay",
  "allowedRemoteScopeIds",
  "dispatchPrerequisites",
  "hostOnlyVerificationNeeds",
  "setupCommands",
  "verifyCommands",
  "forbiddenChanges",
  "writerCap",
  "worktreeRoot",
  "stateRoot",
  "runsRoot",
  "dashboardRoot",
]);

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeUnknown(value: unknown): string {
  if (value === "") return "(empty)";
  if (typeof value === "string") return value;
  return String(value);
}

function stableIdViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (normalized !== value) return [`${label} must be normalized`];
  if (/[\\/]/.test(normalized)) return [`${label} must be a stable id, not a path`];
  return [];
}

function timestampViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (Number.isNaN(new Date(normalized).getTime())) return [`${label} must be a valid date: ${normalized}`];
  return [];
}

function unknownFieldViolations(value: Record<string, unknown>, allowed: Set<string>, label: string): string[] {
  return Object.keys(value).flatMap((field) => {
    if (allowed.has(field)) return [];
    if (blockedAuthorityFields.has(field)) {
      return [`${label}.${field} must not configure project authority; project briefs are context only`];
    }
    return [`${label}.${field} is not an allowed project brief field`];
  });
}

function validateProjectBriefSectionEntry(value: unknown, label: string): string[] {
  if (!isObject(value)) return [`${label} must be an object`];
  const violations = unknownFieldViolations(value, allowedSectionEntryFields, label);
  if (typeof value.text !== "string" || !oneLine(value.text)) {
    violations.push(`${label}.text is required`);
  }
  if (!Array.isArray(value.citations) || value.citations.length === 0) {
    violations.push(`${label}.citations must include at least one source citation`);
  } else {
    value.citations.forEach((citation, index) => {
      violations.push(...validateMemorySourceCitation(citation as MemorySourceCitation, `${label}.citations[${index}]`));
    });
  }
  return violations;
}

function validateProjectBriefSections(value: unknown, label: string): string[] {
  if (!isObject(value)) return [`${label} must be an object`];
  const violations: string[] = [];
  const sectionNames = new Set(projectBriefSectionNames);
  let substantiveEntries = 0;

  for (const key of Object.keys(value)) {
    if (!sectionNames.has(key as ProjectBriefSectionName)) {
      if (blockedAuthorityFields.has(key)) {
        violations.push(`${label}.${key} must not configure project authority; project briefs are context only`);
      } else {
        violations.push(`${label}.${key} is not an allowed project brief section`);
      }
    }
  }

  for (const sectionName of projectBriefSectionNames) {
    const entries = value[sectionName];
    if (!Array.isArray(entries)) {
      violations.push(`${label}.${sectionName} must be an array`);
      continue;
    }
    substantiveEntries += entries.length;
    entries.forEach((entry, index) => {
      violations.push(...validateProjectBriefSectionEntry(entry, `${label}.${sectionName}[${index}]`));
    });
  }

  if (substantiveEntries === 0) {
    violations.push(`${label} must include at least one source-backed section entry`);
  }

  return violations;
}

function normalizeCitation(citation: MemorySourceCitation): MemorySourceCitation {
  return {
    kind: parseMemorySourceKind(citation.kind),
    id: citation.id,
    ancestry: parseOptionalWorkItemAncestry(citation.ancestry),
  };
}

function normalizeSections(sections: ProjectBriefSections): ProjectBriefSections {
  return {
    productContext: sections.productContext.map((entry) => ({
      text: oneLine(entry.text),
      citations: entry.citations.map(normalizeCitation),
    })),
    currentStrategy: sections.currentStrategy.map((entry) => ({
      text: oneLine(entry.text),
      citations: entry.citations.map(normalizeCitation),
    })),
    keyConstraints: sections.keyConstraints.map((entry) => ({
      text: oneLine(entry.text),
      citations: entry.citations.map(normalizeCitation),
    })),
    knownRisks: sections.knownRisks.map((entry) => ({
      text: oneLine(entry.text),
      citations: entry.citations.map(normalizeCitation),
    })),
    openQuestions: sections.openQuestions.map((entry) => ({
      text: oneLine(entry.text),
      citations: entry.citations.map(normalizeCitation),
    })),
  };
}

export function validateProjectBriefRecord(value: unknown, options: ProjectBriefValidationOptions = {}): string[] {
  const label = options.label ?? "project brief";
  if (!isObject(value)) return [`${label} must be an object`];
  const record = value as Partial<ProjectBriefRecord>;
  const violations = unknownFieldViolations(value, allowedTopLevelFields, label);

  if (record.schemaVersion !== 1) violations.push(`${label}.schemaVersion must be 1`);
  if (record.kind !== "project_brief") violations.push(`${label}.kind must be project_brief`);
  violations.push(...stableIdViolations(record.id, `${label}.id`));
  violations.push(...stableIdViolations(record.projectId, `${label}.projectId`));
  if (typeof record.projectId === "string" && options.projectIds && !options.projectIds.includes(record.projectId)) {
    violations.push(`${label}.projectId is unknown: ${record.projectId}`);
  }
  if (!projectBriefStatuses.includes(record.status as ProjectBriefStatus)) {
    violations.push(`${label}.status is invalid: ${describeUnknown(record.status)}`);
  }
  violations.push(...timestampViolations(record.createdAt, `${label}.createdAt`));
  violations.push(...timestampViolations(record.updatedAt, `${label}.updatedAt`));
  if (record.reviewedAt !== undefined) violations.push(...timestampViolations(record.reviewedAt, `${label}.reviewedAt`));
  if (record.reviewDecisionId !== undefined) {
    violations.push(...stableIdViolations(record.reviewDecisionId, `${label}.reviewDecisionId`));
  }
  if (record.supersedesBriefId !== undefined) {
    violations.push(...stableIdViolations(record.supersedesBriefId, `${label}.supersedesBriefId`));
  }
  if (record.ancestry !== undefined) {
    violations.push(...parseAncestryViolations(record.ancestry, `${label}.ancestry`));
  }
  violations.push(...validateProjectBriefSections(record.sections, `${label}.sections`));

  if (record.status === "active") {
    if (!record.reviewedAt) violations.push(`${label}.reviewedAt is required for active briefs`);
    if (!record.reviewDecisionId) violations.push(`${label}.reviewDecisionId is required for active briefs`);
  }

  return violations;
}

function parseAncestryViolations(value: unknown, label: string): string[] {
  try {
    parseOptionalWorkItemAncestry(value, label);
    return [];
  } catch (err) {
    return [(err as Error).message];
  }
}

export function parseProjectBriefRecord(value: unknown, options: ProjectBriefValidationOptions = {}): ProjectBriefRecord {
  const violations = validateProjectBriefRecord(value, options);
  if (violations.length > 0) throw new Error(violations[0]);
  const record = value as ProjectBriefRecord;
  return {
    schemaVersion: 1,
    id: record.id,
    kind: "project_brief",
    projectId: record.projectId,
    status: record.status,
    createdAt: oneLine(record.createdAt),
    updatedAt: oneLine(record.updatedAt),
    reviewedAt: record.reviewedAt ? oneLine(record.reviewedAt) : undefined,
    reviewDecisionId: record.reviewDecisionId,
    supersedesBriefId: record.supersedesBriefId,
    ancestry: parseOptionalWorkItemAncestry(record.ancestry),
    sections: normalizeSections(record.sections),
  };
}

function sortProjectBriefs(briefs: ProjectBriefRecord[]): ProjectBriefRecord[] {
  return briefs.slice().sort((a, b) =>
    a.projectId.localeCompare(b.projectId) ||
    a.updatedAt.localeCompare(b.updatedAt) ||
    a.id.localeCompare(b.id),
  );
}

function projectIdsFromProfiles(profiles: ProjectProfile[] | undefined): string[] | undefined {
  return profiles?.map((profile) => profile.id);
}

function requireKnownProjectId(projectId: string, projectIds: string[] | undefined): void {
  const violations = stableIdViolations(projectId, "projectId");
  if (violations.length > 0) throw new Error(violations[0]);
  if (projectIds && !projectIds.includes(projectId)) throw new Error(`project brief projectId is unknown: ${projectId}`);
}

export async function loadProjectBriefs(path: string, options: ProjectBriefLoadOptions = {}): Promise<ProjectBriefRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const briefs: ProjectBriefRecord[] = [];
  const seenIds = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`malformed project brief at line ${index + 1}: invalid JSON`);
    }

    let brief: ProjectBriefRecord;
    try {
      brief = parseProjectBriefRecord(parsed, { projectIds: options.projectIds, label: `project brief line ${index + 1}` });
    } catch (err) {
      throw new Error(`malformed project brief at line ${index + 1}: ${(err as Error).message}`);
    }

    if (seenIds.has(brief.id)) {
      throw new Error(`malformed project brief at line ${index + 1}: duplicate project brief id: ${brief.id}`);
    }
    seenIds.add(brief.id);
    briefs.push(brief);
  });

  return sortProjectBriefs(briefs);
}

export class ProjectBriefStore {
  private readonly projectIds?: string[];

  constructor(private readonly path: string, options: { profiles?: ProjectProfile[]; projectIds?: string[] } = {}) {
    this.projectIds = options.projectIds ?? projectIdsFromProfiles(options.profiles);
  }

  async list(): Promise<ProjectBriefRecord[]> {
    return loadProjectBriefs(this.path, { projectIds: this.projectIds });
  }

  async listActive(): Promise<ProjectBriefRecord[]> {
    return (await this.list()).filter((brief) => brief.status === "active");
  }

  async listByProject(projectId: string): Promise<ProjectBriefRecord[]> {
    requireKnownProjectId(projectId, this.projectIds);
    return (await this.list()).filter((brief) => brief.projectId === projectId);
  }

  async readProjectBrief(projectId: string): Promise<ProjectBriefReadResult> {
    requireKnownProjectId(projectId, this.projectIds);
    const projectBriefs = await this.listByProject(projectId);
    if (projectBriefs.length === 0) return { status: "no_project_memory", projectId, reason: "absent" };

    const active = projectBriefs.filter((brief) => brief.status === "active");
    if (active.length === 0) return { status: "no_project_memory", projectId, reason: "no_active_project_brief" };
    if (active.length > 1) throw new Error(`multiple active project briefs for project: ${projectId}`);
    return { status: "project_memory", projectId, brief: active[0] };
  }

  async appendPendingReview(brief: ProjectBriefRecord): Promise<ProjectBriefRecord> {
    const normalized = parseProjectBriefRecord(brief, { projectIds: this.projectIds });
    if (normalized.status !== "pending_review") {
      throw new Error(`project brief writes must enter pending_review, not ${normalized.status}`);
    }
    const briefs = await this.list();
    if (briefs.some((item) => item.id === normalized.id)) {
      throw new Error(`project brief already exists: ${normalized.id}`);
    }
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(normalized)}\n`, "utf8");
    return normalized;
  }
}
