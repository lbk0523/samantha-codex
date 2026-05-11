import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskResultMode } from "./contracts";
import { compactEntityId } from "./ids";
import type { RemoteRequestClassification, RemoteRequestIntent } from "./project-profile";

export type AuthorityGrantStatus = "active" | "revoked";
export type AuthorityGrantSurface = "remote" | "local" | "routine";
export type AuthorityGrantApproval =
  | { type: "architecture_baseline"; source: string }
  | { type: "bk_decision"; decisionId: string };

export type AuthorityAction =
  | "remote_intake"
  | "classify_request"
  | "run_readonly_plan"
  | "materialize_report_task"
  | "dispatch_report_task"
  | "record_autopilot_evidence";

export type DeniedAuthorityAction =
  | "write_task_execution"
  | "merge"
  | "push"
  | "cleanup"
  | "recovery_execution"
  | "connector_access"
  | "secret_access"
  | "budget_policy_change"
  | "routine_authority_change"
  | "profile_change"
  | "host_operation";

export interface AuthorityGrantScope {
  surfaces: AuthorityGrantSurface[];
  projectIds?: string[];
  scopeIds?: string[];
  requestIntents?: RemoteRequestIntent[];
  resultModes?: TaskResultMode[];
  safeHandling?: RemoteRequestClassification["safeHandling"][];
}

export interface AuthorityGrantRecord {
  schemaVersion: 1;
  id: string;
  status: AuthorityGrantStatus;
  grantedTo: "samantha";
  createdAt: string;
  approval: AuthorityGrantApproval;
  scope: AuthorityGrantScope;
  allowedActions: AuthorityAction[];
  deniedActions: DeniedAuthorityAction[];
  evidence: string[];
  expiresAt?: string;
  revokedAt?: string;
  revocationReason?: string;
}

export interface AuthorityCheckInput {
  surface: AuthorityGrantSurface;
  projectId?: string;
  scopeId?: string;
  classification: RemoteRequestClassification;
  requiredActions: AuthorityAction[];
  at?: string;
}

export interface AuthorityCheckResult {
  allowed: boolean;
  grant?: AuthorityGrantRecord;
  reason?: string;
}

export const REPORT_ONLY_AUTOPILOT_ACTIONS: AuthorityAction[] = [
  "remote_intake",
  "classify_request",
  "run_readonly_plan",
  "materialize_report_task",
  "dispatch_report_task",
  "record_autopilot_evidence",
];

export const BASELINE_REPORT_ONLY_AUTOPILOT_GRANT: AuthorityGrantRecord = {
  schemaVersion: 1,
  id: "authority-grant-remote-report-only-autopilot-baseline",
  status: "active",
  grantedTo: "samantha",
  createdAt: "2026-05-11T00:00:00.000Z",
  approval: { type: "architecture_baseline", source: "docs/REMOTE_AUTOPILOT.md" },
  scope: {
    surfaces: ["remote"],
    projectIds: ["*"],
    scopeIds: ["*"],
    requestIntents: ["planning_report", "review", "spec", "evaluation"],
    resultModes: ["report"],
    safeHandling: ["report_only"],
  },
  allowedActions: REPORT_ONLY_AUTOPILOT_ACTIONS,
  deniedActions: [
    "write_task_execution",
    "merge",
    "push",
    "cleanup",
    "recovery_execution",
    "connector_access",
    "secret_access",
    "budget_policy_change",
    "routine_authority_change",
    "profile_change",
    "host_operation",
  ],
  evidence: ["docs/REMOTE_AUTOPILOT.md"],
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function listAllows(values: string[] | undefined, value: string | undefined): boolean {
  if (!values || values.length === 0) return true;
  if (values.includes("*")) return true;
  if (!value) return false;
  return values.includes(value);
}

function grantActive(grant: AuthorityGrantRecord, at: string): boolean {
  if (grant.status !== "active") return false;
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= new Date(at).getTime()) return false;
  return true;
}

function grantMatchesScope(grant: AuthorityGrantRecord, input: AuthorityCheckInput): boolean {
  return (
    listAllows(grant.scope.surfaces, input.surface) &&
    listAllows(grant.scope.projectIds, input.projectId) &&
    listAllows(grant.scope.scopeIds, input.scopeId) &&
    listAllows(grant.scope.requestIntents, input.classification.intent) &&
    listAllows(grant.scope.resultModes, input.classification.resultMode) &&
    listAllows(grant.scope.safeHandling, input.classification.safeHandling)
  );
}

