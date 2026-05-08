import type { CeoDecisionSummary, CeoNextAction, CeoStatusItem, CeoStatusSnapshot } from "./ceo-status";

export interface OperatingSurfaceAction {
  kind: CeoNextAction["kind"];
  label: string;
  reason: string;
  telegramCommand?: string;
  localCommand?: string;
  auditRef?: string;
}

export interface OperatingSurfaceItem {
  title: string;
  status: string;
  detail?: string;
  text: string;
  auditRef: string;
}

export interface OperatingSurfaceView {
  generatedAt: string;
  overall: CeoStatusSnapshot["overall"];
  headline: string;
  summary: string;
  primaryAction: OperatingSurfaceAction;
  sections: {
    needsDecision: OperatingSurfaceItem[];
    active: OperatingSurfaceItem[];
    blocked: OperatingSurfaceItem[];
    historicalFailures: OperatingSurfaceItem[];
    completed: OperatingSurfaceItem[];
    risks: string[];
  };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function singleTelegramCommand(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed?.startsWith("/")) return undefined;
  if (trimmed.includes(" or ")) return undefined;
  return trimmed;
}

function fallbackTelegramCommand(nextAction: CeoNextAction): string {
  if (nextAction.kind === "plan") return "/plan";
  if (nextAction.kind === "review_plan" || nextAction.kind === "answer_questions") return "/plan_current";
  if (nextAction.kind === "resolve_decision") return "/now";
  if (nextAction.kind === "approve_action") return "/problems";
  if (nextAction.kind === "watch_action") return "/now";
  if (nextAction.kind === "merge_check" || nextAction.kind === "push" || nextAction.kind === "cleanup") return "/go";
  if (nextAction.kind === "recover") return "/recover";
  if (nextAction.kind === "diagnose") return "/problems";
  return "/check";
}

function decisionTelegramCommand(decision: CeoDecisionSummary | undefined): string | undefined {
  if (!decision) return undefined;
  if (decision.kind === "decision") {
    if (decision.decisionKind === "blocker_clarification") return "/revise <답변>";
    if (decision.options?.includes("approve")) return "/approve";
    return "/now";
  }
  if (decision.status === "questions") return "/plan_current";
  return "/plan_current";
}

function telegramCommandForSnapshot(snapshot: CeoStatusSnapshot): string {
  return (
    decisionTelegramCommand(snapshot.needsDecision[0]) ??
    singleTelegramCommand(snapshot.nextAction.command) ??
    fallbackTelegramCommand(snapshot.nextAction)
  );
}

function localCommandForNextAction(nextAction: CeoNextAction): string | undefined {
  const command = nextAction.command?.trim();
  if (!command || command.startsWith("/")) return undefined;
  return command;
}

function headlineFor(snapshot: CeoStatusSnapshot): string {
  if (snapshot.needsDecision.length > 0) return "BK decision is the current operating blocker.";
  if (snapshot.blocked.length > 0) return "Current work is blocked and needs recovery review.";
  if (snapshot.overall === "failed") return "Samantha operations need diagnostic attention.";
  if (snapshot.active.length > 0) return "Samantha has active work in progress.";
  if (snapshot.historicalFailures.length > 0) return "No current blocker, but historical failures remain visible.";
  return "No active work needs BK right now.";
}

function itemText(input: { title: string; status: string; detail?: string }): string {
  const detail = input.detail ? ` - ${oneLine(input.detail)}` : "";
  return `${oneLine(input.title)} (${input.status})${detail}`;
}

function decisionItem(decision: CeoDecisionSummary): OperatingSurfaceItem {
  return {
    title: decision.title,
    status: decision.status,
    detail: decision.reason,
    text: itemText({ title: decision.title, status: decision.status, detail: decision.reason }),
    auditRef: `${decision.kind}:${decision.id}`,
  };
}

function statusItem(item: CeoStatusItem): OperatingSurfaceItem {
  return {
    title: item.title,
    status: item.status,
    detail: item.detail,
    text: itemText(item),
    auditRef: `${item.kind}:${item.id}`,
  };
}

export function buildOperatingSurfaceView(snapshot: CeoStatusSnapshot): OperatingSurfaceView {
  const telegramCommand = telegramCommandForSnapshot(snapshot);
  const localCommand = localCommandForNextAction(snapshot.nextAction);

  return {
    generatedAt: snapshot.generatedAt,
    overall: snapshot.overall,
    headline: headlineFor(snapshot),
    summary: `decisions=${snapshot.needsDecision.length} active=${snapshot.active.length} blocked=${snapshot.blocked.length} historical_failures=${snapshot.historicalFailures.length} completed=${snapshot.completed.length} risks=${snapshot.risks.length}`,
    primaryAction: {
      kind: snapshot.nextAction.kind,
      label: snapshot.nextAction.label,
      reason: snapshot.nextAction.reason,
      telegramCommand,
      ...(localCommand ? { localCommand } : {}),
      ...(snapshot.nextAction.targetId ? { auditRef: `${snapshot.nextAction.kind}:${snapshot.nextAction.targetId}` } : {}),
    },
    sections: {
      needsDecision: snapshot.needsDecision.map(decisionItem),
      active: snapshot.active.map(statusItem),
      blocked: snapshot.blocked.map(statusItem),
      historicalFailures: snapshot.historicalFailures.map(statusItem),
      completed: snapshot.completed.map(statusItem),
      risks: snapshot.risks.map(oneLine).filter(Boolean),
    },
  };
}
