# MVP Hardening

Last updated: 2026-05-07

This document contains the execution stages for roadmap Phase 2:
[MVP Hardening](CEO_OFFICE_ROADMAP.md#2-mvp-hardening).

The hardening phase assumes the Stage 1-9 MVP slice already exists. Its purpose
is to make the MVP reliable for real daily dogfood before expanding scope.

## H1: CEO Status Noise Reduction

Goal: improve CEO status and report quality for real host operation.

Focus:

- separate current actionable blockers from historical failures
- keep unresolved real failures visible
- avoid mutating or deleting historical state just to make reports cleaner
- make `ceo:status` and `ceo:notify` clearly show BK's next action
- preserve deterministic CEO Office authority

Verification focus:

- historical failed runs that should not dominate current status
- unresolved failures that must remain visible
- pending decisions
- current actionable blockers
- idle state after resolved work

## H2: Decision Queue Hardening

Goal: make BK decision handling safe and obvious.

Focus:

- ensure pending, approved, rejected, and archived decisions have clear
  deterministic lifecycle behavior
- make decision output useful without requiring unnecessary internal ids
- prevent approve-latest or reject-latest from resolving stale decisions
- keep "Needs BK" before lower-priority report details
- keep risky or ambiguous actions behind explicit BK decisions

Verification focus:

- approving latest pending decision
- rejecting latest pending decision
- no-op behavior when no pending decision exists
- stale or resolved decisions not appearing as active needs
- CEO report output ordering

## H3: CEO Notify And Delivery Idempotency

Goal: make periodic CEO notification safe to run repeatedly.

Focus:

- `ceo:notify` must be idempotent for the same report identity
- re-running a timer or service should not create duplicate meaningful
  notifications
- outbox delivery state should not be overwritten incorrectly
- Telegram reply adapter should not resend already-sent CEO reports unless
  explicitly requested
- generated reports should remain auditable through state files

Verification focus:

- duplicate `ceo:notify` invocation
- existing report lookup
- outbox report preservation
- already-sent delivery state
- failed-send retry behavior if touched

## H4: CLI And Dashboard Operating Surface

Goal: make the CEO Office review surface useful for longer work sessions.

Focus:

- `ceo:status` should be compact, ordered, and actionable
- dashboard should show active work, blockers, decisions, risks, and next action
  clearly
- dashboard should distinguish current problems from historical failures
- dashboard should not add write controls unless deterministic gates already
  support the operation
- Telegram remains a compact adapter, not the primary workspace

Verification focus:

- dashboard rendering of CEO status sections
- current vs historical problem separation
- pending decision visibility
- escaped report and dashboard content
- empty or idle dashboard state

## H5: Recovery And Continuity Hardening

Goal: make recovery behavior clear after failed plans, failed runs, blocked
actions, and stale task state.

Focus:

- recovery reports should say whether the original problem is fixed, still
  blocked, or needs BK
- failed-plan recovery should use canonical project roots
- stale task and archive rules should prevent old state from driving unsafe
  remote actions
- remote next-action behavior should surface recovery when recovery is the
  right next step
- failed work should not be blindly retried

Verification focus:

- failed plan recovery context
- stale task not selected as next action
- canonical repo-root recovery task creation
- recovery success vs still-blocked reporting
- remote next-action with recoverable failure context

## H6: Ubuntu Host Automation Readiness

Goal: harden host automation artifacts and diagnostics for the Samantha
Ubuntu/WSL host.

Focus:

- systemd user service and timer templates should be complete and documented
- doctor and health checks should identify missing CEO notify timer, stale
  locks, stale heartbeat, Telegram issues, and queue backlog
- host commands should avoid Mac absolute paths
- runtime state should stay Ubuntu-owned
- Mac verification should remain portable

Verification focus:

- systemd template presence
- operations diagnostics for CEO notify timer
- stale heartbeat and lock reporting
- missing runtime prerequisite reporting
- path portability where applicable

## H7: Parallelism Evidence And Safety

Goal: harden the Stage 9 evidence model without enabling multi-writer
execution.

Focus:

- writer cap must remain `1`
- parallel non-writer behavior should be auditable and safe
- evidence for increasing writer cap must be explicit and documented
- reports should explain parallel role outcomes without raw internal noise
- merge, push, cleanup, and lifecycle gates must remain deterministic
- `docs/PARALLELISM_EVIDENCE.md` must match actual behavior

Verification focus:

- writer cap remains `1`
- non-writer parallel planning and reporting
- blocked multi-writer attempt or unsafe dispatch
- lifecycle gate ordering
- evidence documentation consistency

## Standard Verification

Mac-side verification:

```bash
bun typecheck
bun run test:portable
bun run verify:docs
bun run verify:mac
```

Ubuntu host verification, when host runtime behavior is touched:

```bash
bun run test:host
bun run test:all
bun run verify:host
```

Do not run Samantha daemon, watch, poll, reply, worker dispatch, or dashboard
runtime processes from Mac.
