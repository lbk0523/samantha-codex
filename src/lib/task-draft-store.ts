import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskSpec } from "./contracts";
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
  targetFiles: string[];
  forbiddenChanges: string[];
  setupCommands?: string[];
  verifyCommands: string[];
  instructions: string;
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

export interface TaskDraftUpdatePatch {
  title?: string;
  targetAgent?: string;
  targetFiles?: string[];
  forbiddenChanges?: string[];
  setupCommands?: string[];
  verifyCommands?: string[];
  instructions?: string;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
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
  const value = raw as Record<string, unknown>;
  return {
    title: optionalString(value.title, "title"),
    targetAgent: optionalString(value.targetAgent, "targetAgent"),
    targetFiles: optionalStringArray(value.targetFiles, "targetFiles"),
    forbiddenChanges: optionalStringArray(value.forbiddenChanges, "forbiddenChanges"),
    setupCommands: optionalStringArray(value.setupCommands, "setupCommands"),
    verifyCommands: optionalStringArray(value.verifyCommands, "verifyCommands"),
    instructions: optionalString(value.instructions, "instructions"),
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
  if (draft.verifyCommands.length === 0) violations.push("verifyCommands must not be empty");

  return {
    ok: violations.length === 0,
    draftId: draft.id,
    violations,
  };
}

export function taskSpecFromDraft(draft: TaskDraftRecord): TaskSpec {
  return {
    id: buildTaskIdFromDraft(draft.id),
    title: draft.title,
    targetAgent: draft.targetAgent,
    targetFiles: draft.targetFiles,
    forbiddenChanges: draft.forbiddenChanges,
    setupCommands: draft.setupCommands && draft.setupCommands.length > 0 ? draft.setupCommands : undefined,
    verifyCommands: draft.verifyCommands,
    instructions: draft.instructions,
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
    if (patch.targetFiles !== undefined) updated.targetFiles = patch.targetFiles;
    if (patch.forbiddenChanges !== undefined) updated.forbiddenChanges = patch.forbiddenChanges;
    if (patch.setupCommands !== undefined) updated.setupCommands = patch.setupCommands;
    if (patch.verifyCommands !== undefined) updated.verifyCommands = patch.verifyCommands;
    if (patch.instructions !== undefined) updated.instructions = patch.instructions;
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
