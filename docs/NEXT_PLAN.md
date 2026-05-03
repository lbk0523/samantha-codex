# Samantha-Codex Next Plan

Last updated: 2026-05-03

## Starting Point

The Phase 1-7 MVP exists:

- run index and task ledger
- operator CLI
- merge candidate checks
- plan runner
- local inbox/outbox loop
- narrow remote command enqueueing
- read-only static dashboard

The first full dogfood pass completed through read-only real Codex execution against `oh-my-health-trainer`. No critical stop condition occurred.

The writer dogfood, merge apply/push gates, completed worktree cleanup, daemon hardening, and Telegram adapter scaffold are now implemented. The next useful proof is real Telegram dogfood using the existing Samantha bot environment, while keeping the adapter limited to inbox writes.

## Current Constraints

- `oh-my-health-trainer` main is clean and pushed.
- The old `omht-schema-07-new-block-fixture-canary` and `omht-schema-07-unknown-block-negative-canary` tasks must not be rerun because they were already applied.
- Non-writer agents no longer receive parent `.git` metadata write access.
- Writer agents do not receive parent `.git` metadata access. They edit and verify files only; Samantha creates commits after scope and verify gates pass.
- Real Telegram dogfood is blocked until `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are available in the Samantha-Codex runtime.

## Objective

Prove Samantha can safely receive a real remote Telegram command end to end:

1. keep `inbox:watch` healthy
2. poll Telegram using `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
3. authorize by the legacy chat id
4. map a narrow command such as `/runs` into `inbox/*.json`
5. let `inbox:watch` process it
6. verify an outbox report is written
7. preserve offset state so the same Telegram update is not replayed

## Stage A: Local Daemon Soak

Run `inbox:watch` for a longer local soak before real Telegram polling.

Success criteria:

- `health:check` stays healthy
- duplicate watcher start is blocked
- one local inbox command moves to outbox and archive
- heartbeat `processedTotal` increments

## Stage B: Legacy Telegram Env Setup

Use local, uncommitted env values:

```text
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<telegram-chat-id>
```

Success criteria:

- no secret is committed
- `TELEGRAM_CHAT_ID` is accepted without requiring a renamed variable
- `telegram:poll` can also accept `--allowed-sender-id` for explicit overrides

## Stage C: Real Telegram Poll Dogfood

Send `/runs` or `/tasks` to the bot, then run:

```bash
bun run samantha telegram:poll --timeout-seconds=0
```

Success criteria:

- exactly one allowed update is enqueued
- disallowed senders are ignored
- unsupported commands fail closed
- offset state is written under `state/telegram-offset.json`
- `inbox:watch` writes the final report to `outbox/`

Critical stop conditions:

- Telegram token or chat id is missing from local runtime
- poll returns updates from an unexpected chat
- adapter attempts to execute work directly instead of writing inbox
- duplicate update replay creates repeated inbox commands

## Stage D: Enable 24/7 Timer

After a manual real poll passes, enable the timer:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/samantha-telegram-poll.service ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-poll.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now samantha-telegram-poll.timer
```

Success criteria:

- timer runs without overlapping failures
- each poll writes only inbox files
- `inbox:watch` remains the only processor
- journal logs do not print token values

## Stage E: Post-Dogfood Hardening

Harden whatever Telegram dogfood reveals. Likely areas:

- clearer failure outbox reports for remote commands
- dashboard display for latest remote command
- timer failure health signal
- duplicate update protection beyond Telegram offset

Success criteria:

- any discovered failure gets either a fix or a documented blocked reason
- tests cover each fix
- `BUILD_PLAN.md` and `DOGFOOD_SCENARIOS.md` stay consistent

## Already Stable: Integration Gate Design

After one writer dogfood passes and BK approves the integration model, use separate integration gates.

Implemented commands:

```text
merge:check
merge:apply --run-log=<path>
merge:push --remote=origin --branch=main
```

Policy:

- `merge:apply` only accepts a passing run log
- no dirty target repo
- no branch mismatch
- no missing commit
- post-merge verify commands must run
- push remains separate from merge

Do not combine merge and push in one command yet.

Current behavior:

- `merge:check` returns the fast-forward candidate without changing the target repo.
- `merge:apply` reuses `merge:check`, executes `git merge --ff-only <commit>`, then runs the task `verifyCommands` on the target main worktree.
- `merge:push` checks branch and clean worktree state, then runs `git push <remote> <branch>`.

## Already Stable: Daemon Packaging

Only after writer dogfood and integration gate are stable:

- keep the systemd user service template
- keep `inbox:watch` restart guidance
- keep lockfile protection for duplicate watchers
- keep `health:check`
- keep structured daemon heartbeat under `state/`

Success criteria:

- process restart does not lose queued inbox commands
- duplicate daemon start is blocked or harmless
- dashboard can show last heartbeat
- bad inbox commands produce outbox failure reports and are archived

## Already Stable: Remote Adapter Scaffold

Only after file-backed daemon is stable:

- keep the Telegram polling adapter
- remote adapter writes to inbox only
- adapter cannot run shell commands
- sender allowlist is mandatory
- all remote commands produce outbox reports

Success criteria:

- no remote path bypasses inbox/ledger/audit
- unsupported commands fail closed
- remote UX stays read-mostly until merge gate is mature

## Later: Dashboard Upgrade

After writer dogfood:

- show pending inbox count
- show latest run outcome
- show failed gate summary
- show merge candidates
- link to run log path
- show repo status summaries from explicit snapshots

Keep dashboard read-only.

## Definition Of Done For Next Cycle

The next cycle is complete when:

- local daemon soak stays healthy
- real Telegram `/runs` or `/tasks` enqueues exactly one inbox command
- `inbox:watch` writes the final outbox report
- Telegram offset state prevents replay
- Telegram timer templates are either enabled or blocked only by missing local token/chat id
- any hardening fix is committed and pushed

## Execution Notes

This cycle revealed that Codex CLI sandboxing still blocks worker writes to parent worktree Git metadata, even when explicit Git metadata paths are supplied through `--add-dir`.

The safer design is now:

- worker agents edit files and run verification only
- worker agents do not commit or push
- Samantha creates the task commit after `HARNESS_RESULT`, scope checks, and verify commands pass
- merge gate reads Samantha-owned commit metadata from the run log

The fresh writer dogfood passed with commit:

```text
61824293b56fdf8ed84258c70de419b6f4353171
```

The merge candidate remained manual:

```bash
git merge --ff-only 61824293b56fdf8ed84258c70de419b6f4353171
```

## Recommended Next Action

Next, dogfood `telegram:poll` with a real bot token after one longer `inbox:watch` soak.
