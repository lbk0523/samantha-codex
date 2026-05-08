import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskResultMode, TaskSpec } from "./contracts";
import { matchesAnyGlob } from "./glob";
import type { ProposalRecord } from "./proposal-store";
import { sanitizeTaskId } from "./worktree";

export type TaskDraftStatus = "drafted" | "approved" | "discarded";

export interface TaskDraftRecord {
  schemaVersion: 1;
  id: string;
  sourceProposalId: string;
  status: TaskDraftStatus;
  title: string;
  targetAgent: string;
  projectId?: string;
  repoRoot?: string;
  targetFiles: string[];
  forbiddenChanges: string[];
  setupCommands?: string[];
  verifyCommands: string[];
  instructions: string;
  resultMode?: TaskResultMode;
  createdAt: string;
  updatedAt?: string;
  approvedAt?: string;
  discardedAt?: string;
}

export interface TaskDraftCheckResult {
  ok: boolean;
  draftId: string;
  violations: string[];
}

export interface TaskDraftFieldReadiness {
  field: string;
  required: boolean;
  ok: boolean;
  summary: string;
}

export interface TaskDraftReadiness {
  ok: boolean;
  draftId: string;
  status: TaskDraftStatus | "missing";
  fields: TaskDraftFieldReadiness[];
  violations: string[];
  nextActions: string[];
}

export interface TaskDraftUpdatePatch {
  title?: string;
  targetAgent?: string;
  projectId?: string;
  repoRoot?: string;
  targetFiles?: string[];
  forbiddenChanges?: string[];
  setupCommands?: string[];
  verifyCommands?: string[];
  instructions?: string;
  resultMode?: TaskResultMode;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function optionalResultMode(value: unknown, field: string): TaskResultMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "write" && value !== "report") throw new Error(`${field} must be write or report`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return value;
}

