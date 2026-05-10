import type {
  AdvisoryRoleRelationship,
  AdvisoryRoleRelationshipKind,
  AdvisoryRoleTopology,
  AdvisoryRoleTopologyAuthority,
  AgentRole,
} from "./contracts";
import type { DecisionItem } from "./decision-store";
import { approvedCapabilityChangeDecision } from "./profile-governance";

const KNOWN_AGENT_ROLES: AgentRole[] = [
  "writer",
  "reviewer",
  "evaluator",
  "spec",
  "researcher",
  "content",
  "operations",
];

const KNOWN_RELATIONSHIPS: AdvisoryRoleRelationshipKind[] = [
  "reviews",
  "researches",
  "evaluates",
  "specifies",
  "reports-to",
  "advises",
];

const ROLE_LABELS: Record<AgentRole, string> = {
  writer: "Writer",
  reviewer: "Reviewer",
  evaluator: "Evaluator",
  spec: "Spec",
  researcher: "Researcher",
  content: "Content",
  operations: "Operations",
};

const AUTHORITY_KEYS: Array<keyof AdvisoryRoleTopologyAuthority> = [
  "dispatch",
  "writer",
  "connector",
  "secret",
  "merge",
  "push",
  "cleanup",
  "approval",
  "safetyPolicy",
];

export const ADVISORY_ROLE_TOPOLOGY_AUTHORITY: AdvisoryRoleTopologyAuthority = {
  dispatch: false,
  writer: false,
  connector: false,
  secret: false,
  merge: false,
  push: false,
  cleanup: false,
  approval: false,
  safetyPolicy: false,
};

export const DEFAULT_ADVISORY_ROLE_TOPOLOGY: AdvisoryRoleTopology = {
  schemaVersion: 1,
  authority: ADVISORY_ROLE_TOPOLOGY_AUTHORITY,
  relationships: [
    {
      from: "spec",
      relation: "specifies",
      to: "writer",
      description: "Shapes scope, acceptance criteria, and implementation boundaries.",
    },
    {
      from: "reviewer",
      relation: "reviews",
      to: "writer",
      description: "Reviews existing state, risk, and proposed changes.",
    },
    {
      from: "researcher",
      relation: "researches",
      to: "writer",
      description: "Finds local context and decision history before implementation.",
    },
    {
      from: "evaluator",
      relation: "evaluates",
      to: "writer",
      description: "Plans validation and assesses results without editing files.",
    },
    {
      from: "content",
      relation: "advises",
      to: "spec",
      description: "Advises on wording, report shape, and user-facing content.",
    },
    {
      from: "operations",
      relation: "reports-to",
      to: "spec",
      description: "Reports operational prerequisites, runbook risks, and next actions.",
    },
  ],
};

export interface RoleTopologyValidationResult {
  ok: boolean;
  violations: string[];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function roleLabel(role: AgentRole): string {
  return ROLE_LABELS[role];
}

function relationLabel(relation: AdvisoryRoleRelationshipKind): string {
  const labels: Record<AdvisoryRoleRelationshipKind, string> = {
    reviews: "reviews",
    researches: "researches",
    evaluates: "evaluates",
    specifies: "specifies",
    "reports-to": "reports to",
    advises: "advises",
  };
  return labels[relation];
}

function incomingRelationLabel(relation: AdvisoryRoleRelationshipKind): string {
  const labels: Record<AdvisoryRoleRelationshipKind, string> = {
    reviews: "reviewed by",
    researches: "researched by",
    evaluates: "evaluated by",
    specifies: "specified by",
    "reports-to": "receives reports from",
    advises: "advised by",
  };
  return labels[relation];
}

function stableRelationshipKey(relationship: AdvisoryRoleRelationship): string {
  return [
    relationship.from,
    relationship.relation,
    relationship.to,
    oneLine(relationship.description ?? ""),
  ].join(">");
}

function stableTopologySummary(topology: AdvisoryRoleTopology): string[] {
  const relationships = Array.isArray(topology.relationships) ? topology.relationships : [];
  const authority = topology.authority as unknown as Record<string, unknown> | undefined;
  return [
    `schemaVersion:${topology.schemaVersion}`,
    ...AUTHORITY_KEYS.map((key) => `authority.${key}:${String(authority?.[key])}`),
    ...relationships.map(stableRelationshipKey).sort(),
  ];
}

function listChanged(label: string, before: string[], after: string[]): string[] {
  return before.length === after.length && before.every((item, index) => item === after[index])
    ? []
    : [`${label}: ${before.join(",") || "(none)"} -> ${after.join(",") || "(none)"}`];
}

export function advisoryRoleTopologyCapabilityId(): string {
  return "advisory_role_topology";
}

export function validateAdvisoryRoleTopology(topology: AdvisoryRoleTopology): RoleTopologyValidationResult {
  const violations: string[] = [];

  if (topology.schemaVersion !== 1) violations.push(`role topology schemaVersion must be 1`);
  if (!Array.isArray(topology.relationships)) {
    violations.push("role topology relationships must be an array");
  }

  const authority = topology.authority as unknown as Record<string, unknown> | undefined;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    violations.push("role topology authority must explicitly deny all authority");
  } else {
    for (const key of AUTHORITY_KEYS) {
      if (authority[key] !== false) {
        violations.push(`role topology authority.${key} must be false`);
      }
    }
  }

