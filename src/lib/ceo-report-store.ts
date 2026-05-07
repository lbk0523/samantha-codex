import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CeoOverall, CeoNextActionKind } from "./ceo-status";
import { compactEntityId } from "./ids";

export interface CeoReportRecord {
  schemaVersion: 1;
  id: string;
  kind: "ceo_notify";
  generatedAt: string;
  outboxFile: string;
  outboxPath: string;
  deliveryStatePath: string;
  overall: CeoOverall;
  nextActionKind: CeoNextActionKind;
  decisionCount: number;
  activeCount: number;
  blockedCount: number;
  riskCount: number;
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

export function buildCeoReportId(input: { generatedAt: string; outboxFile: string; overall: CeoOverall }): string {
  return compactEntityId({
    prefix: "ceo-report",
    createdAt: input.generatedAt,
    label: input.overall,
    source: `${input.generatedAt}-${input.outboxFile}`,
  });
}

export class CeoReportStore {
  constructor(private readonly path: string) {}

  async list(): Promise<CeoReportRecord[]> {
    return readJsonLines<CeoReportRecord>(this.path);
  }

  async find(id: string): Promise<CeoReportRecord | undefined> {
    return (await this.list()).find((item) => item.id === id);
  }

  async append(record: CeoReportRecord): Promise<CeoReportRecord> {
    const reports = await this.list();
    const existing = reports.find((item) => item.id === record.id);
    if (existing) return existing;
    await writeJsonLines(this.path, [...reports, record]);
    return record;
  }
}