export function parseTaskDraftUpdatePatch(raw: unknown): TaskDraftUpdatePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("draft update patch must be an object");
  }
  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    "title",
    "targetAgent",
    "projectId",
    "repoRoot",
    "targetFiles",
    "forbiddenChanges",
    "setupCommands",
    "verifyCommands",
    "instructions",
    "resultMode",
  ]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${field} is not an allowed draft update field`);
  }
  return {
    title: optionalString(value.title, "title"),
    targetAgent: optionalString(value.targetAgent, "targetAgent"),
    projectId: optionalString(value.projectId, "projectId"),
    repoRoot: optionalString(value.repoRoot, "repoRoot"),
    targetFiles: optionalStringArray(value.targetFiles, "targetFiles"),
    forbiddenChanges: optionalStringArray(value.forbiddenChanges, "forbiddenChanges"),
    setupCommands: optionalStringArray(value.setupCommands, "setupCommands"),
    verifyCommands: optionalStringArray(value.verifyCommands, "verifyCommands"),
    instructions: optionalString(value.instructions, "instructions"),
    resultMode: optionalResultMode(value.resultMode, "resultMode"),
  };
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

export function buildTaskDraftId(sourceProposalId: string): string {
  return `draft-${sanitizeTaskId(sourceProposalId.replace(/^proposal-/, ""))}`;
}

function titleFromProposal(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? "Untitled task draft";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

export function taskDraftFromProposal(proposal: ProposalRecord, createdAt: string): TaskDraftRecord {
  if (proposal.status !== "accepted") {
    throw new Error(`proposal must be accepted before drafting: ${proposal.id}`);
  }

  return {
    schemaVersion: 1,
    id: buildTaskDraftId(proposal.id),
    sourceProposalId: proposal.id,
    status: "drafted",
    title: titleFromProposal(proposal.text),
    targetAgent: "codex-worker",
    targetFiles: [],
    forbiddenChanges: [],
    setupCommands: [],
    verifyCommands: [],
    instructions: proposal.text.trim(),
    createdAt,
  };
}

export function buildTaskIdFromDraft(draftId: string): string {
  return `task-${sanitizeTaskId(draftId.replace(/^draft-/, ""))}`;
}

export function validateTaskTargetFiles(files: string[], forbiddenChanges: string[] = []): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const trimmed = file.trim();
    if (!trimmed) {
      violations.push("targetFiles must not contain empty paths");
      continue;
    }
    if (/^(draft|proposal|task)-/.test(trimmed)) {
      violations.push(`targetFiles entry looks like an id, not a file path: ${trimmed}`);
      continue;
    }
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      violations.push(`targetFiles must be repo-relative paths: ${trimmed}`);
      continue;
    }
    if (trimmed.split(/[\\/]+/).includes("..")) {
      violations.push(`targetFiles must not contain parent directory segments: ${trimmed}`);
      continue;
    }
    const normalized = trimmed.replace(/\\/g, "/");
    if ([".", "./", "*", "**", "**/*", "./**", "./**/*"].includes(normalized)) {
      violations.push(`targetFiles entry is too broad: ${trimmed}`);
      continue;
    }
    const forbidden = forbiddenChanges.find((glob) => matchesAnyGlob(trimmed, [glob]));
    if (forbidden) {
      violations.push(`targetFiles entry is forbidden: ${trimmed} matches ${forbidden}`);
    }
  }
  return violations;
}

export function checkTaskDraft(draft: TaskDraftRecord | undefined, input: { knownAgentIds?: string[] } = {}): TaskDraftCheckResult {
  if (!draft) {
    return { ok: false, draftId: "", violations: ["draft not found"] };
  }

  const violations: string[] = [];
  if (draft.status !== "drafted") violations.push(`draft status must be drafted: ${draft.status}`);
  if (!draft.title.trim()) violations.push("title is required");
  if (!draft.instructions.trim()) violations.push("instructions are required");
  if (!draft.targetAgent.trim()) violations.push("targetAgent is required");
  if (input.knownAgentIds && !input.knownAgentIds.includes(draft.targetAgent)) {
    violations.push(`targetAgent is unknown: ${draft.targetAgent}`);
  }
  if (draft.targetFiles.length === 0) violations.push("targetFiles must not be empty");
  violations.push(...validateTaskTargetFiles(draft.targetFiles, draft.forbiddenChanges));
  if (draft.verifyCommands.length === 0) violations.push("verifyCommands must not be empty");

  return {
    ok: violations.length === 0,
    draftId: draft.id,
    violations,
  };
}

function countSummary(items: string[]): string {
  return items.length === 0 ? "empty" : `${items.length} set`;
}

export function taskDraftReadiness(
  draft: TaskDraftRecord | undefined,
  input: { knownAgentIds?: string[]; projectId?: string } = {},
): TaskDraftReadiness {
  const check = checkTaskDraft(draft, { knownAgentIds: input.knownAgentIds });
  if (!draft) {
    return {
      ok: false,
      draftId: "",
      status: "missing",
      fields: [],
      violations: check.violations,
      nextActions: ["Find a valid draft id with `bun run samantha drafts:list`."],
    };
  }

  const targetAgentKnown = !input.knownAgentIds || input.knownAgentIds.includes(draft.targetAgent);
  const fields: TaskDraftFieldReadiness[] = [
    { field: "status", required: true, ok: draft.status === "drafted", summary: draft.status },
    { field: "title", required: true, ok: draft.title.trim().length > 0, summary: draft.title.trim() ? "set" : "empty" },
    {
      field: "targetAgent",
      required: true,
      ok: draft.targetAgent.trim().length > 0 && targetAgentKnown,
      summary: draft.targetAgent.trim() ? `${draft.targetAgent}${targetAgentKnown ? "" : " (unknown)"}` : "empty",
    },
    { field: "targetFiles", required: true, ok: draft.targetFiles.length > 0, summary: countSummary(draft.targetFiles) },
    { field: "forbiddenChanges", required: false, ok: true, summary: countSummary(draft.forbiddenChanges) },
    { field: "setupCommands", required: false, ok: true, summary: countSummary(draft.setupCommands ?? []) },
    { field: "verifyCommands", required: true, ok: draft.verifyCommands.length > 0, summary: countSummary(draft.verifyCommands) },
    {
      field: "instructions",
      required: true,
      ok: draft.instructions.trim().length > 0,
      summary: draft.instructions.trim() ? `${draft.instructions.trim().length} chars` : "empty",
    },
  ];

  const nextActions = check.ok
    ? [
        `Approve locally: bun run samantha drafts:approve ${draft.id}`,
        `Inspect task after approval: bun run samantha tasks:show ${buildTaskIdFromDraft(draft.id)}`,
      ]
    : [
        input.projectId
          ? `Apply project defaults: bun run samantha drafts:prepare ${draft.id} --project=${input.projectId}`
          : `Apply project defaults: bun run samantha drafts:prepare ${draft.id} --project=<project-id>`,
        input.projectId
          ? `Create patch template: bun run samantha drafts:template ${draft.id} --project=${input.projectId}`
          : `Create patch template: bun run samantha drafts:template ${draft.id} --project=<project-id>`,
        `Update draft: bun run samantha drafts:update ${draft.id} --from=<draft-patch.json>`,
      ];

  return {
    ok: check.ok,
    draftId: draft.id,
    status: draft.status,
    fields,
    violations: check.violations,
    nextActions,
  };
}

export function taskDraftPatchTemplate(draft: TaskDraftRecord, defaults: TaskDraftUpdatePatch = {}): TaskDraftUpdatePatch {
  const template: TaskDraftUpdatePatch = {
    title: draft.title,
    targetAgent: draft.targetAgent || defaults.targetAgent || "codex-worker",
    targetFiles: draft.targetFiles.length > 0 ? draft.targetFiles : defaults.targetFiles ?? [],
    forbiddenChanges: draft.forbiddenChanges.length > 0 ? draft.forbiddenChanges : defaults.forbiddenChanges ?? [],
    setupCommands: (draft.setupCommands ?? []).length > 0 ? draft.setupCommands : defaults.setupCommands ?? [],
    verifyCommands: draft.verifyCommands.length > 0 ? draft.verifyCommands : defaults.verifyCommands ?? [],
    instructions: draft.instructions,
  };
  const resultMode = draft.resultMode ?? defaults.resultMode;
  if (resultMode) template.resultMode = resultMode;
  return template;
}

export function taskSpecFromDraft(draft: TaskDraftRecord): TaskSpec {
  return {
    id: buildTaskIdFromDraft(draft.id),
    title: draft.title,
    targetAgent: draft.targetAgent,
    ...(draft.projectId ? { projectId: draft.projectId } : {}),
    ...(draft.repoRoot ? { repoRoot: draft.repoRoot } : {}),
    targetFiles: draft.targetFiles,
    forbiddenChanges: draft.forbiddenChanges,
    setupCommands: draft.setupCommands && draft.setupCommands.length > 0 ? draft.setupCommands : undefined,
    verifyCommands: draft.verifyCommands,
    instructions: draft.instructions,
    ...(draft.resultMode ? { resultMode: draft.resultMode } : {}),
    status: "pending",
  };
}

export class TaskDraftStore {
  constructor(private readonly path: string) {}

  async list(): Promise<TaskDraftRecord[]> {
    return readJsonLines<TaskDraftRecord>(this.path);
  }

  async find(id: string): Promise<TaskDraftRecord | undefined> {
    return (await this.list()).find((draft) => draft.id === id);
  }

  async append(draft: TaskDraftRecord): Promise<void> {
    const drafts = await this.list();
    if (drafts.some((existing) => existing.id === draft.id)) {
      throw new Error(`task draft already exists: ${draft.id}`);
    }
    if (drafts.some((existing) => existing.sourceProposalId === draft.sourceProposalId)) {
      throw new Error(`task draft already exists for proposal: ${draft.sourceProposalId}`);
    }
    await writeJsonLines(this.path, [...drafts, draft]);
  }

  async update(id: string, patch: TaskDraftUpdatePatch, updatedAt: string): Promise<TaskDraftRecord> {
    const drafts = await this.list();
    const index = drafts.findIndex((draft) => draft.id === id);
    if (index === -1) throw new Error(`task draft not found: ${id}`);
    if (drafts[index].status !== "drafted") {
      throw new Error(`task draft is not editable: ${id}`);
    }

    const updated: TaskDraftRecord = {
      ...drafts[index],
      updatedAt,
    };
    if (patch.title !== undefined) updated.title = patch.title;
    if (patch.targetAgent !== undefined) updated.targetAgent = patch.targetAgent;
    if (patch.projectId !== undefined) updated.projectId = patch.projectId;
    if (patch.repoRoot !== undefined) updated.repoRoot = patch.repoRoot;
    if (patch.targetFiles !== undefined) updated.targetFiles = patch.targetFiles;
    if (patch.forbiddenChanges !== undefined) updated.forbiddenChanges = patch.forbiddenChanges;
    if (patch.setupCommands !== undefined) updated.setupCommands = patch.setupCommands;
    if (patch.verifyCommands !== undefined) updated.verifyCommands = patch.verifyCommands;
    if (patch.instructions !== undefined) updated.instructions = patch.instructions;
    if (patch.resultMode !== undefined) updated.resultMode = patch.resultMode;
    const next = [...drafts];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }

  async markApproved(id: string, approvedAt: string): Promise<TaskDraftRecord> {
    const drafts = await this.list();
    const index = drafts.findIndex((draft) => draft.id === id);
    if (index === -1) throw new Error(`task draft not found: ${id}`);

    const updated: TaskDraftRecord = {
      ...drafts[index],
      status: "approved",
      approvedAt,
      updatedAt: approvedAt,
    };
    const next = [...drafts];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }
}
