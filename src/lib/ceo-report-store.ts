import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkItemAncestry } from "./ancestry";
import type { CeoOverall, CeoNextActionKind, CeoStatusSnapshot } from "./ceo-status";
import { compactEntityId } from "./ids";

export type NotificationUrgency = "urgent" | "low_risk";
export type NotificationThrottleDecision = "delivered" | "coalesced_digest";

export interface NotificationThrottleMetadata {
  throttleKey: string;
  notificationUrgency: NotificationUrgency;
  throttleDecision: NotificationThrottleDecision;
  throttleReason: string;
  throttleBypassReasons?: string[];
  digestWindowStartedAt: string;
  digestWindowEndsAt: string;
}

export interface CeoNotifyReportRecord extends Partial<NotificationThrottleMetadata> {
  schemaVersion: 1;
  id: string;
  ancestry?: WorkItemAncestry;
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

export interface NotificationDigestRecord extends NotificationThrottleMetadata {
  schemaVersion: 1;
  id: string;
  ancestry?: WorkItemAncestry;
  kind: "notification_digest";
  generatedAt: string;
  sourceReportId: string;
  sourceOutboxFile: string;
  coalescedCount: number;
  overall: CeoOverall;
  nextActionKind: CeoNextActionKind;
  decisionCount: number;
  activeCount: number;
  blockedCount: number;
  riskCount: number;
}

export type CeoReportRecord = CeoNotifyReportRecord | NotificationDigestRecord;

export const DEFAULT_NOTIFICATION_DIGEST_WINDOW_MS = 6 * 60 * 60 * 1000;

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

export function notificationDigestWindow(input: {
  generatedAt: string;
  windowMs?: number;
}): { startedAt: string; endsAt: string } {
  const windowMs = input.windowMs ?? DEFAULT_NOTIFICATION_DIGEST_WINDOW_MS;
  const generatedMs = Date.parse(input.generatedAt);
  const startMs = Math.floor((Number.isFinite(generatedMs) ? generatedMs : 0) / windowMs) * windowMs;
  return {
    startedAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + windowMs).toISOString(),
  };
}

function stableItems(items: Array<{ kind: string; id: string; status: string; title: string; detail?: string }>): unknown[] {
  return items.map((item) => ({
    kind: item.kind,
    id: item.id,
    status: item.status,
    title: item.title,
    detail: item.detail,
  }));
}

function throttleBypassReasons(snapshot: CeoStatusSnapshot): string[] {
  const pressure = snapshot.projectQueues?.pressure;
  return [
    ...(snapshot.needsDecision.length ? [`pending BK decisions=${snapshot.needsDecision.length}`] : []),
    ...(snapshot.blocked.length ? [`blocked or recovery items=${snapshot.blocked.length}`] : []),
    ...(snapshot.historicalFailures.length ? [`historical failures=${snapshot.historicalFailures.length}`] : []),
    ...(snapshot.overall === "failed" ||
    snapshot.overall === "needs_recovery" ||
    snapshot.overall === "blocked" ||
    snapshot.overall === "needs_decision"
      ? [`overall=${snapshot.overall}`]
      : []),
    ...(pressure?.metrics.unsafeHostIssues ? [`unsafe host state=${pressure.metrics.unsafeHostIssues}`] : []),
    ...(pressure?.metrics.recoveryNeeds ? [`recovery blockers=${pressure.metrics.recoveryNeeds}`] : []),
    ...(pressure?.metrics.budgetAuditGaps ? [`budget audit gaps=${pressure.metrics.budgetAuditGaps}`] : []),
    ...(pressure?.pressureClass === "block" || pressure?.pressureClass === "needs_bk"
      ? [`queue pressure=${pressure.pressureClass}`]
      : []),
  ];
}

export function classifyNotificationUrgency(snapshot: CeoStatusSnapshot): {
  urgency: NotificationUrgency;
  bypassReasons: string[];
} {
  const bypassReasons = throttleBypassReasons(snapshot);
  return {
    urgency: bypassReasons.length ? "urgent" : "low_risk",
    bypassReasons,
  };
}

export function buildNotificationThrottleKey(snapshot: CeoStatusSnapshot): string {
  const pressure = snapshot.projectQueues?.pressure;
  const source = JSON.stringify({
    kind: "ceo_notify",
    overall: snapshot.overall,
    nextActionKind: snapshot.nextAction.kind,
    active: stableItems(snapshot.active),
    completed: stableItems(snapshot.completed.slice(0, 5)),
    pressure: pressure
      ? {
          class: pressure.pressureClass,
          reasons: pressure.reasons,
          metrics: {
            pendingRequests: pressure.metrics.pendingRequests,
            deferredRequests: pressure.metrics.deferredRequests,
            activeTasks: pressure.metrics.activeTasks,
            activeActions: pressure.metrics.activeActions,
            runningActions: pressure.metrics.runningActions,
            runLifecycleGaps: pressure.metrics.runLifecycleGaps,
          },
        }
      : undefined,
    projectFilterId: snapshot.projectFilterId,
  });

  return compactEntityId({
    prefix: "notification-key",
    createdAt: "1970-01-01T00:00:00.000Z",
    label: snapshot.overall,
    source,
  });
}

export function buildNotificationDigestId(input: {
  generatedAt: string;
  sourceReportId: string;
  throttleKey: string;
}): string {
  return compactEntityId({
    prefix: "notification-digest",
    createdAt: input.generatedAt,
    label: "coalesced",
    source: `${input.generatedAt}-${input.sourceReportId}-${input.throttleKey}`,
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

  async findDeliveredInDigestWindow(input: {
    throttleKey: string;
    generatedAt: string;
    windowMs?: number;
  }): Promise<CeoNotifyReportRecord | undefined> {
    const window = notificationDigestWindow(input);
    return (await this.list())
      .filter((item): item is CeoNotifyReportRecord => item.kind === "ceo_notify")
      .filter((item) => item.notificationUrgency === "low_risk")
      .filter((item) => item.throttleKey === input.throttleKey)
      .filter((item) => item.generatedAt >= window.startedAt && item.generatedAt < window.endsAt)
      .sort((left, right) => left.generatedAt.localeCompare(right.generatedAt))[0];
  }

  async countDigestsForSource(sourceReportId: string): Promise<number> {
    return (await this.list()).filter((item) => item.kind === "notification_digest" && item.sourceReportId === sourceReportId).length;
  }

  async append(record: CeoReportRecord): Promise<CeoReportRecord> {
    const reports = await this.list();
    const existing = reports.find((item) => item.id === record.id);
    if (existing) return existing;
    await writeJsonLines(this.path, [...reports, record]);
    return record;
  }
}
