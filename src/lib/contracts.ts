import type { WorkItemAncestry } from "./ancestry";

export type AgentRole = "writer" | "reviewer" | "evaluator" | "spec" | "researcher" | "content" | "operations";
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
