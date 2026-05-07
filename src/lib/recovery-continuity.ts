import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "./orchestrator-store";
import type { RemoteActionRecord } from "./remote-action-store";

function actionPassed(action: RemoteActionRecord | undefined): boolean {
  return Boolean(action && action.status === "completed" && action.result?.pass !== false);
}

export function recoveryResolvedPlanIds(input: {
  requests: OrchestrationRequestRecord[];
  plans: OrchestratorPlanRecord[];
  actions: RemoteActionRecord[];
}): Set<string> {
  const actionsById = new Map(input.actions.map((action) => [action.id, action]));
  const resolved = new Set<string>();

  for (const request of input.requests) {
    if (!request.recoveryOfPlanId) continue;
    const recoveryPlans = input.plans.filter(
      (plan) =>
        plan.requestId === request.id &&
        plan.status === "materialized" &&
        Boolean(plan.resultReportedAt) &&
        plan.synthesis?.outcome === "pass",
    );
    const fixed = recoveryPlans.some((plan) => {
      const actionIds = plan.actionIds ?? [];
      return actionIds.length > 0 && actionIds.every((id) => actionPassed(actionsById.get(id)));
    });
    if (fixed) resolved.add(request.recoveryOfPlanId);
  }

  return resolved;
}
