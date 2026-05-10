import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  validateAncestryRecords,
  validateSameProjectMaterializedExecutionPlan,
  type AncestryRecordKind,
  type AncestryValidationRecord,
  type WorkItemAncestry,
} from "./ancestry";
import {
  parseBudgetPolicyRecord,
  parseCostBudgetAuditRecord,
  validateBudgetPolicyGovernance,
  type BudgetPolicyRecord,
  type CostBudgetAuditRecord,
} from "./cost-budget-audit";
import type { DecisionItem } from "./decision-store";
import { parseGovernanceEventRecord, type GovernanceEventRecord } from "./governance-event-store";
import type { RunSummary } from "./ledger";
import type { GovernedMemoryRecord } from "./memory-store";
import type { OrchestrationRequestRecord, OrchestratorPlanRecord } from "./orchestrator-store";
import type { RemoteActionRecord } from "./remote-action-store";
import type { RunLifecycleRecord } from "./run-lifecycle-store";
import type { TaskSpec } from "./contracts";

export type BackupManifestEntryKind =
  | "state_record"
  | "governance_evidence"
  | "run_index"
  | "run_log"
  | "host_ownership"
  | "operator_inbox"
  | "operator_outbox"
  | "dashboard_artifact"
  | "project_profile"
  | "runtime_artifact";

export interface BackupManifestEntry {
  path: string;
  kind: BackupManifestEntryKind;
  requiredForRestore: boolean;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  schemaVersion: 1;
  generatedAt: string;
  entries: BackupManifestEntry[];
  notes: {
    portableRepoState: string[];
    hostOwnedRuntime: string[];
    restoreAuthority: {
      dispatch: false;
      approve: false;
      merge: false;
      push: false;
      cleanup: false;
      recover: false;
      rewriteHistory: false;
    };
  };
}

export interface BackupManifestInput {
  root: string;
  generatedAt: string;
  stateDir?: string;
  runsDir?: string;
  inboxDir?: string;
  outboxDir?: string;
  archiveInboxDir?: string;
  dashboardDir?: string;
  projectProfilesDir?: string;
}

export interface RestoreValidationIssue {
  severity: "blocker" | "warning";
  code:
    | "missing_file"
    | "hash_mismatch"
    | "malformed_manifest"
    | "malformed_record"
    | "duplicate_id"
    | "broken_ancestry"
    | "governance_gap"
    | "run_lifecycle_gap"
    | "stale_host_ownership"
    | "active_active_host";
  path?: string;
  message: string;
}

export interface RestoreValidationResult {
  ok: boolean;
  checkedAt: string;
  issueCount: number;
  issues: RestoreValidationIssue[];
  authority: BackupManifest["notes"]["restoreAuthority"];
}

