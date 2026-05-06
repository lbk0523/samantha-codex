import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compactEntityId } from "./ids";

export type ProposalStatus = "pending_review" | "accepted" | "rejected";

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
