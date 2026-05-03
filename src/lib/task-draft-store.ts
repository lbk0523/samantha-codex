import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  verifyCommands: string[];
  instructions: string;
  createdAt: string;
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
    verifyCommands: [],
    instructions: proposal.text.trim(),
    createdAt,
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
}