export interface HostOwnershipRecord {
  schemaVersion: 1;
  role: "active_automation_host" | "client_machine";
  hostId: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface HostMigrationValidationResult {
  ok: boolean;
  checkedAt: string;
  issues: RestoreValidationIssue[];
}

const restoreAuthority: BackupManifest["notes"]["restoreAuthority"] = {
  dispatch: false,
  approve: false,
  merge: false,
  push: false,
  cleanup: false,
  recover: false,
  rewriteHistory: false,
};

const stateFiles: Array<{ file: string; kind: BackupManifestEntryKind; required: boolean }> = [
  { file: "host-ownership.json", kind: "host_ownership", required: true },
  { file: "decisions.jsonl", kind: "state_record", required: false },
  { file: "orchestration-requests.jsonl", kind: "state_record", required: false },
  { file: "orchestrator-plans.jsonl", kind: "state_record", required: false },
  { file: "tasks.jsonl", kind: "state_record", required: false },
  { file: "remote-actions.jsonl", kind: "state_record", required: false },
  { file: "runs.jsonl", kind: "run_index", required: false },
  { file: "run-lifecycle.jsonl", kind: "state_record", required: false },
  { file: "ceo-reports.jsonl", kind: "state_record", required: false },
  { file: "memory.jsonl", kind: "state_record", required: false },
  { file: "budget-audit.jsonl", kind: "state_record", required: false },
  { file: "budget-policies.jsonl", kind: "state_record", required: false },
  { file: "governance-events.jsonl", kind: "governance_evidence", required: false },
  { file: "routine-triggers.jsonl", kind: "state_record", required: false },
  { file: "routine-trigger-observations.jsonl", kind: "state_record", required: false },
  { file: "project-briefs.jsonl", kind: "state_record", required: false },
  { file: "task-drafts.jsonl", kind: "state_record", required: false },
  { file: "proposals.jsonl", kind: "state_record", required: false },
  { file: "telegram-offset.json", kind: "runtime_artifact", required: false },
  { file: "telegram-replies.json", kind: "runtime_artifact", required: false },
];

function isoTimestamp(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeRelPath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join("/");
}

function relativeToRoot(root: string, path: string): string {
  const rel = normalizeRelPath(relative(root, path));
  if (!rel || rel.startsWith("..")) throw new Error(`path must be inside backup root: ${path}`);
  return rel;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function fileEntry(root: string, path: string, kind: BackupManifestEntryKind, requiredForRestore: boolean): Promise<BackupManifestEntry> {
  const [info, raw] = await Promise.all([stat(path), readFile(path)]);
  return {
    path: relativeToRoot(root, path),
    kind,
    requiredForRestore,
    bytes: info.size,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

async function collectFiles(dir: string, predicate: (file: string) => boolean): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(path, predicate);
    if (!entry.isFile()) return [];
    return predicate(entry.name) ? [path] : [];
  }));
  return files.flat().sort((left, right) => normalizeRelPath(left).localeCompare(normalizeRelPath(right)));
}

async function addIfPresent(
  entries: BackupManifestEntry[],
  root: string,
  path: string,
  kind: BackupManifestEntryKind,
  requiredForRestore: boolean,
): Promise<void> {
  if (!(await exists(path))) return;
  entries.push(await fileEntry(root, path, kind, requiredForRestore));
}

export async function buildBackupManifest(input: BackupManifestInput): Promise<BackupManifest> {
  const root = resolve(input.root);
  const stateDir = resolve(input.stateDir ?? join(root, "state"));
  const runsDir = resolve(input.runsDir ?? join(root, "runs"));
  const inboxDir = resolve(input.inboxDir ?? join(root, "inbox"));
  const outboxDir = resolve(input.outboxDir ?? join(root, "outbox"));
  const archiveInboxDir = resolve(input.archiveInboxDir ?? join(root, "archive", "inbox"));
  const dashboardDir = resolve(input.dashboardDir ?? join(root, "dashboard"));
  const projectProfilesDir = resolve(input.projectProfilesDir ?? join(root, "references", "project-profiles"));
  const entries: BackupManifestEntry[] = [];

  for (const item of stateFiles) {
    await addIfPresent(entries, root, join(stateDir, item.file), item.kind, item.required);
  }
  for (const path of await collectFiles(runsDir, (file) => file.endsWith(".json") || file.endsWith(".jsonl"))) {
    await addIfPresent(entries, root, path, "run_log", false);
  }
  for (const path of await collectFiles(inboxDir, (file) => file.endsWith(".json"))) {
    await addIfPresent(entries, root, path, "operator_inbox", false);
  }
  for (const path of await collectFiles(outboxDir, (file) => file.endsWith(".md"))) {
    await addIfPresent(entries, root, path, "operator_outbox", false);
  }
  for (const path of await collectFiles(archiveInboxDir, (file) => file.endsWith(".json"))) {
    await addIfPresent(entries, root, path, "operator_inbox", false);
  }
  for (const path of await collectFiles(dashboardDir, (file) => file.endsWith(".html") || file.endsWith(".json"))) {
    await addIfPresent(entries, root, path, "dashboard_artifact", false);
  }
  for (const path of await collectFiles(projectProfilesDir, (file) => file.endsWith(".json"))) {
    await addIfPresent(entries, root, path, "project_profile", true);
  }

  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    generatedAt: isoTimestamp(input.generatedAt, "generatedAt"),
    entries,
    notes: {
      portableRepoState: ["references/project-profiles/*.json", "tracked repo code and docs"],
      hostOwnedRuntime: ["state/", "runs/", "inbox/", "outbox/", "archive/inbox/", "dashboard/"],
      restoreAuthority,
    },
  };
}

