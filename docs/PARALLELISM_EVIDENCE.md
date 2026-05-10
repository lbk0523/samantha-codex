# Parallelism Evidence Policy

Phase 7 expands parallelism only when dogfood evidence supports it. The current
decision is deliberately conservative: Samantha may run report-only non-writer
work in parallel, but production writers remain capped at one.

## Current Policy

- `DEFAULT_SAFETY_POLICY.writerCap` stays `1`.
- `buildPlanBatches` batches ready non-writers first, then runs ready writers one
  at a time.
- `materializeOrchestratorPlan` rejects any orchestrator batch containing more
  than one non-report writer task.
- Non-writer agents must use `resultMode: "report"`, `worktreePolicy: "none"`,
  and `mergePolicy: "none"`.
- Writer agents must use per-task worktrees and Samantha-controlled merge.
- Merge, push, and cleanup remain explicit Samantha gates after worker execution.

There is no automatic Phase 7 writer cap increase.

## Evidence Matrix

| Decision | Evidence | Verification |
| --- | --- | --- |
| Keep writer cap at `1` | `tests/policy.test.ts` checks `DEFAULT_SAFETY_POLICY.writerCap`; `tests/orchestrator-materializer.test.ts` blocks a batch with two writer tasks. | `bun run test:portable` |
| Prefer non-writer parallel confidence first | `tests/operations.test.ts` covers ready reviewer, researcher, and evaluator reports in the same plan batch before writers. | `bun run test:portable` |
| Serialize ready writers | `tests/operations.test.ts` covers two ready writers becoming separate batches. | `bun run test:portable` |
| Keep non-writers read-only | `tests/policy.test.ts`, `tests/operations.test.ts`, and `tests/orchestrator-materializer.test.ts` reject non-writer write proposals, worktree allocation, merge authority, and report-only dependencies on unmerged writer output. | `bun run test:portable` |
| Record compact parallel evidence | `src/lib/parallelism-evidence-store.ts` records plan/action/task/run refs, roles, result modes, writer count, changed files, verification summary, merge status, cleanup status, and outcome without copying full run logs. `tests/parallelism-evidence.test.ts` covers append/list/filter, successful report-only evidence, failed evidence preservation, and writer-cap preservation. | `bun test tests/parallelism-evidence.test.ts` |
| Keep parallel reports readable | `tests/parallelism-evidence.test.ts` covers parallel specialist plus single-writer role outcomes without raw action/status noise. | `bun run test:portable` |
| Keep integration deterministic | `tests/merge-gate.test.ts` covers merge and push gates; `tests/worktree-cleanup.test.ts` covers cleanup gates and classifies completed, dirty, missing, abandoned, already-cleaned, and blocked cleanup candidates; `tests/run-lifecycle-store.test.ts` records lifecycle status in `state/run-lifecycle.jsonl`. | `bun run test:portable` |
| Keep recovery deterministic | `tests/recovery-context.test.ts`, `tests/recovery-continuity.test.ts`, `tests/recovery-drills.test.ts`, and `tests/operations.test.ts` cover `/recover -> /plan -> /go`, failed-plan evidence, canonical repo-root instructions, and rollback authority limited to deterministic recovery or operator action. | `bun run test:portable` |
| Keep role topology advisory | `src/lib/role-topology.ts` defines advisory role relationships and explicitly denies dispatch, writer, connector, secret, merge, push, cleanup, rollback, approval, and safety-policy authority. `tests/policy.test.ts`, `tests/profile-governance.test.ts`, `tests/orchestrator-agent.test.ts`, and `tests/operator-reports.test.ts` cover known-role validation, governance approval, planning/reporting visibility, and unchanged dispatch policy. | `bun run test:portable` |
| Keep writer conflict detection advisory | `src/lib/parallelism-conflict-detector.ts` detects overlapping target files, forbidden changes, same-repo writer candidates, stale bases, dirty target repos, unmerged writer dependencies, and missing passing evidence. `tests/parallelism-conflict-detector.test.ts` verifies unsafe overlap, stale/dirty cases, missing evidence, evidence-record attachment, governance blocking, and `writerCap` staying `1`. | `bun test tests/parallelism-conflict-detector.test.ts` |
| Keep merge queue classification deterministic | `src/lib/merge-gate.ts` classifies candidates as `mergeable`, `already_merged`, `stale_base`, `failed_verification`, `dirty_target_repo`, `missing_commit`, or `blocked`, and evaluates sorted merge queues without push commands. `tests/merge-gate.test.ts` covers deterministic ordering, clean mergeable candidates, stale/dirty/missing/failed candidates, post-merge verification failure, and push staying separate. | `bun test tests/merge-gate.test.ts` |
| Govern writer-cap changes | `src/lib/profile-governance.ts` requires complete dogfood evidence, safe deterministic conflict evidence, completed merge and cleanup evidence, completed rollback drill evidence, and explicit BK approval whose prompt includes the auditable policy diff before a `writerCap` increase can pass governance. `tests/profile-governance.test.ts` covers insufficient evidence, approval without evidence, complete evidence, and the default cap staying `1`. | `bun test tests/profile-governance.test.ts` |

