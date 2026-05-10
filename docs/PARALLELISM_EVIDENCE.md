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
| Prefer non-writer parallel confidence first | `tests/operations.test.ts` covers ready non-writers in the same plan batch before writers. | `bun run test:portable` |
| Serialize ready writers | `tests/operations.test.ts` covers two ready writers becoming separate batches. | `bun run test:portable` |
| Keep non-writers read-only | `tests/policy.test.ts` and `tests/orchestrator-materializer.test.ts` reject non-writer write proposals. | `bun run test:portable` |
| Record compact parallel evidence | `src/lib/parallelism-evidence-store.ts` records plan/action/task/run refs, roles, result modes, writer count, changed files, verification summary, merge status, cleanup status, and outcome without copying full run logs. `tests/parallelism-evidence.test.ts` covers append/list/filter, successful report-only evidence, failed evidence preservation, and writer-cap preservation. | `bun test tests/parallelism-evidence.test.ts` |
| Keep parallel reports readable | `tests/parallelism-evidence.test.ts` covers parallel specialist plus single-writer role outcomes without raw action/status noise. | `bun run test:portable` |
| Keep integration deterministic | `tests/merge-gate.test.ts` covers merge and push gates; `tests/worktree-cleanup.test.ts` covers cleanup gates; `tests/run-lifecycle-store.test.ts` records lifecycle status in `state/run-lifecycle.jsonl`. | `bun run test:portable` |
| Keep recovery deterministic | `tests/recovery-context.test.ts`, `tests/recovery-continuity.test.ts`, and `tests/operations.test.ts` cover `/recover -> /plan -> /go`, failed-plan evidence, and canonical repo-root instructions. | `bun run test:portable` |

## Dogfood Notes

Phase 4 P9 reviewed the mature planning path without changing runtime writer
concurrency. The evidence covers ambiguous work that stays question-only,
recovery work that uses canonical project roots, report-only specialist work
that remains read-only, and one-writer implementation plans with advisory
alternatives and selected-plan-only materialization.

These notes are sufficient for parallel report-only specialists plus one writer.
They are not sufficient for multi-writer execution.

## Bar For Writer Cap Increase

Before changing `writerCap` above `1`, update this document first with:

- dogfood run date and operator;
- task ids, action ids, run-log paths, and commits for every writer involved;
- proof that writers used separate worktrees and non-overlapping `targetFiles`;
- proof that merge, push, cleanup, and recovery gates remained deterministic;
- failure response for dirty worktrees, target-file violations, failed verify
  commands, merge conflicts, push failures, and abandoned worktrees;
- focused tests for the exact concurrency behavior being added.

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
- Failed materialized plans use `/recover`; the recovery request includes the
  failed plan, failed actions, changed files, run logs, and artifact previews as
  evidence.