function issue(input: RestoreValidationIssue): RestoreValidationIssue {
  return input;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() === value && value.length > 0 && !/[\\/]/.test(value) ? value : undefined;
}

function timestampOk(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseHostOwnership(value: unknown): HostOwnershipRecord {
  if (!isObject(value)) throw new Error("host ownership must be an object");
  if (value.schemaVersion !== 1) throw new Error("host ownership schemaVersion must be 1");
  if (value.role !== "active_automation_host" && value.role !== "client_machine") {
    throw new Error(`host ownership role is invalid: ${String(value.role)}`);
  }
  if (!stableId(value.hostId)) throw new Error("host ownership hostId must be a stable id");
  if (!timestampOk(value.updatedAt)) throw new Error("host ownership updatedAt must be a valid timestamp");
  if (value.expiresAt !== undefined && !timestampOk(value.expiresAt)) {
    throw new Error("host ownership expiresAt must be a valid timestamp");
  }
  return {
    schemaVersion: 1,
    role: value.role,
    hostId: value.hostId as string,
    updatedAt: value.updatedAt as string,
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
  };
}

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readJsonLines(path: string): Promise<Array<{ line: number; value: unknown }>> {
  const raw = await readFile(path, "utf8");
  return raw.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [{ line: index + 1, value: JSON.parse(line) as unknown }];
    } catch {
      throw new Error(`line ${index + 1}: invalid JSON`);
    }
  });
}

