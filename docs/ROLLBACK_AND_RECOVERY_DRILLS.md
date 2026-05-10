# Rollback And Recovery Drills

Last updated: 2026-05-10

Status: active Phase 7 M8 rollback and recovery drill guidance.

These drills are controlled operator exercises. They do not run workers, retry
failed plans, mutate git history, push, merge, or cleanup automatically. The
catalog lives in `references/governance/recovery-drills.json`, and local reports
are available through:

```bash
bun run samantha drills:list
bun run samantha drills:show <drill-id>
bun run samantha drills:record <drill-id> --outcome=<fixed|still_blocked|needs_bk> --note=<summary>
```

Recorded outcomes append governance events to `state/governance-events.jsonl`
with `operator_report` source ids such as `recovery-drill:failed-verify`.

Every catalog drill includes rollback authority guidance. Rollback authority is
limited to deterministic recovery planning, governed corrective work,
BK/operator action, or current decision commands. Workers, non-writers, and
orchestrator agents must not roll back state directly.

## Outcome Labels

- `fixed`: the drill reached a safe resolved state through normal gates.
- `still_blocked`: the failure remains blocked and should stay visible.
- `needs_bk`: BK must make a decision before Samantha can safely continue.

## Root Rule

Recovery work must start from the canonical `repoRoot` in the selected project
profile, after normal project profile expansion. Old worker worktrees, run logs,
and changed-file lists are evidence only. They are not recovery roots.

For Samantha, the canonical profile record is
`references/project-profiles/samantha.json`. The profile may contain environment
variables such as `$HOME`; use the resolved profile root in local commands and
reports, not a stale worker worktree path.

## Cleanup Classification

`worktree:cleanup` classifies cleanup candidates before attempting removal:

- `completed`: the run passed, the worker commit is integrated, the target repo
  is clean, and the worker worktree is clean. This is the only state that may
  run `git worktree remove`.
- `dirty`: the target repo or worker worktree has uncommitted changes. Cleanup
  is blocked without removing anything.
- `missing`: the allocated worker worktree path is missing or invalid while
  cleanup cannot prove it was already completed. Cleanup is blocked without
  removing anything.
- `abandoned`: the run failed, lacks a commit, or the target repo does not
  contain the worker commit. Cleanup is blocked without removing anything.
- `already_cleaned`: the worker worktree and branch are gone, but the worker
  commit is already integrated. The cleanup gate is idempotent.
- `blocked`: cleanup would target the main repo worktree, the wrong repo, the
  wrong branch, or another safety blocker.

## Drill Catalog

### Failed Worker Verification

Signals:

- Worker result has `pass=false`.
- One or more verify commands exited non-zero.
- The plan synthesis is failed or mixed.

Recovery:

- Do not merge the failed run.
- Inspect `runs:show` and `review:show` evidence.
- Create recovery work from the canonical project profile root.
- Verify the recovery before merge, push, and cleanup gates.

### Dirty Worktree Before Integration

Signals:

- `merge:check` reports uncommitted changes.
- The run lifecycle has no `mergedAt`.
- `review:show` reports partial integration.

Recovery:

- Stop at the merge gate while the integration target is dirty.
- Do not clean unrelated user changes.
- Resolve ownership through BK decision or an approved recovery task.
- Re-run `merge:check` before any merge attempt.

### Merge Conflict

Signals:

- `merge:apply` exits non-zero.
- Merge gate reports non-fast-forward or conflicting changes.
- The lifecycle is not marked merged.

Recovery:

- Treat the merge as blocked.
- Do not force merge and do not edit the worker worktree as the root.
- Plan conflict resolution from the canonical project profile root.
- Re-run verification after the conflict resolution task.

### Failed Push

Signals:

- Lifecycle has `mergedAt` but no `pushedAt`.
- `merge:push` exits non-zero.
- `review:show` reports partial integration.

Recovery:

- Keep the run partially integrated until push succeeds or BK chooses a path.
- Do not mark `pushedAt` manually.
- Do not run cleanup before push status is settled.
- A push retry is an explicit operator action, not an automatic worker retry.

### Stale Approval

Signals:

- The decision subject no longer points to a current planned plan.
- The plan is materialized, canceled, superseded, or missing.
- `/go` reports no actionable current approval.

Recovery:

- Do not materialize tasks from stale approval evidence.
- Reject, archive, cancel, or revise through normal decision commands.
- Create a fresh plan approval if the work is still desired.
- Keep stale decisions as audit history.

### Mistaken Profile Proposal

Signals:

- A proposal grants writer authority to a non-writer.
- A profile change modifies model, worktree, merge, skill, connector, or secret
  authority without the matching approval.
- Profile governance reports unapproved authority change.

Recovery:

- Reject the mistaken proposal or request a narrower revision.
- Do not activate profile changes from LLM output alone.
- If unsafe profile text was merged, create a corrective task from the canonical
  project profile root and run normal verification.

### Blocked Capability Request

Signals:

- Connector or secret access is requested without an approved capability record.
- A skill bundle conflicts with Samantha orchestration safety policy.
- Capability governance reports missing or blocked grants.

Recovery:

- Keep denial reports redacted.
- Reject blocked requests or create a narrower governed capability proposal.
- Do not pass connectors or secrets to workers without exact approved capability
  records.
- If an unsafe grant was merged, revoke it through normal approval and
  integration gates.

## Rollback Guidance

Pre-merge rollback is usually refusal to advance: leave the failed run, stale
approval, blocked merge, or blocked capability request visible and create a
fresh approved recovery path from the canonical profile root.

Post-merge rollback is explicit corrective work. Samantha should propose either
a revert task or a forward-fix task, then run verification, merge, push, and
cleanup gates normally. Do not rewrite git history from Samantha, and do not use
hidden manual state edits to make reports look clean.
