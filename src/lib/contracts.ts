import type { WorkItemAncestry } from "./ancestry";

export type AgentRole = "writer" | "reviewer" | "evaluator" | "spec" | "researcher" | "content" | "operations";
export type AdvisoryRoleRelationshipKind = "reviews" | "researches" | "evaluates" | "specifies" | "reports-to" | "advises";
export type WriterClass = "writer" | "non-writer";
export type WorktreePolicy = "per-task" | "none";
export type MergePolicy = "samantha-controlled" | "none";
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked" | "archived";
export type HarnessStatus = "pass" | "rework" | "blocked";
export type TaskResultMode = "write" | "report";

export interface SkillBundleRef {
  id: string;
  source: string;
  ref: string;
}

export interface SkillPolicy {
  requiredBundles: SkillBundleRef[];
  blockedSkills: string[];
}

export interface ConnectorAccessCapabilityRecord {
  connector: string;
  capabilityId: string;
}

export interface SecretAccessCapabilityRecord {
  secretName: string;
  capabilityId: string;
}

export interface AdvisoryRoleRelationship {
  from: AgentRole;
  relation: AdvisoryRoleRelationshipKind;
  to: AgentRole;
  description?: string;
}

export interface AdvisoryRoleTopologyAuthority {
  dispatch: false;
  writer: false;
  connector: false;
  secret: false;
  merge: false;
  push: false;
  cleanup: false;
  rollback: false;
  approval: false;
  safetyPolicy: false;
}

export interface AdvisoryRoleTopology {
  schemaVersion: 1;
  relationships: AdvisoryRoleRelationship[];
  authority: AdvisoryRoleTopologyAuthority;
}

export interface AgentProfile {
  id: string;
  role: AgentRole;
  model: string;
  codexProfile?: string;
  writerClass: WriterClass;
  worktreePolicy: WorktreePolicy;
  mergePolicy: MergePolicy;
  skillPolicy: SkillPolicy;
  connectorAccess?: ConnectorAccessCapabilityRecord[];
  secretAccess?: SecretAccessCapabilityRecord[];
}

export interface TaskSpec {
  id: string;
  ancestry?: WorkItemAncestry;
  routineTriggerId?: string;
  routineFingerprint?: string;
  title: string;
  targetAgent: string;
  projectId?: string;
  repoRoot?: string;
  targetFiles: string[];
  forbiddenChanges: string[];
  setupCommands?: string[];
  verifyCommands: string[];
  instructions: string;
  resultMode?: TaskResultMode;
  expectedCommitSubject?: string;
  status: TaskStatus;
  archivedAt?: string;
  archiveReason?: string;
}

export interface SafetyPolicy {
  writerCap: number;
  requiredForbiddenChanges: boolean;
  requiredTargetFilesForWriters: boolean;
  blockedSkillNames: string[];
}

export interface DispatchPlan {
  task: TaskSpec;
  agent: AgentProfile;
  mayDispatch: boolean;
  violations: string[];
}

export interface WorktreeAllocation {
  taskId: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

export interface HarnessResult {
  status: HarnessStatus;
  note: string;
  commit: string;
}
