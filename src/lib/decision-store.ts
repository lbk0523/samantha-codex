import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compactEntityId } from "./ids";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord, OrchestratorQuestionDraftPayload } from "./orchestrator-store";

export type DecisionStatus = "pending" | "resolved" | "archived";
export type DecisionKind =
  | "manual"
  | "orchestrator_plan_approval"
  | "orchestrator_questions"
  | "blocker_clarification"
  | "risk_acceptance";
export type DecisionResolution = "approved" | "rejected" | "needs_revision" | "answered" | "canceled";
export type DecisionSubjectType = "manual" | "orchestrator_plan" | "remote_action" | "task" | "run";

export interface DecisionSubject {
  type: DecisionSubjectType;
  id: string;
}

export interface DecisionItem {
  schemaVersion: 1;
  id: string;
  status: DecisionStatus;
  kind: DecisionKind;
  title: string;
  prompt: string;
  options: string[];
  source: "local" | "remote" | "system";
  subject?: DecisionSubject;
  risk?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: "bk";
  resolution?: DecisionResolution;
  resolutionNote?: string;
  archivedAt?: string;
  archiveReason?: string;
}

export interface CreateDecisionItemInput {
  kind?: DecisionKind;
  title: string;
  prompt: string;
  createdAt: string;
  source?: DecisionItem["source"];
  subject?: DecisionSubject;
  options?: string[];
  risk?: string;
}

