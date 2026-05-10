import { resolve } from "node:path";
import type { SafetyPolicy } from "./contracts";
import { gitHead, gitRaw } from "./git";
import { matchesAnyGlob } from "./glob";
import type { ParallelismEvidenceRecord, ParallelismWriterConflictSafety } from "./parallelism-evidence-store";
import { DEFAULT_SAFETY_POLICY } from "./policy";
import { validateTaskTargetFiles } from "./task-draft-store";

export interface WriterConcurrencyCandidate {
  taskId: string;
  repoRoot: string;
  targetFiles: string[];
  forbiddenChanges: string[];
  baseCommit?: string;
  dependencies?: string[];
  mergedDependencyTaskIds?: string[];
  changedFiles?: string[];
}

export interface WriterConcurrencySafetyInput {
  evaluatedAt: string;
  candidates: WriterConcurrencyCandidate[];
  evidence?: ParallelismEvidenceRecord[];
  policy?: SafetyPolicy;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(oneLine).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasGlob(value: string): boolean {
  return /[*?]/.test(value);
}

function targetsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (normalizedLeft === normalizedRight) return true;
  if (!hasGlob(normalizedLeft) && matchesAnyGlob(normalizedLeft, [normalizedRight])) return true;
  if (!hasGlob(normalizedRight) && matchesAnyGlob(normalizedRight, [normalizedLeft])) return true;
  return false;
}

function taskWriteSet(candidate: WriterConcurrencyCandidate): string[] {
  return unique(candidate.changedFiles?.length ? candidate.changedFiles : candidate.targetFiles).map(normalizePath);
}

function hasPassingEvidence(evidence: ParallelismEvidenceRecord[] | undefined, policy: SafetyPolicy): boolean {
  return Boolean(evidence?.some((record) =>
    record.outcome === "pass" &&
    record.verification.pass &&
    record.writerCount <= policy.writerCap &&
    (record.mergeStatus === "not_applicable" || record.mergeStatus === "completed") &&
    (record.cleanupStatus === "not_applicable" || record.cleanupStatus === "completed")
  ));
}

async function targetRepoViolations(candidate: WriterConcurrencyCandidate): Promise<string[]> {
  const prefix = `task ${candidate.taskId}`;
  const violations: string[] = [];
  if (!candidate.baseCommit) {
    violations.push(`${prefix}: missing base commit evidence`);
  }

  let head = "";
  try {
    head = await gitHead(candidate.repoRoot);
  } catch (err) {
    violations.push(`${prefix}: cannot read target repo HEAD: ${(err as Error).message}`);
  }
  if (candidate.baseCommit && head && head !== candidate.baseCommit) {
    violations.push(`${prefix}: target repo HEAD no longer matches candidate base commit`);
  }

  try {
    const status = await gitRaw(["status", "--porcelain=v1", "--untracked-files=all"], candidate.repoRoot);
    if (status.trim().length > 0) violations.push(`${prefix}: target repo has uncommitted changes`);
  } catch (err) {
    violations.push(`${prefix}: cannot read target repo status: ${(err as Error).message}`);
  }

  return violations;
}

export async function evaluateWriterConcurrencySafety(
  input: WriterConcurrencySafetyInput,
): Promise<ParallelismWriterConflictSafety> {
  const policy = input.policy ?? DEFAULT_SAFETY_POLICY;
  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    taskId: oneLine(candidate.taskId),
    repoRoot: resolve(candidate.repoRoot),
    targetFiles: unique(candidate.targetFiles).map(normalizePath),
    forbiddenChanges: unique(candidate.forbiddenChanges).map(normalizePath),
    dependencies: unique(candidate.dependencies ?? []),
    mergedDependencyTaskIds: unique(candidate.mergedDependencyTaskIds ?? []),
    changedFiles: unique(candidate.changedFiles ?? []).map(normalizePath),
  }));
  const violations: string[] = [];

  if (candidates.length < 2) {
    violations.push("writer concurrency check requires at least two writer candidates");
  }
  if (!hasPassingEvidence(input.evidence, policy)) {
    violations.push("writer concurrency check is missing passing parallelism evidence; writerCap stays 1");
  }

  for (const candidate of candidates) {
    for (const violation of validateTaskTargetFiles(candidate.targetFiles, candidate.forbiddenChanges)) {
      violations.push(`task ${candidate.taskId}: ${violation}`);
    }
    for (const file of candidate.changedFiles ?? []) {
      const forbidden = candidate.forbiddenChanges.find((glob) => matchesAnyGlob(file, [glob]));
      if (forbidden) violations.push(`task ${candidate.taskId}: changed file is forbidden: ${file} matches ${forbidden}`);
      if (!matchesAnyGlob(file, candidate.targetFiles)) {
        violations.push(`task ${candidate.taskId}: changed file is outside targetFiles: ${file}`);
      }
    }
    for (const dependency of candidate.dependencies ?? []) {
      const dependencyIsWriterCandidate = candidates.some((other) => other.taskId === dependency);
      const dependencyMerged = (candidate.mergedDependencyTaskIds ?? []).includes(dependency);
      if (dependencyIsWriterCandidate && !dependencyMerged) {
        violations.push(`task ${candidate.taskId}: depends on unmerged writer output from ${dependency}`);
      }
    }
  }

  const byRepo = new Map<string, WriterConcurrencyCandidate[]>();
  for (const candidate of candidates) {
    byRepo.set(candidate.repoRoot, [...(byRepo.get(candidate.repoRoot) ?? []), candidate]);
  }
  for (const [repoRoot, repoCandidates] of byRepo) {
    if (repoCandidates.length > 1) {
      violations.push(
        `target repo ${repoRoot} has multiple writer candidates: ${repoCandidates.map((candidate) => candidate.taskId).join(", ")}`,
      );
    }
  }

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      for (const leftFile of taskWriteSet(left)) {
        const rightFile = taskWriteSet(right).find((file) => targetsOverlap(leftFile, file));
        if (rightFile) {
          violations.push(
            `writer candidates ${left.taskId} and ${right.taskId} overlap target files: ${leftFile} <-> ${rightFile}`,
          );
          break;
        }
      }
    }
  }

  const repoViolations = await Promise.all(candidates.map(targetRepoViolations));
  violations.push(...repoViolations.flat());

  return {
    schemaVersion: 1,
    evaluatedAt: input.evaluatedAt,
    advisoryOnly: true,
    advisorySafe: violations.length === 0,
    mayIncreaseWriterCap: false,
    writerCap: policy.writerCap,
    candidateCount: candidates.length,
    violations: unique(violations),
  };
}
