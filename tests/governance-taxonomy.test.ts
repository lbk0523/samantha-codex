import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DERIVED_VIEW_KINDS,
  GOVERNANCE_ALLOWED_TRANSITIONS,
  GOVERNANCE_EVENT_KINDS,
  GOVERNANCE_RISK_CLASSES,
  GOVERNANCE_RISK_CLASS_ORDER,
  GOVERNANCE_TRANSITION_KINDS,
  GOVERNED_SUBJECT_TYPES,
  SOURCE_OF_TRUTH_RECORD_KINDS,
  parseGovernanceEventKind,
  parseGovernanceRiskClass,
  parseGovernanceTransitionKind,
  parseGovernedSubjectType,
  validateGovernanceTransition,
} from "../src/lib/governance-taxonomy";

interface GovernanceTaxonomyFixture {
  governedSubjectTypes: string[];
  governanceEventKinds: string[];
  governanceTransitionKinds: string[];
  governanceRiskClasses: string[];
  sourceOfTruthRecordKinds: string[];
  derivedViewKinds: string[];
  allowedTransitions: Record<string, string[]>;
}

async function readFixture(): Promise<GovernanceTaxonomyFixture> {
  const path = join(import.meta.dir, "..", "references", "governance", "taxonomy.json");
  return JSON.parse(await readFile(path, "utf8")) as GovernanceTaxonomyFixture;
}

describe("governance taxonomy", () => {
  test("fixture covers every governed taxonomy value", async () => {
    const fixture = await readFixture();

    expect(fixture.governedSubjectTypes).toEqual([...GOVERNED_SUBJECT_TYPES]);
    expect(fixture.governanceEventKinds).toEqual([...GOVERNANCE_EVENT_KINDS]);
    expect(fixture.governanceTransitionKinds).toEqual([...GOVERNANCE_TRANSITION_KINDS]);
    expect(fixture.governanceRiskClasses).toEqual([...GOVERNANCE_RISK_CLASSES]);
    expect(fixture.sourceOfTruthRecordKinds).toEqual([...SOURCE_OF_TRUTH_RECORD_KINDS]);
    expect(fixture.derivedViewKinds).toEqual([...DERIVED_VIEW_KINDS]);
    expect(Object.keys(fixture.allowedTransitions)).toEqual([...GOVERNED_SUBJECT_TYPES]);
    expect(fixture.allowedTransitions).toEqual(
      Object.fromEntries(
        Object.entries(GOVERNANCE_ALLOWED_TRANSITIONS).map(([subjectType, transitions]) => [
          subjectType,
          [...transitions],
        ]),
      ),
    );
  });

  test("every governed subject has at least one allowed transition", () => {
    for (const subjectType of GOVERNED_SUBJECT_TYPES) {
      expect(GOVERNANCE_ALLOWED_TRANSITIONS[subjectType].length).toBeGreaterThan(0);
    }
  });

  test("every transition kind is assigned to at least one governed subject", () => {
    const assignedTransitions = new Set(Object.values(GOVERNANCE_ALLOWED_TRANSITIONS).flat());

    expect([...assignedTransitions].sort()).toEqual([...GOVERNANCE_TRANSITION_KINDS].sort());
  });

  test("unknown taxonomy values throw instead of defaulting to safe", () => {
    expect(() => parseGovernedSubjectType("memory")).toThrow("unknown governed subject type: memory");
    expect(() => parseGovernanceEventKind("event_store_append")).toThrow(
      "unknown governance event kind: event_store_append",
    );
    expect(() => parseGovernanceTransitionKind("automerge")).toThrow(
      "unknown governance transition kind: automerge",
    );
    expect(() => parseGovernanceRiskClass("safe")).toThrow("unknown governance risk class: safe");
  });

  test("unknown subject transition and risk fail closed", () => {
    const result = validateGovernanceTransition({
      subjectType: "memory",
      transitionKind: "automerge",
      riskClass: "safe",
    });

    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([
      "unknown governed subject type: memory",
      "unknown governance transition kind: automerge",
      "unknown governance risk class: safe",
    ]);
  });

  test("known but disallowed transitions fail closed", () => {
    const result = validateGovernanceTransition({
      subjectType: "request",
      transitionKind: "push",
      riskClass: "high",
    });

    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([
      "transition push is not allowed for governed subject request",
    ]);
  });

  test("known allowed transitions pass taxonomy validation", () => {
    const result = validateGovernanceTransition({
      subjectType: "task",
      transitionKind: "dispatch",
      riskClass: "medium",
    });

    expect(result).toEqual({ allowed: true, violations: [] });
  });

  test("risk classes preserve deterministic severity order", () => {
    expect(GOVERNANCE_RISK_CLASSES.map((riskClass) => GOVERNANCE_RISK_CLASS_ORDER[riskClass])).toEqual([
      0,
      1,
      2,
      3,
      4,
    ]);
  });

  test("source records and derived views are distinct", () => {
    const sourceRecords = new Set<string>(SOURCE_OF_TRUTH_RECORD_KINDS);
    const overlap = DERIVED_VIEW_KINDS.filter((viewKind) => sourceRecords.has(viewKind));

    expect(overlap).toEqual([]);
  });
});