export function decisionLifecycleStatus(decision: DecisionItem): string {
  if (decision.status === "resolved") return decision.resolution ?? "resolved";
  return decision.status;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function nonEmptyOptions(options: string[] | undefined): string[] {
  const values = [...new Set((options ?? ["approve", "reject", "revise"]).map(oneLine).filter(Boolean))];
  if (values.length === 0) throw new Error("decision options are required");
  return values;
}

function planApprovalPrompt(plan: OrchestratorPlanRecord): string {
  const base = "Approve, request revision, or cancel before Samantha materializes worker tasks.";
  const payload = plan.payload;
  if (!payload) return base;

  const advisory = [
    payload.selectedApproach ? `Selected approach: ${oneLine(payload.selectedApproach)}` : "",
    payload.rejectedAlternatives?.length
      ? `Rejected alternatives are advisory only: ${payload.rejectedAlternatives.map((item) => oneLine(item.title)).filter(Boolean).join(" / ")}`
      : "",
    payload.tradeoffs?.length ? `Tradeoffs: ${payload.tradeoffs.map(oneLine).filter(Boolean).join(" / ")}` : "",
  ].filter(Boolean);

  return advisory.length ? `${base} ${advisory.join(" ")}` : base;
}

export function buildDecisionItemId(input: {
  createdAt: string;
  title: string;
  subject?: DecisionSubject;
}): string {
  const subject = input.subject ? `${input.subject.type}-${input.subject.id}` : "manual";
  return compactEntityId({
    prefix: "decision",
    createdAt: input.createdAt,
    label: input.title,
    source: `${subject}-${input.title}`,
  });
}

export function createDecisionItem(input: CreateDecisionItemInput): DecisionItem {
  const title = oneLine(input.title);
  const prompt = oneLine(input.prompt);
  if (!title) throw new Error("decision title is required");
  if (!prompt) throw new Error("decision prompt is required");

  return {
    schemaVersion: 1,
    id: buildDecisionItemId({ createdAt: input.createdAt, title, subject: input.subject }),
    status: "pending",
    kind: input.kind ?? "manual",
    title,
    prompt,
    options: nonEmptyOptions(input.options),
    source: input.source ?? "local",
    subject: input.subject,
    risk: input.risk ? oneLine(input.risk) : undefined,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function decisionFromOrchestratorPlan(input: {
  plan: OrchestratorPlanRecord;
  request?: OrchestrationRequestRecord;
  createdAt: string;
  source?: DecisionItem["source"];
}): DecisionItem | undefined {
  const summary = oneLine(input.plan.payload?.summary ?? input.request?.text ?? input.plan.requestId);
  const risks = input.plan.payload?.risks.map(oneLine).filter(Boolean) ?? [];

  if (input.plan.status === "questions") {
    const questions = input.plan.payload?.questions.map(oneLine).filter(Boolean) ?? [];
    return createDecisionItem({
      kind: "orchestrator_questions",
      title: `Answer plan questions: ${summary}`,
      prompt: questions.length ? questions.join(" / ") : "BK input is required before this plan can proceed.",
      options: ["answer", "revise", "cancel"],
      risk: risks.join(" / ") || undefined,
      subject: { type: "orchestrator_plan", id: input.plan.id },
      source: input.source ?? "system",
      createdAt: input.createdAt,
    });
  }

  if (input.plan.status === "planned") {
    return createDecisionItem({
      kind: "orchestrator_plan_approval",
      title: `Review plan: ${summary}`,
      prompt: planApprovalPrompt(input.plan),
      options: ["approve", "revise", "cancel"],
      risk: risks.join(" / ") || undefined,
      subject: { type: "orchestrator_plan", id: input.plan.id },
      source: input.source ?? "system",
      createdAt: input.createdAt,
    });
  }

  return undefined;
}

export function decisionFromQuestionDraft(input: {
  payload: OrchestratorQuestionDraftPayload;
  subject?: DecisionSubject;
  createdAt: string;
  source?: DecisionItem["source"];
}): DecisionItem {
  return createDecisionItem({
    kind: "blocker_clarification",
    title: input.payload.title,
    prompt: input.payload.prompt,
    options: input.payload.options,
    risk: input.payload.risk,
    subject: input.subject,
    source: input.source ?? "system",
    createdAt: input.createdAt,
  });
}

export function decisionAllowsOrchestratorMaterialization(decision: DecisionItem | undefined): boolean {
  return decision?.status === "resolved" && decision.resolution === "approved";
}

export function decisionHasCurrentPlanSubject(decision: DecisionItem, plans: OrchestratorPlanRecord[]): boolean {
  if (decision.subject?.type !== "orchestrator_plan") return true;
  const plan = plans.find((item) => item.id === decision.subject?.id);
  return Boolean(plan && (plan.status === "planned" || plan.status === "questions"));
}

export function decisionIsCurrentPlanApproval(decision: DecisionItem, plans: OrchestratorPlanRecord[]): boolean {
  if (decision.status !== "pending") return false;
  if (decision.kind !== "orchestrator_plan_approval") return false;
  if (!decision.options.includes("approve")) return false;
  if (decision.subject?.type !== "orchestrator_plan") return false;
  const plan = plans.find((item) => item.id === decision.subject?.id);
  return plan?.status === "planned";
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
  const raw = items.map((item) => JSON.stringify(item)).join("\n");
  await writeFile(path, raw.length > 0 ? `${raw}\n` : "", "utf8");
}

export class DecisionStore {
  constructor(private readonly path: string) {}

  async list(): Promise<DecisionItem[]> {
    return readJsonLines<DecisionItem>(this.path);
  }

  async listPending(): Promise<DecisionItem[]> {
    return (await this.list()).filter((decision) => decision.status === "pending");
  }

  async latestPending(predicate: (decision: DecisionItem) => boolean = () => true): Promise<DecisionItem | undefined> {
    return (await this.list())
      .slice()
      .reverse()
      .find((decision) => decision.status === "pending" && predicate(decision));
  }

  async find(id: string): Promise<DecisionItem | undefined> {
    return (await this.list()).find((decision) => decision.id === id);
  }

  async latestForSubject(subject: DecisionSubject): Promise<DecisionItem | undefined> {
    return (await this.list())
      .slice()
      .reverse()
      .find((decision) => decision.subject?.type === subject.type && decision.subject.id === subject.id && decision.status !== "archived");
  }

  async append(decision: DecisionItem): Promise<void> {
    const decisions = await this.list();
    if (decisions.some((existing) => existing.id === decision.id)) {
      throw new Error(`decision already exists: ${decision.id}`);
    }
    await writeJsonLines(this.path, [...decisions, decision]);
  }

  async create(input: CreateDecisionItemInput): Promise<DecisionItem> {
    const decision = createDecisionItem(input);
    await this.append(decision);
    return decision;
  }

  async resolve(
    id: string,
    input: { resolvedAt: string; resolution: DecisionResolution; note?: string },
  ): Promise<DecisionItem> {
    return this.update(id, (decision) => {
      if (decision.status !== "pending") throw new Error(`decision must be pending: ${decision.status}`);
      return {
        ...decision,
        status: "resolved",
        updatedAt: input.resolvedAt,
        resolvedAt: input.resolvedAt,
        resolvedBy: "bk",
        resolution: input.resolution,
        resolutionNote: input.note ? oneLine(input.note) : undefined,
      };
    });
  }

  async resolveLatestPending(
    input: {
      resolvedAt: string;
      resolution: DecisionResolution;
      note?: string;
      predicate?: (decision: DecisionItem) => boolean;
    },
  ): Promise<DecisionItem | undefined> {
    const decision = await this.latestPending(input.predicate);
    if (!decision) return undefined;
    return this.resolve(decision.id, input);
  }

  async archive(id: string, input: { archivedAt: string; reason: string }): Promise<DecisionItem> {
    return this.update(id, (decision) => {
      if (decision.status === "archived") throw new Error("decision already archived");
      const reason = oneLine(input.reason);
      if (!reason) throw new Error("decision archive reason is required");
      return {
        ...decision,
        status: "archived",
        updatedAt: input.archivedAt,
        archivedAt: input.archivedAt,
        archiveReason: reason,
      };
    });
  }

  private async update(id: string, update: (decision: DecisionItem) => DecisionItem): Promise<DecisionItem> {
    const decisions = await this.list();
    const index = decisions.findIndex((decision) => decision.id === id);
    if (index === -1) throw new Error(`decision not found: ${id}`);

    const updated = update(decisions[index]);
    const next = [...decisions];
    next[index] = updated;
    await writeJsonLines(this.path, next);
    return updated;
  }
}