  const seen = new Set<string>();
  const relationships = Array.isArray(topology.relationships) ? topology.relationships : [];
  for (const relationship of relationships) {
    if (!KNOWN_AGENT_ROLES.includes(relationship.from)) {
      violations.push(`role topology relationship uses unknown source role: ${String(relationship.from || "(empty)")}`);
    }
    if (!KNOWN_AGENT_ROLES.includes(relationship.to)) {
      violations.push(`role topology relationship uses unknown target role: ${String(relationship.to || "(empty)")}`);
    }
    if (!KNOWN_RELATIONSHIPS.includes(relationship.relation)) {
      violations.push(`role topology relationship kind is unknown: ${String(relationship.relation || "(empty)")}`);
    }
    const key = `${relationship.from}:${relationship.relation}:${relationship.to}`;
    if (seen.has(key)) violations.push(`role topology relationship is duplicated: ${key}`);
    seen.add(key);
  }

  return { ok: violations.length === 0, violations };
}

export function advisoryRoleTopologyChangeSummary(topology: AdvisoryRoleTopology): string {
  const changes = advisoryRoleTopologyDiff(DEFAULT_ADVISORY_ROLE_TOPOLOGY, topology);
  return changes.length ? changes.join("; ") : "no advisory role topology change";
}

export function advisoryRoleTopologyDiff(
  baseline: AdvisoryRoleTopology,
  topology: AdvisoryRoleTopology,
): string[] {
  return listChanged("advisoryRoleTopology", stableTopologySummary(baseline), stableTopologySummary(topology));
}

export function validateAdvisoryRoleTopologyGovernance(
  topology: AdvisoryRoleTopology,
  baseline: AdvisoryRoleTopology = DEFAULT_ADVISORY_ROLE_TOPOLOGY,
  decisions: DecisionItem[] = [],
): RoleTopologyValidationResult {
  const validation = validateAdvisoryRoleTopology(topology);
  const changes = advisoryRoleTopologyDiff(baseline, topology);
  if (changes.length > 0 && !approvedCapabilityChangeDecision(advisoryRoleTopologyCapabilityId(), decisions)) {
    validation.violations.push(
      `advisory role topology has unapproved governed capability change: ${changes.join("; ")}`,
    );
  }
  return { ok: validation.violations.length === 0, violations: validation.violations };
}

export function advisoryRoleTopologySummaryForRole(
  role: AgentRole,
  topology: AdvisoryRoleTopology = DEFAULT_ADVISORY_ROLE_TOPOLOGY,
): string {
  const outgoing = topology.relationships
    .filter((relationship) => relationship.from === role)
    .map((relationship) => `${relationLabel(relationship.relation)} ${roleLabel(relationship.to)}`);
  const incoming = topology.relationships
    .filter((relationship) => relationship.to === role)
    .map((relationship) => `${incomingRelationLabel(relationship.relation)} ${roleLabel(relationship.from)}`);
  return [...outgoing, ...incoming].join("; ");
}

export function advisoryRoleTopologyPromptLines(
  topology: AdvisoryRoleTopology = DEFAULT_ADVISORY_ROLE_TOPOLOGY,
): string[] {
  return [
    "Advisory role topology:",
    "- Metadata only. This topology grants no dispatch, writer, connector, secret, merge, push, cleanup, approval, or safety-policy authority.",
    ...topology.relationships.map((relationship) =>
      `- ${roleLabel(relationship.from)} ${relationLabel(relationship.relation)} ${roleLabel(relationship.to)}: ${oneLine(relationship.description ?? "advisory relationship")}`,
    ),
  ];
}
