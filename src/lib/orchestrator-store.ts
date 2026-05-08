import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandRunResult } from "./worker-dispatch";
import { compactEntityId } from "./ids";
import type { RemoteRequestClassification } from "./project-profile";

export type OrchestrationRequestStatus = "pending_plan" | "planned" | "discarded";
export type OrchestratorPlanStatus = "planned" | "questions" | "failed" | "approved" | "materialized" | "superseded" | "canceled";

export interface OrchestrationRequestRecord {
  schemaVersion: 1;
  id: string;
  source: "remote" | "local";
  senderId?: string;
  text: string;
  status: OrchestrationRequestStatus;
  createdAt: string;
  recoveryOfPlanId?: string;
  plannedAt?: string;
  discardedAt?: string;
}

export interface OrchestratorTaskProposal {
  id: string;
  title: string;
  targetAgent: string;
  projectId?: string;
  repoRoot?: string;
  resultMode?: "write" | "report";
  targetFiles: string[];
  forbiddenChanges: string[];
  setupCommands?: string[];
  verifyCommands: string[];
  instructions: string;
  dependencies?: string[];
}

export interface OrchestratorRejectedAlternative {
  title: string;
  reason: string;
  tradeoffs?: string[];
}

export interface OrchestratorPlanPayload {
  summary: string;
  assumptions: string[];
  questions: string[];
  prerequisites?: string[];
  blockers?: string[];
  scope: string[];
  nonScope: string[];
  risks: string[];
  selectedApproach?: string;
  rejectedAlternatives?: OrchestratorRejectedAlternative[];
  tradeoffs?: string[];
  tasks: OrchestratorTaskProposal[];
  batches: string[][];
  userMessage: string;
}

export interface OrchestratorSynthesisPayload {
  outcome: "pass" | "failed" | "mixed";
  summary: string;
  nextActions: string[];
  risks: string[];
  userMessage: string;
}

export interface OrchestratorQuestionDraftPayload {
  title: string;
  prompt: string;
  options: string[];
  risk?: string;
  userMessage: string;
}

export interface OrchestratorPlanRecord {
  schemaVersion: 1;
  id: string;
  requestId: string;
  status: OrchestratorPlanStatus;
  createdAt: string;
  completedAt?: string;
  approvedAt?: string;
  materializedAt?: string;
  supersededAt?: string;
  supersededByRequestId?: string;
  canceledAt?: string;
  cancelReason?: string;
  resultReportedAt?: string;
  synthesisAt?: string;
  synthesis?: OrchestratorSynthesisPayload;
  synthesisFailure?: string;
  taskIds?: string[];
  actionIds?: string[];
  command?: CommandRunResult;
  rawOutput?: string;
  payload?: OrchestratorPlanPayload;
  classification?: RemoteRequestClassification;
  failure?: string;
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

export function buildOrchestrationRequestId(receivedAt: string, disambiguator?: string | number): string {
  const source = disambiguator === undefined ? receivedAt : `${receivedAt}-${disambiguator}`;
  return compactEntityId({
    prefix: "request",
    createdAt: receivedAt,
    label: disambiguator === undefined ? "work" : String(disambiguator),
    source,
  });
}

export function buildOrchestratorPlanId(input: { requestId: string; createdAt: string }): string {
  return compactEntityId({
    prefix: "plan",
    createdAt: input.createdAt,
    label: input.requestId.replace(/^request-/, ""),
    source: `${input.createdAt}-${input.requestId}`,
  });
}

export class OrchestrationRequestStore {
  constructor(private readonly path: string) {}

  async list(): Promise<OrchestrationRequestRecord[]> {
    return readJsonLines<OrchestrationRequestRecord>(this.path);
  }

  async find(id: string): Promise<OrchestrationRequestRecord | undefined> {
    return (await this.list()).find((request) => request.id === id);
  }

  async append(request: OrchestrationRequestRecord): Promise<void> {
    const requests = await this.list();
    if (requests.some((existing) => existing.id === request.id)) {
      throw new Error(`orchestration request already exists: ${request.id}`);
    }
    await writeJsonLines(this.path, [...requests, request]);
  }

  async latestPending(): Promise<OrchestrationRequestRecord | undefined> {
    return (await this.list()).slice().reverse().find((request) => request.status === "pending_plan");
  }

  async markPlanned(id: string, plannedAt: string): Promise<OrchestrationRequestRecord> {
    return this.update(id, (request) => {
      if (request.status !== "pending_plan") return request;
      return { ...request, status: "planned", plannedAt };
    });
  }

