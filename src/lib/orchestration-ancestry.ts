import type { WorkItemAncestry } from "./ancestry";
import type { OrchestrationRequestRecord } from "./orchestrator-store";
import { inferProjectProfile, type ProjectProfile } from "./project-profile";
import { sanitizeTaskId } from "./worktree";

export function defaultGoalIdForProject(projectId: string): string {
  return `goal-${sanitizeTaskId(projectId)}-operations`;
}

export function assignedOrchestrationAncestry(input: {
  projectId: string;
  workItemId: string;
  goalId?: string;
}): WorkItemAncestry {
  return {
    mode: "assigned",
    projectId: input.projectId,
    goalId: input.goalId ?? defaultGoalIdForProject(input.projectId),
    workItemId: input.workItemId,
  };
}

export function unassignedOrchestrationAncestry(input: {
  workItemId: string;
  reason: string;
}): WorkItemAncestry {
  return {
    mode: "unassigned",
    workItemId: input.workItemId,
    reason: input.reason,
  };
}

export function selectedProjectIdFromAncestry(ancestry: WorkItemAncestry | undefined): string | undefined {
  return ancestry?.mode === "assigned" ? ancestry.projectId : undefined;
}

export function ancestryForRequestIntake(input: {
  requestId: string;
  requestText: string;
  projectProfiles: ProjectProfile[];
  requestedProjectId?: string;
}): WorkItemAncestry {
  if (input.requestedProjectId) {
    if (!input.projectProfiles.some((project) => project.id === input.requestedProjectId)) {
      throw new Error(`project profile not found: ${input.requestedProjectId}`);
    }
    return assignedOrchestrationAncestry({
      projectId: input.requestedProjectId,
      workItemId: input.requestId,
    });
  }

  try {
    const inferred = inferProjectProfile(input.projectProfiles, { requestText: input.requestText });
    if (inferred) {
      return assignedOrchestrationAncestry({
        projectId: inferred.id,
        workItemId: input.requestId,
      });
    }
  } catch {
    return unassignedOrchestrationAncestry({
      workItemId: input.requestId,
      reason: "project context is ambiguous",
    });
  }

  if (input.projectProfiles.length === 1 && input.projectProfiles[0]) {
    return assignedOrchestrationAncestry({
      projectId: input.projectProfiles[0].id,
      workItemId: input.requestId,
    });
  }

  return unassignedOrchestrationAncestry({
    workItemId: input.requestId,
    reason: "BK has not selected a project yet",
  });
}

export function ancestryForPlan(input: {
  request: OrchestrationRequestRecord;
  projectProfiles: ProjectProfile[];
  requestedProjectId?: string;
}): WorkItemAncestry {
  if (input.requestedProjectId) {
    if (!input.projectProfiles.some((project) => project.id === input.requestedProjectId)) {
      throw new Error(`project profile not found: ${input.requestedProjectId}`);
    }
    if (input.request.ancestry?.mode === "assigned" && input.request.ancestry.projectId !== input.requestedProjectId) {
      throw new Error(
        `requested project does not match request ancestry: ${input.requestedProjectId} != ${input.request.ancestry.projectId}`,
      );
    }
    return assignedOrchestrationAncestry({
      projectId: input.requestedProjectId,
      workItemId: input.request.ancestry?.workItemId ?? input.request.id,
      goalId: input.request.ancestry?.mode === "assigned" ? input.request.ancestry.goalId : undefined,
    });
  }

  if (input.request.ancestry) return input.request.ancestry;
  return ancestryForRequestIntake({
    requestId: input.request.id,
    requestText: input.request.text,
    projectProfiles: input.projectProfiles,
  });
}
