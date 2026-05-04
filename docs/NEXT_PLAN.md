# Samantha-Codex Next Plan

Last updated: 2026-05-04

## Current Baseline

The Phase 1-7 MVP exists and has passed the first real dogfood loop:

- run index and task ledger
- operator CLI
- merge candidate checks
- explicit `merge:apply`, `merge:push`, and completed worktree cleanup gates
- run lifecycle ledger for merge/push/cleanup state
- plan runner
- local `inbox:watch` daemon with heartbeat and lock protection
- narrow Telegram polling into the inbox
- Telegram outbox replies
- proposal intake/review and accepted-proposal task drafts
- project profiles and local-only task approval/dispatch
- read-only static dashboard

Current operating status:

- `.env` has the local Telegram bot token and chat id values.
- `doctor` reports no failures or warnings.
- pending inbox is `0`.
- unsent remote outbox reports are `0`.
- `/next-action` reports no immediate action for the latest completed OMHT run.
- The latest OMHT writer run is merged, pushed, cleaned, and backfilled in `state/run-lifecycle.jsonl`.

Runtime state under `state/`, `runs/`, `outbox/`, and `archive/` remains local and ignored by Git.

## Current Objective

Make Telegram feel like the practical 24/7 operating console without opening unsafe execution paths.

The immediate implementation focus is:

1. keep `/status` as the quick operational view
2. keep `/doctor` as the deeper diagnostic view
3. show the latest remote command/report state
4. show reply failure state clearly
5. show latest run lifecycle state
6. keep worker dispatch, merge, push, cleanup, task approval, and arbitrary shell execution local-only

## Next Implementation Slice

### Stage A: Telegram Operating Status

Improve `/status` so BK can answer these questions from Telegram:

- Is Samantha healthy right now?
- Is the local queue empty?
- Did Telegram replies finish sending?
- What was the latest remote command?
- What was the latest remote report?
- Did the latest worker run still need merge/push/cleanup, or is it done?

Success criteria:

- `/status` remains compact enough for Telegram.
- It includes queue, daemon, Telegram offset/reply, proposal/draft, latest run, and lifecycle state.
- It does not print secrets.
- It does not expose new write actions.

### Stage B: Doctor Clarity

Improve `/doctor` so it identifies operational blockers quickly:

- missing env values
- stale daemon heartbeat
- pending inbox backlog
- unsent remote reports
- Telegram reply failures
- missing Telegram offset/reply state
- missing systemd templates

Success criteria:

- failures and warnings stay explicit.
- latest remote command/report context is visible.
- reply failures include the file, attempts, and last error.
- no token, chat secret, or message body is printed unnecessarily.

### Stage C: Documentation Sync

Keep the docs aligned with the actual command surface:

- `BUILD_PLAN.md`
- `REMOTE_ADAPTERS.md`
- `DAEMON_OPERATIONS.md`
- `DOGFOOD_SCENARIOS.md`
- this `NEXT_PLAN.md`

Success criteria:

- docs no longer say real Telegram dogfood is blocked.
- docs state that remote command execution remains safe-gated.
- docs state that the current next priority is Telegram operating UX, not multi-writer parallelism.

## Out Of Scope For This Slice

Do not implement these yet:

- remote worker dispatch
- remote task approval
- remote merge/push/cleanup
- multi-writer parallelism
- dashboard write controls
- autonomous push/deploy behavior

These are deliberately delayed until the Telegram operating surface is boring and reliable.

## After This Slice

Reassess with BK before moving to the next phase.

Likely next candidates:

1. simplify draft-to-task preparation
2. upgrade the dashboard into a real read-only operations board
3. run a second tiny OMHT writer dogfood through the full proposal-to-cleanup flow

The default next move should be draft-to-task simplification unless the Telegram operating UX reveals a blocker.