  async markDiscarded(id: string, input: { discardedAt: string }): Promise<OrchestrationRequestRecord> {
    return this.update(id, (request) => {
      if (request.status !== "pending_plan") throw new Error(`orchestration request must be pending_plan: ${request.status}`);
      return { ...request, status: "discarded", discardedAt: input.discardedAt };
    });
  }

  private async update(
    id: string,
    update: (request: OrchestrationRequestRecord) => OrchestrationRequestRecord,
  ): Promise<OrchestrationRequestRecord> {
    const requests = await this.list();
    const index = requests.findIndex((request) => request.id === id);
    if (index === -1) throw new Error(`orchestration request not found: ${id}`);

    const updated = update(requests[index]);
    const next = [...requests];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }
}

export class OrchestratorPlanStore {
  constructor(private readonly path: string) {}

  async list(): Promise<OrchestratorPlanRecord[]> {
    return readJsonLines<OrchestratorPlanRecord>(this.path);
  }

  async find(id: string): Promise<OrchestratorPlanRecord | undefined> {
    return (await this.list()).find((plan) => plan.id === id);
  }

  async append(plan: OrchestratorPlanRecord): Promise<void> {
    const plans = await this.list();
    if (plans.some((existing) => existing.id === plan.id)) {
      throw new Error(`orchestrator plan already exists: ${plan.id}`);
    }
    await writeJsonLines(this.path, [...plans, plan]);
  }

  async latestForRequest(requestId: string): Promise<OrchestratorPlanRecord | undefined> {
    return (await this.list()).slice().reverse().find((plan) => plan.requestId === requestId);
  }

  async latestActionable(): Promise<OrchestratorPlanRecord | undefined> {
    return (await this.list())
      .slice()
      .reverse()
      .find((plan) => plan.status === "planned" || plan.status === "questions");
  }

  async markMaterialized(
    id: string,
    input: { approvedAt: string; materializedAt: string; taskIds: string[]; actionIds: string[] },
  ): Promise<OrchestratorPlanRecord> {
    const plans = await this.list();
    const index = plans.findIndex((plan) => plan.id === id);
    if (index === -1) throw new Error(`orchestrator plan not found: ${id}`);
    const plan = plans[index];
    if (plan.status !== "planned") throw new Error(`orchestrator plan must be planned: ${plan.status}`);

    const updated: OrchestratorPlanRecord = {
      ...plan,
      status: "materialized",
      approvedAt: input.approvedAt,
      materializedAt: input.materializedAt,
      taskIds: input.taskIds,
      actionIds: input.actionIds,
    };
    const next = [...plans];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }

  async markSuperseded(
    id: string,
    input: { supersededAt: string; supersededByRequestId: string },
  ): Promise<OrchestratorPlanRecord> {
    const plans = await this.list();
    const index = plans.findIndex((plan) => plan.id === id);
    if (index === -1) throw new Error(`orchestrator plan not found: ${id}`);
    const plan = plans[index];
    if (plan.status !== "planned" && plan.status !== "questions" && plan.status !== "failed") {
      throw new Error(`orchestrator plan cannot be superseded: ${plan.status}`);
    }

    const updated: OrchestratorPlanRecord = {
      ...plan,
      status: "superseded",
      supersededAt: input.supersededAt,
      supersededByRequestId: input.supersededByRequestId,
    };
    const next = [...plans];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }

  async markCanceled(
    id: string,
    input: { canceledAt: string; cancelReason?: string },
  ): Promise<OrchestratorPlanRecord> {
    const plans = await this.list();
    const index = plans.findIndex((plan) => plan.id === id);
    if (index === -1) throw new Error(`orchestrator plan not found: ${id}`);
    const plan = plans[index];
    if (plan.status !== "planned" && plan.status !== "questions") {
      throw new Error(`orchestrator plan cannot be canceled: ${plan.status}`);
    }

    const updated: OrchestratorPlanRecord = {
      ...plan,
      status: "canceled",
      canceledAt: input.canceledAt,
      cancelReason: input.cancelReason,
    };
    const next = [...plans];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }

  async markResultReported(
    id: string,
    input: {
      resultReportedAt: string;
      synthesisAt?: string;
      synthesis?: OrchestratorSynthesisPayload;
      synthesisFailure?: string;
    },
  ): Promise<OrchestratorPlanRecord> {
    const plans = await this.list();
    const index = plans.findIndex((plan) => plan.id === id);
    if (index === -1) throw new Error(`orchestrator plan not found: ${id}`);
    const updated: OrchestratorPlanRecord = {
      ...plans[index],
      resultReportedAt: input.resultReportedAt,
      synthesisAt: input.synthesisAt,
      synthesis: input.synthesis,
      synthesisFailure: input.synthesisFailure,
    };
    const next = [...plans];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }
}
