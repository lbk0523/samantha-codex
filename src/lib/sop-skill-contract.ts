import type { SafetyPolicy } from "./contracts";
import { type GovernanceRiskClass, parseGovernanceRiskClass } from "./governance-taxonomy";
import {
  validateMemorySourceCitation,
  type MemorySourceCitation,
} from "./memory-taxonomy";
import { DEFAULT_SAFETY_POLICY } from "./policy";

export const SOP_SKILL_DOCUMENT_KINDS = ["sop_document", "skill_document"] as const;
export type SopSkillDocumentKind = (typeof SOP_SKILL_DOCUMENT_KINDS)[number];

export const SOP_SKILL_DOCUMENT_STATUSES = ["draft", "active", "archived"] as const;
export type SopSkillDocumentStatus = (typeof SOP_SKILL_DOCUMENT_STATUSES)[number];

export const SOP_SKILL_BEHAVIOR_IMPACTS = ["none", "behavior_change"] as const;
export type SopSkillBehaviorImpact = (typeof SOP_SKILL_BEHAVIOR_IMPACTS)[number];

export const SOP_SKILL_SCOPE_TYPES = ["project", "profile"] as const;
export type SopSkillScopeType = (typeof SOP_SKILL_SCOPE_TYPES)[number];

export interface SopSkillDocumentScope {
  type: SopSkillScopeType;
  id: string;
}

export interface SopSkillDocumentFrontmatter {
  schemaVersion: 1;
  kind: SopSkillDocumentKind;
  id: string;
  title: string;
  scope: SopSkillDocumentScope;
  status: SopSkillDocumentStatus;
  riskClass: GovernanceRiskClass;
  owner: string;
  updatedAt: string;
  behaviorImpact: SopSkillBehaviorImpact;
  citations: MemorySourceCitation[];
  requestedSkillNames?: string[];
}

export interface SopSkillMarkdownDocument {
  frontmatter: SopSkillDocumentFrontmatter;
  body: string;
}

export interface SopSkillValidationResult {
  ok: boolean;
  violations: string[];
  document?: SopSkillMarkdownDocument;
}

export interface SopSkillValidationOptions {
  policy?: SafetyPolicy;
}

const REQUIRED_SECTIONS = [
  "Preconditions",
  "Workflow Steps",
  "Quality Checks",
  "Forbidden Actions",
  "Safety Boundaries",
  "Rollback Notes",
  "Citations",
] as const;

const AUTHORITY_SURFACES = [
  "safety",
  "dispatch",
  "worktree",
  "merge",
  "push",
  "cleanup",
  "recovery",
  "approval",
  "project",
  "connector",
  "secret",
  "routine",
  "budget",
] as const;

const UNSAFE_AUTHORITY_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "override-gate",
    pattern: /\b(bypass|ignore|override|supersede|replace|loosen|disable)\b.*\b(safety|policy|gate|approval|dispatch|worktree|merge|push|cleanup|recovery|project|connector|secret|routine|budget)\b/i,
  },
  {
    id: "dispatch-authority",
    pattern: /\b(may|can|must|should|will|authorized to|allowed to)\b.*\b(dispatch|launch|spawn|delegate)\b.*\b(agent|worker|subagent)s?\b/i,
  },
  {
    id: "worktree-authority",
    pattern: /\b(may|can|must|should|will|authorized to|allowed to)\b.*\b(create|allocate|manage|clean)\b.*\bworktrees?\b/i,
  },
  {
    id: "merge-push-authority",
    pattern: /\b(may|can|must|should|will|authorized to|allowed to)\b.*\b(merge|push)\b/i,
  },
  {
    id: "cleanup-recovery-authority",
    pattern: /\b(may|can|must|should|will|authorized to|allowed to)\b.*\b(cleanup|clean up|recover|rollback|restore)\b/i,
  },
  {
    id: "approval-authority",
    pattern: /\b(may|can|must|should|will|authorized to|allowed to)\b.*\b(approve|resolve)\b.*\b(decision|approval)\b/i,
  },
  {
    id: "connector-secret-authority",
    pattern: /\b(may|can|must|should|will|authorized to|allowed to)\b.*\b(read|use|access|grant|enable)\b.*\b(connector|secret|credential)s?\b/i,
  },
  {
    id: "project-routine-budget-authority",
    pattern: /\b(may|can|must|should|will|authorized to|allowed to|grant|enable|change|increase|set)\b.*\b(project profile|project gate|routine|budget|writer ?cap)\b/i,
  },
  {
    id: "without-required-gate",
    pattern: /\b(dispatch|worktree|merge|push|cleanup|recover|rollback|approve|connector|secret|routine|budget)\b.*\bwithout\b.*\b(approval|review|samantha|gate|policy)\b/i,
  },
];

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function stableIdViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (normalized !== value) return [`${label} must be normalized`];
  if (/[\\/]/.test(normalized)) return [`${label} must be a stable id, not a path`];
  return [];
}

function requiredStringViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  if (!oneLine(value)) return [`${label} is required`];
  return [];
}

