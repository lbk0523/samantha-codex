import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskResultMode } from "./contracts";
import { compactEntityId } from "./ids";

export type AutopilotTransition =
  | "remote_intake"
  | "classify_request"
  | "run_readonly_plan"
  | "materialize_report_task"
  | "dispatch_report_task"
  | "record_autopilot_evidence";

export type AutopilotEndpoint = "result" | "bk_judgment" | "local_only_blocker";
export type AutopilotEvidenceStatus = "completed" | "blocked" | "failed";

export interface AutopilotBkCorrection {
  commandId: string;
  correction: "revised" | "canceled" | "rejected" | "corrected";
  recordedAt: string;
  note?: string;
}

export interface AutopilotEvidenceRecord {
  schemaVersion: 1;
  id: string;
  requestId: string;
  planId?: string;
  authorityGrantId?: string;
  projectId?: string;
  scopeId?: string;
  resultMode?: TaskResultMode;
  startedAt: string;
  completedAt: string;
  transitions: AutopilotTransition[];
  endpoint: AutopilotEndpoint;
  status: AutopilotEvidenceStatus;
  actionIds?: string[];
  runIds?: string[];
  failure?: string;
  bkCorrection?: AutopilotBkCorrection;
  summary: string;
}

export interface CreateAutopilotEvidenceInput {
  requestId: string;
  planId?: string;
  authorityGrantId?: string;
  projectId?: string;
  scopeId?: string;
  resultMode?: TaskResultMode;
  startedAt: string;
  completedAt: string;
  transitions: AutopilotTransition[];
  endpoint: AutopilotEndpoint;
  status: AutopilotEvidenceStatus;
  actionIds?: string[];
  runIds?: string[];
  failure?: string;
  summary: string;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function nonEmpty(value: string, label: string): string {
  const normalized = oneLine(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function validTimestamp(value: string, label: string): string {
  const normalized = nonEmpty(value, label);
  if (Number.isNaN(new Date(normalized).getTime())) throw new Error(`${label} must be a valid date`);
  return normalized;
}

function stringList(value: string[] | undefined): string[] | undefined {
  const values = [...new Set((value ?? []).map(oneLine).filter(Boolean))];
  return values.length ? values : undefined;
}

export function buildAutopilotEvidenceId(input: CreateAutopilotEvidenceInput): string {
  return compactEntityId({
    prefix: "autopilot-evidence",
    createdAt: input.completedAt,
    label: input.requestId,
    source: [
      input.requestId,
      input.planId ?? "",
      input.authorityGrantId ?? "",
      input.status,
      input.endpoint,
      input.transitions.join(","),
    ].join("|"),
  });
}

export function createAutopilotEvidence(input: CreateAutopilotEvidenceInput): AutopilotEvidenceRecord {
  const record: AutopilotEvidenceRecord = {
    schemaVersion: 1,
    id: buildAutopilotEvidenceId(input),
    requestId: nonEmpty(input.requestId, "autopilot evidence requestId"),
    planId: input.planId ? oneLine(input.planId) : undefined,
    authorityGrantId: input.authorityGrantId ? oneLine(input.authorityGrantId) : undefined,
    projectId: input.projectId ? oneLine(input.projectId) : undefined,
    scopeId: input.scopeId ? oneLine(input.scopeId) : undefined,
    resultMode: input.resultMode,
    startedAt: validTimestamp(input.startedAt, "autopilot evidence startedAt"),
    completedAt: validTimestamp(input.completedAt, "autopilot evidence completedAt"),
    transitions: [...new Set(input.transitions)],
    endpoint: input.endpoint,
    status: input.status,
    actionIds: stringList(input.actionIds),
    runIds: stringList(input.runIds),
    failure: input.failure ? oneLine(input.failure) : undefined,
    summary: nonEmpty(input.summary, "autopilot evidence summary"),
  };
  if (record.transitions.length === 0) throw new Error("autopilot evidence transitions must not be empty");
  return record;
}

export class AutopilotEvidenceStore {
  constructor(private readonly path: string) {}

  async list(): Promise<AutopilotEvidenceRecord[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AutopilotEvidenceRecord);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async append(record: AutopilotEvidenceRecord): Promise<void> {
    createAutopilotEvidence(record);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}
