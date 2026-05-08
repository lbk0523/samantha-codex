# Operating Surface Consolidation

Last updated: 2026-05-08

Status: implemented.

This document contains the execution stages for roadmap Phase 3:
[Operating Surface Consolidation](CEO_OFFICE_ROADMAP.md#3-operating-surface-consolidation).

The consolidation phase assumes the hardened MVP already has durable state,
CEO status snapshots, Telegram notification and approval adapters, a read-only
dashboard, and local CLI fallback commands. Its purpose is to make those pieces
feel like one CEO office instead of several unrelated inspection paths.

## Non-Scope

- No new worker dispatch authority.
- No Telegram shell commands, repo paths, or routine workflow ids.
- No dashboard write controls unless the deterministic gate already exists.
- No expansion of writer concurrency.
- No new durable state store unless an existing store cannot represent the
  required audit state.

## S1: Shared Operating Surface View

Goal: put display decisions above `CeoStatusSnapshot` in one deterministic
view model.

Focus:

- headline status
- one-minute summary
- primary next action
- Telegram command
- local fallback command
- audit references separated from routine display text

Verification focus:

- the operating surface view preserves the CEO next-action kind
- routine display text does not require raw ids
- audit references remain available in structured data

## S2: Consistent Report Wording

Goal: make CLI CEO reports, Telegram CEO notifications, and dashboard CEO
review use the same core wording.

Focus:

- shared summary counts
- shared headline
- shared primary next-action label
- shared Telegram command mapping
- local fallback shown only where useful for long review

Verification focus:

- `ceo:status`, `ceo:notify`, and dashboard render from the shared view
- Telegram output remains compact and avoids shell commands
- dashboard shows the same next action as the compact notification

## S3: Dashboard-First Long Review

Goal: make the dashboard the default long-review surface.

Focus:

- first-screen daily review
- Needs BK before lower-priority details
- active work, blockers, risks, and historical failures in predictable sections
- read-only controls until deterministic write gates exist

Verification focus:

- dashboard presents daily review before raw run tables
- dashboard has no buttons or forms for unsupported mutations
- text remains escaped before HTML rendering

## S4: Telegram-First Compact Approval

Goal: keep Telegram useful for fast status and approval without becoming the
primary workspace.

Focus:

- `/now` and CEO notifications identify exactly one remote-safe next command
- approval, revision, cancellation, and recovery commands stay compact
- internal ids and shell commands stay out of routine Telegram text

Verification focus:

- compact reports contain one next-action section
- compact reports do not expose workflow ids outside audit/debug headings
- deprecated commands continue to redirect to the current compact surface

## S5: CLI As Precise Fallback

Goal: keep CLI useful for operators who need exact audit state.

Focus:

- `ceo:status` remains the precise report
- raw ids remain visible in local CLI or JSON output
- dashboard and Telegram do not require ids for routine operation

Verification focus:

- local CLI exposes deterministic commands for every next action
- `--json` exposes audit refs without altering durable state
- Mac-safe verification remains portable

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