function timestampViolations(value: unknown, label: string): string[] {
  if (typeof value !== "string") return [`${label} must be a string`];
  const normalized = oneLine(value);
  if (!normalized) return [`${label} is required`];
  if (Number.isNaN(new Date(normalized).getTime())) return [`${label} must be a valid date: ${normalized}`];
  return [];
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item.trim()));
  }
  return value;
}

function parseKeyValue(line: string): { key: string; value: string } | undefined {
  const match = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
  if (!match) return undefined;
  return { key: match[1] ?? "", value: match[2] ?? "" };
}

function parseFrontmatterBlock(raw: string): { value: Record<string, unknown>; violations: string[] } {
  const value: Record<string, unknown> = {};
  const violations: string[] = [];
  let current:
    | { key: string; type: "object"; item?: Record<string, unknown> }
    | { key: string; type: "array"; item?: Record<string, unknown> }
    | undefined;

  for (const [index, rawLine] of raw.split("\n").entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();

    if (indent === 0) {
      const parsed = parseKeyValue(line);
      if (!parsed) {
        violations.push(`frontmatter line ${index + 1} is invalid`);
        current = undefined;
        continue;
      }
      if (!parsed.value) {
        const nextLooksArray = raw
          .split("\n")
          .slice(index + 1)
          .find((candidate) => candidate.trim());
        const type = nextLooksArray?.trim().startsWith("- ") ? "array" : "object";
        value[parsed.key] = type === "array" ? [] : {};
        current = { key: parsed.key, type };
      } else {
        value[parsed.key] = parseScalar(parsed.value);
        current = undefined;
      }
      continue;
    }

    if (!current) {
      violations.push(`frontmatter line ${index + 1} has no parent key`);
      continue;
    }

    if (current.type === "array") {
      const list = value[current.key];
      if (!Array.isArray(list)) {
        violations.push(`frontmatter ${current.key} must be an array`);
        continue;
      }
      if (line.startsWith("- ")) {
        const item = line.slice(2).trim();
        const parsed = parseKeyValue(item);
        if (parsed) {
          const objectItem: Record<string, unknown> = { [parsed.key]: parseScalar(parsed.value) };
          list.push(objectItem);
          current.item = objectItem;
        } else {
          list.push(parseScalar(item));
          current.item = undefined;
        }
        continue;
      }
      const parsed = parseKeyValue(line);
      if (!parsed || !current.item) {
        violations.push(`frontmatter line ${index + 1} is invalid`);
        continue;
      }
      current.item[parsed.key] = parseScalar(parsed.value);
      continue;
    }

    const object = value[current.key];
    const parsed = parseKeyValue(line);
    if (!isRecord(object) || !parsed) {
      violations.push(`frontmatter line ${index + 1} is invalid`);
      continue;
    }
    object[parsed.key] = parseScalar(parsed.value);
  }

  return { value, violations };
}

function splitFrontmatter(markdown: string): {
  frontmatter?: Record<string, unknown>;
  body: string;
  violations: string[];
} {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: markdown, violations: ["SOP/skill markdown must start with frontmatter fence"] };
  }
  const closing = normalized.indexOf("\n---", 4);
  if (closing === -1) {
    return { body: markdown, violations: ["SOP/skill markdown frontmatter closing fence is required"] };
  }
  const block = normalized.slice(4, closing);
  const afterFence = normalized.slice(closing + 4);
  const parsed = parseFrontmatterBlock(block);
  return {
    frontmatter: parsed.value,
    body: afterFence.startsWith("\n") ? afterFence.slice(1) : afterFence,
    violations: parsed.violations,
  };
}

function parseStringArray(value: unknown, label: string): { values: string[]; violations: string[] } {
  if (value === undefined) return { values: [], violations: [] };
  if (!Array.isArray(value)) return { values: [], violations: [`${label} must be an array`] };
  const violations: string[] = [];
  const values: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !oneLine(item)) {
      violations.push(`${label}[${index}] must be a non-empty string`);
    } else {
      values.push(oneLine(item));
    }
  });
  return { values, violations };
}