## Dogfood Notes

Phase 4 P9 reviewed the mature planning path without changing runtime writer
concurrency. The evidence covers ambiguous work that stays question-only,
recovery work that uses canonical project roots, report-only specialist work
that remains read-only, and one-writer implementation plans with advisory
alternatives and selected-plan-only materialization.

These notes are sufficient for parallel report-only specialists plus one writer.
They are not sufficient for multi-writer execution.

Phase 7 M10 closed the evidence review on 2026-05-10 with `writerCap` still at
`1`. The active two-profile baseline remains `samantha` and `omht`; both
profiles expose report-only planning/report scopes, while the implemented
single-writer canary remains on `samantha`.

| Phase 7 dogfood item | Evidence | Result |
| --- | --- | --- |
| Two active project profiles | [references/project-profiles/samantha.json](../references/project-profiles/samantha.json), [references/project-profiles/omht.json](../references/project-profiles/omht.json), and [tests/project-profile.test.ts](../tests/project-profile.test.ts) cover deterministic loading, scope selection, inference, and environment override behavior. | Met for active-profile baseline. |
| Parallel non-writer reports | [tests/operations.test.ts](../tests/operations.test.ts) batches reviewer, researcher, and evaluator reports before serialized writers; [tests/orchestrator-materializer.test.ts](../tests/orchestrator-materializer.test.ts) materializes reviewer, researcher, and evaluator report tasks alongside one writer. | Met for report-only parallelism. |
| One implementation flow with parallel non-writers plus one writer | [tests/orchestrator-materializer.test.ts](../tests/orchestrator-materializer.test.ts) covers reviewer/researcher/evaluator reports plus one `codex-worker`; [tests/operations.test.ts](../tests/operations.test.ts) keeps the role-aware `samantha` reviewer-to-writer canary dependency-gated. | Met for single-writer implementation. |
| OMHT report-only flow | [tests/operations.test.ts](../tests/operations.test.ts) materializes `omht` report-mode work with no target-file writes or commit requirement. | Met for report-only project evidence; not evidence for OMHT writer concurrency. |
| Writer-cap increase | [tests/profile-governance.test.ts](../tests/profile-governance.test.ts) and [tests/parallelism-conflict-detector.test.ts](../tests/parallelism-conflict-detector.test.ts) prove the gate shape, but no production multi-writer policy change was applied. | Not approved. `writerCap` remains `1`. |

## Bar For Writer Cap Increase

Before changing `writerCap` above `1`, update this document first with:

- dogfood run date and operator;
- task ids, action ids, run-log paths, and commits for every writer involved;
- proof that writers used separate worktrees and non-overlapping `targetFiles`;
- advisory conflict-detection output showing clean target repos, current base
  commits, no forbidden changes, no same-repo write conflicts, and no unmerged
  writer dependencies;
- proof that merge, push, cleanup, and recovery gates remained deterministic;
- failure response for dirty worktrees, target-file violations, failed verify
  commands, merge conflicts, push failures, and abandoned worktrees;
- focused tests for the exact concurrency behavior being added.
- explicit BK approval for the safety-policy change with the auditable diff in
  the decision prompt.

If any item is missing, the writer cap stays `1`.

## Rollback And Recovery

Samantha does not let a worker, non-writer, or orchestrator agent roll back
state directly. Recovery stays deterministic:

- Before merge, reject or leave the worker run unmerged and use the recovery
  flow if a replacement task is needed.
- After merge, create a new bounded writer task or local operator revert through
  the same verification and integration gates.
- Cleanup only removes a completed worker worktree after the worker commit is
  integrated, the target repo is clean, and the worker worktree is clean.
- Cleanup classifies non-removal states as dirty, missing, abandoned, blocked,
  or already cleaned; destructive cleanup is not attempted for dirty, missing,
  abandoned, or blocked candidates.
- Failed materialized plans use `/recover`; the recovery request includes the
  failed plan, failed actions, changed files, run logs, and artifact previews as
  evidence.
- Recovery drills record rollback authority explicitly. Rollback is allowed only
  through deterministic recovery planning, governed corrective work, BK/operator
  action, or current decision commands; workers, non-writers, and orchestrator
  agents must not roll back state directly.
