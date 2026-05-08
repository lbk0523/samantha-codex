import type { OrchestratorPlanRecord } from "./orchestrator-store";

export interface OrchestratorPlanBlockedNextAction {
  label: string;
  command: "/revise <피드백>";
  reason: string;
}

export interface OrchestratorPlanBlocker {
  planId: string;
  requestId: string;
  violations: string[];
  nextAction: OrchestratorPlanBlockedNextAction;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function planPayloadBlockerViolations(plan: OrchestratorPlanRecord): string[] {
  const payload = plan.payload;
  if (!payload) return [];

  return [
    ...(payload.prerequisites ?? []).map((item) => `prerequisite: ${oneLine(item)}`),
    ...(payload.blockers ?? []).map((item) => `blocker: ${oneLine(item)}`),
  ].filter(Boolean);
}

export function createOrchestratorPlanBlocker(input: {
  plan: OrchestratorPlanRecord;
  violations: string[];
}): OrchestratorPlanBlocker {
  const violations = input.violations.map(oneLine).filter(Boolean);
  const reason = violations[0] ?? "Plan has unresolved prerequisites or blockers.";
  return {
    planId: input.plan.id,
    requestId: input.plan.requestId,
    violations,
    nextAction: {
      label: "Revise the current orchestrator plan before materialization",
      command: "/revise <피드백>",
      reason,
    },
  };
}

export function payloadBlockerForPlan(plan: OrchestratorPlanRecord): OrchestratorPlanBlocker | undefined {
  const violations = planPayloadBlockerViolations(plan);
  if (violations.length === 0) return undefined;
  return createOrchestratorPlanBlocker({ plan, violations });
}

export function blockerForPlan(
  blockers: OrchestratorPlanBlocker[] | undefined,
  planId: string,
): OrchestratorPlanBlocker | undefined {
  return blockers?.find((blocker) => blocker.planId === planId);
}

const hostOnlyRuntimePatterns = [
  /\bbun\s+run\s+(?:test:host|test:all|verify:host)\b/i,
  /\b(?:bun\s+run\s+)?(?:samantha|src\/samantha\.ts)\s+(?:inbox:watch|actions:watch|telegram:poll|telegram:reply|dashboard:serve)\b/i,
];

export function hostOnlyRuntimeViolations(input: {
  setupCommands?: string[];
  verifyCommands?: string[];
  instructions?: string;
}): string[] {
  const values = [
    ...(input.setupCommands ?? []).map((command, index) => ({ label: `setupCommands[${index}]`, value: command })),
    ...(input.verifyCommands ?? []).map((command, index) => ({ label: `verifyCommands[${index}]`, value: command })),
    input.instructions ? { label: "instructions", value: input.instructions } : undefined,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  return values.flatMap((item) =>
    hostOnlyRuntimePatterns.some((pattern) => pattern.test(item.value))
      ? [`${item.label} contains a host-only runtime requirement; report it as a blocker/next action instead of a worker task command`]
      : [],
  );
}