function parseFrontmatter(input: Record<string, unknown>): {
  frontmatter?: SopSkillDocumentFrontmatter;
  violations: string[];
} {
  const violations: string[] = [];
  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== 1) violations.push("document.schemaVersion must be 1");
  if (!hasValue(SOP_SKILL_DOCUMENT_KINDS, input.kind)) {
    violations.push(`document.kind is invalid: ${String(input.kind ?? "(empty)")}`);
  }
  violations.push(...stableIdViolations(input.id, "document.id"));
  violations.push(...requiredStringViolations(input.title, "document.title"));

  if (!isRecord(input.scope)) {
    violations.push("document.scope is required");
  } else {
    if (!hasValue(SOP_SKILL_SCOPE_TYPES, input.scope.type)) {
      violations.push(`document.scope.type is invalid: ${String(input.scope.type ?? "(empty)")}`);
    }
    violations.push(...stableIdViolations(input.scope.id, "document.scope.id"));
  }

  if (!hasValue(SOP_SKILL_DOCUMENT_STATUSES, input.status)) {
    violations.push(`document.status is invalid: ${String(input.status ?? "(empty)")}`);
  }

  let riskClass: GovernanceRiskClass | undefined;
  try {
    riskClass = parseGovernanceRiskClass(input.riskClass);
  } catch {
    violations.push(`document.riskClass is invalid: ${String(input.riskClass ?? "(empty)")}`);
  }

  violations.push(...requiredStringViolations(input.owner, "document.owner"));
  violations.push(...timestampViolations(input.updatedAt, "document.updatedAt"));

  if (!hasValue(SOP_SKILL_BEHAVIOR_IMPACTS, input.behaviorImpact)) {
    violations.push(`document.behaviorImpact is invalid: ${String(input.behaviorImpact ?? "(empty)")}`);
  }

  const citations = input.citations;
  if (!Array.isArray(citations) || citations.length === 0) {
    violations.push("document.citations must include at least one source citation");
  } else {
    citations.forEach((citation, index) => {
      violations.push(...validateMemorySourceCitation(citation as MemorySourceCitation, `document.citations[${index}]`));
    });
  }

  const requested = parseStringArray(input.requestedSkillNames, "document.requestedSkillNames");
  violations.push(...requested.violations);

  if (violations.length > 0) return { violations };
  return {
    violations: [],
    frontmatter: {
      schemaVersion: 1,
      kind: input.kind as SopSkillDocumentKind,
      id: input.id as string,
      title: oneLine(input.title as string),
      scope: {
        type: (input.scope as SopSkillDocumentScope).type,
        id: (input.scope as SopSkillDocumentScope).id,
      },
      status: input.status as SopSkillDocumentStatus,
      riskClass: riskClass as GovernanceRiskClass,
      owner: oneLine(input.owner as string),
      updatedAt: oneLine(input.updatedAt as string),
      behaviorImpact: input.behaviorImpact as SopSkillBehaviorImpact,
      citations: citations as MemorySourceCitation[],
      requestedSkillNames: requested.values.length > 0 ? requested.values : undefined,
    },
  };
}

function sectionMap(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let current: string | undefined;
  let content: string[] = [];

  function flush(): void {
    if (current) sections.set(current.toLowerCase(), content.join("\n").trim());
  }

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      current = oneLine(match[1] ?? "");
      content = [];
    } else if (current) {
      content.push(line);
    }
  }
  flush();
  return sections;
}

function sectionViolations(body: string): string[] {
  const sections = sectionMap(body);
  const violations: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const content = sections.get(section.toLowerCase());
    if (content === undefined) {
      violations.push(`document section is required: ${section}`);
    } else if (!oneLine(content)) {
      violations.push(`document section must not be empty: ${section}`);
    }
  }
  return violations;
}

function safeNegationLine(line: string): boolean {
  return /\b(cannot|can't|must not|do not|don't|does not|never|forbidden|blocked|not allowed|no authority|no execution authority)\b/i.test(line);
}

function unsafeAuthorityClaimViolations(body: string): string[] {
  const violations: string[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    const normalized = oneLine(line);
    if (!normalized || safeNegationLine(normalized)) continue;
    for (const rule of UNSAFE_AUTHORITY_PATTERNS) {
      if (rule.pattern.test(normalized)) {
        violations.push(`document contains unsafe authority claim (${rule.id}) on line ${index + 1}: ${normalized}`);
      }
    }
  }
  return violations;
}

function blockedSkillViolations(input: {
  frontmatter: SopSkillDocumentFrontmatter;
  policy: SafetyPolicy;
}): string[] {
  const requested = [
    ...(input.frontmatter.kind === "skill_document" ? [input.frontmatter.id] : []),
    ...(input.frontmatter.requestedSkillNames ?? []),
  ];
  return requested
    .filter((skillName) => input.policy.blockedSkillNames.includes(skillName))
    .map((skillName) => `skill document requests blocked skill name: ${skillName}`);
}

export function validateSopSkillMarkdown(
  markdown: string,
  options: SopSkillValidationOptions = {},
): SopSkillValidationResult {
  const policy = options.policy ?? DEFAULT_SAFETY_POLICY;
  const split = splitFrontmatter(markdown);
  const violations = [...split.violations];
  if (!split.frontmatter) return { ok: false, violations };

  const parsed = parseFrontmatter(split.frontmatter);
  violations.push(...parsed.violations);
  violations.push(...sectionViolations(split.body));
  violations.push(...unsafeAuthorityClaimViolations(split.body));
  if (parsed.frontmatter) {
    violations.push(...blockedSkillViolations({ frontmatter: parsed.frontmatter, policy }));
  }

  return {
    ok: violations.length === 0,
    violations,
    document: violations.length === 0 && parsed.frontmatter
      ? { frontmatter: parsed.frontmatter, body: split.body }
      : undefined,
  };
}

export function parseSopSkillMarkdown(
  markdown: string,
  options: SopSkillValidationOptions = {},
): SopSkillMarkdownDocument {
  const result = validateSopSkillMarkdown(markdown, options);
  if (!result.ok || !result.document) throw new Error(result.violations[0] ?? "invalid SOP/skill markdown");
  return result.document;
}

export function sopSkillAuthoritySurfaces(): readonly string[] {
  return AUTHORITY_SURFACES;
}
