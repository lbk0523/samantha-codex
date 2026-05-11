import type { OrchestratorPlanRecord } from "./orchestrator-store";

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function planUpdatedAt(plan: OrchestratorPlanRecord): string {
  return (
    plan.synthesisAt ??
    plan.resultReportedAt ??
    plan.materializedAt ??
    plan.approvedAt ??
    plan.completedAt ??
    plan.createdAt
  );
}

export function orchestratorPlanNeedsRecovery(plan: OrchestratorPlanRecord): boolean {
  return plan.status === "failed" || Boolean(plan.synthesisFailure) || Boolean(plan.synthesis && plan.synthesis.outcome !== "pass");
}

export function planRecoverySupersededByLaterPlan(plan: OrchestratorPlanRecord, plans: OrchestratorPlanRecord[]): boolean {
  if (!orchestratorPlanNeedsRecovery(plan)) return false;
  const updatedAt = timestamp(planUpdatedAt(plan));
  return plans.some((candidate) =>
    candidate.id !== plan.id &&
    candidate.requestId === plan.requestId &&
    !orchestratorPlanNeedsRecovery(candidate) &&
    timestamp(planUpdatedAt(candidate)) > updatedAt,
  );
}

export function currentOrchestratorPlanNeedsRecovery(plan: OrchestratorPlanRecord, plans: OrchestratorPlanRecord[]): boolean {
  return orchestratorPlanNeedsRecovery(plan) && !planRecoverySupersededByLaterPlan(plan, plans);
}