export function checkAuthorityGrant(
  grants: AuthorityGrantRecord[],
  input: AuthorityCheckInput,
): AuthorityCheckResult {
  const at = input.at ?? new Date().toISOString();
  if (input.classification.resultMode !== "report" || input.classification.safeHandling !== "report_only") {
    return { allowed: false, reason: "request is not report-only" };
  }

  for (const grant of grants) {
    if (!grantActive(grant, at)) continue;
    if (!grantMatchesScope(grant, input)) continue;
    const missing = input.requiredActions.filter((action) => !grant.allowedActions.includes(action));
    if (missing.length > 0) return { allowed: false, grant, reason: `authority grant missing actions: ${missing.join(", ")}` };
    return { allowed: true, grant };
  }

  return { allowed: false, reason: "no active authority grant allows report-only autopilot" };
}

export function createAuthorityGrantId(input: {
  createdAt: string;
  label: string;
  source: string;
}): string {
  return compactEntityId({
    prefix: "authority-grant",
    createdAt: input.createdAt,
    label: input.label,
    source: input.source,
  });
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = [...new Set(value.map((item) => oneLine(String(item))).filter(Boolean))];
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return values;
}

export function parseAuthorityGrantRecord(value: unknown): AuthorityGrantRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("authority grant must be an object");
  }
  const grant = value as Partial<AuthorityGrantRecord>;
  const scope = grant.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error("authority grant scope must be an object");
  if (grant.schemaVersion !== 1) throw new Error("authority grant schemaVersion must be 1");
  if (grant.status !== "active" && grant.status !== "revoked") throw new Error("authority grant status must be active or revoked");
  if (grant.grantedTo !== "samantha") throw new Error("authority grant grantedTo must be samantha");
  if (!grant.approval || typeof grant.approval !== "object") throw new Error("authority grant approval is required");
  if (Number.isNaN(new Date(String(grant.createdAt)).getTime())) throw new Error("authority grant createdAt must be a valid date");

  return {
    schemaVersion: 1,
    id: oneLine(String(grant.id ?? "")),
    status: grant.status,
    grantedTo: "samantha",
    createdAt: String(grant.createdAt),
    approval: grant.approval,
    scope: {
      surfaces: parseStringArray(scope.surfaces, "authority grant scope.surfaces") as AuthorityGrantSurface[],
      projectIds: scope.projectIds ? parseStringArray(scope.projectIds, "authority grant scope.projectIds") : undefined,
      scopeIds: scope.scopeIds ? parseStringArray(scope.scopeIds, "authority grant scope.scopeIds") : undefined,
      requestIntents: scope.requestIntents
        ? parseStringArray(scope.requestIntents, "authority grant scope.requestIntents") as RemoteRequestIntent[]
        : undefined,
      resultModes: scope.resultModes
        ? parseStringArray(scope.resultModes, "authority grant scope.resultModes") as TaskResultMode[]
        : undefined,
      safeHandling: scope.safeHandling
        ? parseStringArray(scope.safeHandling, "authority grant scope.safeHandling") as RemoteRequestClassification["safeHandling"][]
        : undefined,
    },
    allowedActions: parseStringArray(grant.allowedActions, "authority grant allowedActions") as AuthorityAction[],
    deniedActions: parseStringArray(grant.deniedActions, "authority grant deniedActions") as DeniedAuthorityAction[],
    evidence: parseStringArray(grant.evidence, "authority grant evidence"),
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    revocationReason: grant.revocationReason,
  };
}

export class AuthorityGrantStore {
  constructor(private readonly path: string) {}

  async list(): Promise<AuthorityGrantRecord[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => parseAuthorityGrantRecord(JSON.parse(line)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async listWithBaseline(): Promise<AuthorityGrantRecord[]> {
    return [BASELINE_REPORT_ONLY_AUTOPILOT_GRANT, ...(await this.list())];
  }

  async append(grant: AuthorityGrantRecord): Promise<void> {
    parseAuthorityGrantRecord(grant);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(grant)}\n`, "utf8");
  }
}