function requireJsonlRecord(value: unknown, line: number, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} line ${line}: record must be an object`);
  if (value.schemaVersion !== 1) throw new Error(`${label} line ${line}: schemaVersion must be 1`);
  return value;
}

function parseGenericJsonl(path: string, label: string, idField: "id" | "runId"): Promise<Record<string, unknown>[]> {
  return readJsonLines(path).then((lines) =>
    lines.map(({ line, value }) => {
      const record = requireJsonlRecord(value, line, label);
      if (!stableId(record[idField])) throw new Error(`${label} line ${line}: ${idField} must be a stable id`);
      return record;
    }),
  );
}

function duplicateIdIssues(
  records: Array<{ path: string; idField: "id" | "runId"; records: Record<string, unknown>[] }>,
): RestoreValidationIssue[] {
  const issues: RestoreValidationIssue[] = [];
  for (const group of records) {
    const seen = new Set<string>();
    for (const record of group.records) {
      const id = String(record[group.idField]);
      if (seen.has(id)) {
        issues.push(issue({
          severity: "blocker",
          code: "duplicate_id",
          path: group.path,
          message: `duplicate ${group.idField}: ${id}`,
        }));
      }
      seen.add(id);
    }
  }
  return issues;
}

function ancestryRecord(kind: AncestryRecordKind, id: string, value: Record<string, unknown>): AncestryValidationRecord {
  return {
    kind,
    id,
    ancestry: value.ancestry as WorkItemAncestry | undefined,
  };
}

function status(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function indexById<T extends { id?: string; runId?: string }>(records: T[], idField: "id" | "runId"): Map<string, T> {
  return new Map(records.flatMap((record) => {
    const id = idField === "id" ? record.id : record.runId;
    return typeof id === "string" ? [[id, record]] : [];
  }));
}

function lifecycleIssues(input: {
  runs: RunSummary[];
  tasks: TaskSpec[];
  actions: RemoteActionRecord[];
  lifecycles: RunLifecycleRecord[];
}): RestoreValidationIssue[] {
  const issues: RestoreValidationIssue[] = [];
  const runIds = new Set(input.runs.map((run) => run.runId));
  const taskIds = new Set(input.tasks.map((task) => task.id));
  for (const lifecycle of input.lifecycles) {
    if (!runIds.has(lifecycle.runId)) {
      issues.push(issue({
        severity: "blocker",
        code: "run_lifecycle_gap",
        path: "state/run-lifecycle.jsonl",
        message: `lifecycle references missing run: ${lifecycle.runId}`,
      }));
    }
    if (!taskIds.has(lifecycle.taskId)) {
      issues.push(issue({
        severity: "blocker",
        code: "run_lifecycle_gap",
        path: "state/run-lifecycle.jsonl",
        message: `lifecycle ${lifecycle.runId} references missing task: ${lifecycle.taskId}`,
      }));
    }
    if (lifecycle.cleanedAt && !lifecycle.pushedAt) {
      issues.push(issue({
        severity: "blocker",
        code: "run_lifecycle_gap",
        path: "state/run-lifecycle.jsonl",
        message: `lifecycle ${lifecycle.runId} is cleaned before push is recorded`,
      }));
    }
    if (lifecycle.pushedAt && !lifecycle.mergedAt) {
      issues.push(issue({
        severity: "blocker",
        code: "run_lifecycle_gap",
        path: "state/run-lifecycle.jsonl",
        message: `lifecycle ${lifecycle.runId} is pushed before merge is recorded`,
      }));
    }
  }
  for (const action of input.actions) {
    if (action.result?.runId && !runIds.has(action.result.runId)) {
      issues.push(issue({
        severity: "blocker",
        code: "run_lifecycle_gap",
        path: "state/remote-actions.jsonl",
        message: `action ${action.id} references missing run: ${action.result.runId}`,
      }));
    }
  }
  return issues;
}

function governanceGapIssues(input: {
  decisions: DecisionItem[];
  events: GovernanceEventRecord[];
  memory: GovernedMemoryRecord[];
  budgetPolicies: BudgetPolicyRecord[];
}): RestoreValidationIssue[] {
  const issues: RestoreValidationIssue[] = [];
  const eventIds = new Set(input.events.map((event) => event.id));
  const decisionIds = new Set(input.decisions.map((decision) => decision.id));

  for (const record of input.memory) {
    for (const eventId of record.governanceEventIds ?? []) {
      if (!eventIds.has(eventId)) {
        issues.push(issue({
          severity: "blocker",
          code: "governance_gap",
          path: "state/memory.jsonl",
          message: `memory ${record.id} references missing governance event: ${eventId}`,
        }));
      }
    }
    if (record.approvalDecisionId && !decisionIds.has(record.approvalDecisionId)) {
      issues.push(issue({
        severity: "blocker",
        code: "governance_gap",
        path: "state/memory.jsonl",
        message: `memory ${record.id} references missing decision: ${record.approvalDecisionId}`,
      }));
    }
  }

  for (const policy of input.budgetPolicies) {
    for (const violation of validateBudgetPolicyGovernance({
      policy,
      decisions: input.decisions,
      governanceEvents: input.events,
    })) {
      issues.push(issue({
        severity: "blocker",
        code: "governance_gap",
        path: "state/budget-policies.jsonl",
        message: violation,
      }));
    }
  }

  return issues;
}

async function parseKnownState(root: string): Promise<{
  issues: RestoreValidationIssue[];
  decisions: DecisionItem[];
  requests: OrchestrationRequestRecord[];
  plans: OrchestratorPlanRecord[];
  tasks: TaskSpec[];
  actions: RemoteActionRecord[];
  runs: RunSummary[];
  lifecycles: RunLifecycleRecord[];
  reports: Record<string, unknown>[];
  memory: GovernedMemoryRecord[];
  budgetAudit: CostBudgetAuditRecord[];
  budgetPolicies: BudgetPolicyRecord[];
  events: GovernanceEventRecord[];
}> {
  const state = join(root, "state");
  const issues: RestoreValidationIssue[] = [];
  const parsedGroups: Array<{ path: string; idField: "id" | "runId"; records: Record<string, unknown>[] }> = [];

  async function parseJsonl<T>(file: string, idField: "id" | "runId", label: string): Promise<T[]> {
    const path = join(state, file);
    if (!(await exists(path))) return [];
    try {
      const records = await parseGenericJsonl(path, label, idField);
      parsedGroups.push({ path: `state/${file}`, idField, records });
      return records as unknown as T[];
    } catch (err) {
      issues.push(issue({
        severity: "blocker",
        code: "malformed_record",
        path: `state/${file}`,
        message: (err as Error).message,
      }));
      return [];
    }
  }

  const decisions = await parseJsonl<DecisionItem>("decisions.jsonl", "id", "decision");
  const requests = await parseJsonl<OrchestrationRequestRecord>("orchestration-requests.jsonl", "id", "orchestration request");
  const plans = await parseJsonl<OrchestratorPlanRecord>("orchestrator-plans.jsonl", "id", "orchestrator plan");
  const tasks = await parseJsonl<TaskSpec>("tasks.jsonl", "id", "task");
  const actions = await parseJsonl<RemoteActionRecord>("remote-actions.jsonl", "id", "remote action");
  const runs = await parseJsonl<RunSummary>("runs.jsonl", "runId", "run");
  const lifecycles = await parseJsonl<RunLifecycleRecord>("run-lifecycle.jsonl", "runId", "run lifecycle");
  const reports = await parseJsonl<Record<string, unknown>>("ceo-reports.jsonl", "id", "ceo report");
  const memory = await parseJsonl<GovernedMemoryRecord>("memory.jsonl", "id", "memory");
  const budgetAuditRaw = await parseJsonl<Record<string, unknown>>("budget-audit.jsonl", "id", "budget audit");
  const budgetPoliciesRaw = await parseJsonl<Record<string, unknown>>("budget-policies.jsonl", "id", "budget policy");
  const governanceRaw = await parseJsonl<Record<string, unknown>>("governance-events.jsonl", "id", "governance event");

  const budgetAudit = budgetAuditRaw.flatMap((record) => {
    try {
      return [parseCostBudgetAuditRecord(record)];
    } catch (err) {
      issues.push(issue({ severity: "blocker", code: "malformed_record", path: "state/budget-audit.jsonl", message: (err as Error).message }));
      return [];
    }
  });
  const budgetPolicies = budgetPoliciesRaw.flatMap((record) => {
    try {
      return [parseBudgetPolicyRecord(record)];
    } catch (err) {
      issues.push(issue({ severity: "blocker", code: "malformed_record", path: "state/budget-policies.jsonl", message: (err as Error).message }));
      return [];
    }
  });
  const events = governanceRaw.flatMap((record) => {
    try {
      return [parseGovernanceEventRecord(record)];
    } catch (err) {
      issues.push(issue({ severity: "blocker", code: "malformed_record", path: "state/governance-events.jsonl", message: (err as Error).message }));
      return [];
    }
  });

  issues.push(...duplicateIdIssues(parsedGroups));
  return {
    issues,
    decisions,
    requests,
    plans,
    tasks,
    actions,
    runs,
    lifecycles,
    reports,
    memory,
    budgetAudit,
    budgetPolicies,
    events,
  };
}

function ancestryIssues(input: Awaited<ReturnType<typeof parseKnownState>>): RestoreValidationIssue[] {
  const records: AncestryValidationRecord[] = [
    ...input.requests.map((record) => ancestryRecord("request", record.id, record as unknown as Record<string, unknown>)),
    ...input.plans.map((record) => ancestryRecord("plan", record.id, record as unknown as Record<string, unknown>)),
    ...input.decisions.map((record) => ancestryRecord("decision", record.id, record as unknown as Record<string, unknown>)),
    ...input.tasks.map((record) => ancestryRecord("task", record.id, record as unknown as Record<string, unknown>)),
    ...input.actions.map((record) => ancestryRecord("action", record.id, record as unknown as Record<string, unknown>)),
    ...input.runs.map((record) => ancestryRecord("run", record.runId, record as unknown as Record<string, unknown>)),
    ...input.lifecycles.map((record) => ancestryRecord("lifecycle", record.runId, record as unknown as Record<string, unknown>)),
    ...input.reports.map((record) => ancestryRecord("report", String(record.id), record)),
    ...input.events.map((record) => ancestryRecord("governance_event", record.id, record as unknown as Record<string, unknown>)),
    ...input.budgetAudit.map((record) => ancestryRecord("budget_observation", record.id, record as unknown as Record<string, unknown>)),
  ];
  const issues = validateAncestryRecords({ records }).map((message) =>
    issue({ severity: "blocker", code: "broken_ancestry", message }),
  );

  const tasksById = indexById(input.tasks, "id");
  const actionsById = indexById(input.actions, "id");
  for (const plan of input.plans) {
    if (status(plan.status) !== "materialized") continue;
    const related = [
      ...(plan.taskIds ?? []).flatMap((id) => {
        const task = tasksById.get(id);
        return task ? [ancestryRecord("task", task.id, task as unknown as Record<string, unknown>)] : [];
      }),
      ...(plan.actionIds ?? []).flatMap((id) => {
        const action = actionsById.get(id);
        return action ? [ancestryRecord("action", action.id, action as unknown as Record<string, unknown>)] : [];
      }),
    ];
    const missingTaskIds = (plan.taskIds ?? []).filter((id) => !tasksById.has(id));
    const missingActionIds = (plan.actionIds ?? []).filter((id) => !actionsById.has(id));
    for (const id of missingTaskIds) {
      issues.push(issue({ severity: "blocker", code: "broken_ancestry", path: "state/orchestrator-plans.jsonl", message: `materialized plan ${plan.id} references missing task: ${id}` }));
    }
    for (const id of missingActionIds) {
      issues.push(issue({ severity: "blocker", code: "broken_ancestry", path: "state/orchestrator-plans.jsonl", message: `materialized plan ${plan.id} references missing action: ${id}` }));
    }
    issues.push(...validateSameProjectMaterializedExecutionPlan({
      plan: ancestryRecord("plan", plan.id, plan as unknown as Record<string, unknown>),
      records: related,
    }).map((message) => issue({ severity: "blocker", code: "broken_ancestry", path: "state/orchestrator-plans.jsonl", message })));
  }
  return issues;
}

async function validateManifestEntryHashes(root: string, manifest: BackupManifest): Promise<RestoreValidationIssue[]> {
  const issues: RestoreValidationIssue[] = [];
  for (const entry of manifest.entries) {
    const path = join(root, entry.path);
    if (!(await exists(path))) {
      issues.push(issue({
        severity: "blocker",
        code: "missing_file",
        path: entry.path,
        message: `manifest entry is missing: ${entry.path}`,
      }));
      continue;
    }
    const actual = await fileEntry(root, path, entry.kind, entry.requiredForRestore);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      issues.push(issue({
        severity: "blocker",
        code: "hash_mismatch",
        path: entry.path,
        message: `manifest hash mismatch for ${entry.path}`,
      }));
    }
  }
  return issues;
}

async function validateHostOwnershipFile(input: {
  root: string;
  currentHostId?: string;
  now: Date;
}): Promise<RestoreValidationIssue[]> {
  const path = join(input.root, "state", "host-ownership.json");
  if (!(await exists(path))) {
    return [issue({ severity: "blocker", code: "stale_host_ownership", path: "state/host-ownership.json", message: "host ownership record is missing" })];
  }
  try {
    const record = parseHostOwnership(await loadJson(path));
    if (record.expiresAt && Date.parse(record.expiresAt) <= input.now.getTime()) {
      return [issue({ severity: "blocker", code: "stale_host_ownership", path: "state/host-ownership.json", message: `host ownership expired at ${record.expiresAt}` })];
    }
    if (input.currentHostId && record.role === "active_automation_host" && record.hostId !== input.currentHostId) {
      return [issue({
        severity: "blocker",
        code: "stale_host_ownership",
        path: "state/host-ownership.json",
        message: `restored active host ownership belongs to ${record.hostId}, not ${input.currentHostId}`,
      })];
    }
  } catch (err) {
    return [issue({ severity: "blocker", code: "stale_host_ownership", path: "state/host-ownership.json", message: (err as Error).message })];
  }
  return [];
}

export async function validateRestore(input: {
  root: string;
  manifestPath?: string;
  currentHostId?: string;
  checkedAt?: string;
}): Promise<RestoreValidationResult> {
  const root = resolve(input.root);
  const checkedAt = isoTimestamp(input.checkedAt ?? new Date().toISOString(), "checkedAt");
  const issues: RestoreValidationIssue[] = [];
  if (input.manifestPath) {
    try {
      const raw = await loadJson(resolve(input.manifestPath));
      if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
        throw new Error("backup manifest schemaVersion must be 1 and entries must be an array");
      }
      issues.push(...await validateManifestEntryHashes(root, raw as unknown as BackupManifest));
    } catch (err) {
      issues.push(issue({ severity: "blocker", code: "malformed_manifest", path: input.manifestPath, message: (err as Error).message }));
    }
  }

  const state = await parseKnownState(root);
  issues.push(...state.issues);
  issues.push(...ancestryIssues(state));
  issues.push(...governanceGapIssues({
    decisions: state.decisions,
    events: state.events,
    memory: state.memory,
    budgetPolicies: state.budgetPolicies,
  }));
  issues.push(...lifecycleIssues({
    runs: state.runs,
    tasks: state.tasks,
    actions: state.actions,
    lifecycles: state.lifecycles,
  }));
  issues.push(...await validateHostOwnershipFile({
    root,
    currentHostId: input.currentHostId,
    now: new Date(checkedAt),
  }));

  return {
    ok: !issues.some((item) => item.severity === "blocker"),
    checkedAt,
    issueCount: issues.length,
    issues,
    authority: restoreAuthority,
  };
}

async function loadHostOwnership(path: string): Promise<HostOwnershipRecord | undefined> {
  if (!(await exists(path))) return undefined;
  return parseHostOwnership(await loadJson(path));
}

function hostRecordActive(record: HostOwnershipRecord | undefined, now: Date): boolean {
  if (!record) return false;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) return false;
  return record.role === "active_automation_host";
}

export async function validateHostMigration(input: {
  oldHostOwnershipPath: string;
  newHostOwnershipPath: string;
  targetHostId: string;
  checkedAt?: string;
}): Promise<HostMigrationValidationResult> {
  const checkedAt = isoTimestamp(input.checkedAt ?? new Date().toISOString(), "checkedAt");
  const now = new Date(checkedAt);
  const issues: RestoreValidationIssue[] = [];
  let oldRecord: HostOwnershipRecord | undefined;
  let newRecord: HostOwnershipRecord | undefined;
  try {
    oldRecord = await loadHostOwnership(input.oldHostOwnershipPath);
    newRecord = await loadHostOwnership(input.newHostOwnershipPath);
  } catch (err) {
    issues.push(issue({ severity: "blocker", code: "stale_host_ownership", message: (err as Error).message }));
  }

  const oldActive = hostRecordActive(oldRecord, now);
  const newActive = hostRecordActive(newRecord, now);
  if (oldActive && newActive) {
    issues.push(issue({
      severity: "blocker",
      code: "active_active_host",
      message: `old host ${oldRecord?.hostId} and new host ${newRecord?.hostId} are both active`,
    }));
  }
  if (!newRecord) {
    issues.push(issue({ severity: "blocker", code: "stale_host_ownership", path: basename(input.newHostOwnershipPath), message: "new host ownership record is missing" }));
  } else if (!newActive || newRecord.hostId !== input.targetHostId) {
    issues.push(issue({
      severity: "blocker",
      code: "stale_host_ownership",
      path: basename(input.newHostOwnershipPath),
      message: `new host must be active for ${input.targetHostId}`,
    }));
  }
  if (oldActive) {
    issues.push(issue({
      severity: "blocker",
      code: "active_active_host",
      path: basename(input.oldHostOwnershipPath),
      message: `old host is still active: ${oldRecord?.hostId}`,
    }));
  }

  return {
    ok: !issues.some((item) => item.severity === "blocker"),
    checkedAt,
    issues,
  };
}
