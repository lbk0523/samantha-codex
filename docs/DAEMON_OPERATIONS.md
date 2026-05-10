# Samantha Daemon Operations

Last updated: 2026-05-10

## Purpose

`inbox:watch` is the local 24/7 loop. It watches `inbox/*.json`, writes reports to `outbox/*.md`, archives processed commands, and updates daemon state.

## Local Commands

Start manually:

```bash
bun run samantha inbox:watch
```

If Telegram-approved dispatch actions should run, configure the target repo locally and run the action watcher:

```bash
SAMANTHA_REPO_ROOT=$HOME/projects/samantha-codex bun run samantha actions:watch
```

Check health:

```bash
bun run samantha health:check
```

Run full local diagnostics:

```bash
bun run samantha doctor
```

Build the read-only operations dashboard:

```bash
bun run samantha dashboard:build
```

The dashboard includes daemon, queue, Telegram, latest remote command/report,
proposal/draft/task counts, project queue summaries, cross-project ranking,
recent runs, and latest run lifecycle state. It does not expose write actions.

## Runtime Files

- `state/host-ownership.json`: read-only host ownership record used by
  diagnostics to decide whether the current machine is the active automation
  host, a client machine, stale, or unknown
- `state/daemon.lock`: prevents duplicate `inbox:watch` processes
- `state/heartbeat.json`: last daemon heartbeat
- `state/proposals.jsonl`: remote work proposals and review state
- `state/task-drafts.jsonl`: task drafts created from accepted proposals
- `state/remote-actions.jsonl`: pending/approved/running/finished Telegram-approved dispatch actions
- `state/run-lifecycle.jsonl`: merge, push, and cleanup state for completed runs
- `state/orchestration-requests.jsonl`: orchestration requests with assigned,
  unassigned, or legacy ancestry
- `state/orchestrator-plans.jsonl`: bounded orchestrator plans with project,
  goal, and work-item ancestry when assigned
- `state/ceo-reports.jsonl`: generated CEO reports, including project queues
  and ranking evidence when available
- `inbox/*.json`: queued local commands
- `outbox/*.md`: command reports
- `archive/inbox/*.json`: processed input commands

Bad inbox commands are archived and get an outbox failure report instead of crashing the watcher.

## Host Service Managers

Only one automation host should run these services at a time. Stop the old host before enabling services on a new host.

Use `ops/systemd/` on Linux or WSL hosts. Use `ops/launchd/` on macOS hosts.

## Backup, Restore, And Host Migration Drills

Backups are manifest-based. A manifest records relative paths, bytes, hashes,
record categories, portable project profile files, host-owned runtime
artifacts, and the restore authority contract. Restore validation is
read-only: it does not dispatch workers, approve decisions, merge, push,
cleanup worktrees, recover plans, or rewrite git history.

Generate a deterministic manifest:

```bash
bun run samantha backup:manifest --out=backup-manifest.json --generated-at=<iso timestamp>
```

Validate a restored tree before treating it as active:

```bash
bun run samantha restore:validate --manifest=backup-manifest.json --current-host-id=<new-host-id>
```

Restore validation checks:

- manifest files are present and match recorded bytes and hashes
- JSONL state records are parseable and schema-versioned
- duplicate ids are rejected per store
- project/work-item ancestry is well formed and materialized work keeps plan,
  task, and action ancestry aligned
- governance-backed memory and active budget policy records still point to
  valid decision and governance event evidence
- run lifecycle records point to known runs/tasks and do not record cleanup
  before merge/push gates
- `state/host-ownership.json` is valid, unexpired, and belongs to the intended
  active host when `--current-host-id` is supplied

Host migration is a handoff drill, not an automatic service action. Stop the
old host services first, record the old host as `client_machine` or let its
ownership expire, restore/copy state to the new host, write the new
`state/host-ownership.json` as `active_automation_host`, then validate:

```bash
bun run samantha migration:validate \
  --old-host-ownership=<old-host-ownership.json> \
  --new-host-ownership=state/host-ownership.json \
  --target-host-id=<new-host-id>
```

If both ownership records are active at the same time, migration validation
blocks with an active-active host issue. Start service-manager timers on the
new host only after restore and migration validation pass.

## Host Ownership Contract

`doctor` and Telegram `/problems` read `state/host-ownership.json` before
reporting whether the current machine may run automation. The record is
host-local operational state, not a source-controlled file:

```json
{
  "schemaVersion": 1,
  "role": "active_automation_host",
  "hostId": "ubuntu-samantha",
  "updatedAt": "2026-05-10T00:00:00.000Z",
  "expiresAt": "2026-06-10T00:00:00.000Z"
}
```

Fields:

- `role`: `active_automation_host` or `client_machine`
- `hostId`: stable host id for this machine; diagnostics use
  `SAMANTHA_HOST_ID` when set, otherwise the OS hostname
- `updatedAt`: when BK or the operator last recorded this host role
- `expiresAt`: optional stale marker; when expired, diagnostics classify the
  host ownership state as `stale`

Diagnostic states:

- `active`: record says this `hostId` is the active automation host; automation
  is allowed if the other runtime diagnostics pass
- `client`: record says another host is active, or this host is explicitly a
  client machine; daemon/watch/poll/reply/dispatch/dashboard runtime should not
  run here
- `stale`: record expired; stop and refresh host ownership before running
  automation
- `unknown`: record is missing or malformed; create or repair the host-local
  ownership record before running automation

This stage adds diagnostics only. It does not start services, stop old hosts,
dispatch workers, migrate state, merge, push, cleanup, or recover.

## Watchdog Diagnostics

`doctor` and `/problems` classify host issues without changing runtime state.
Each issue has a severity, area, message, and next safe action:

- `stale`: heartbeat or host ownership evidence is too old
- `blocked`: a required runtime prerequisite or queue-processing path is
  blocked
- `degraded`: optional service-manager installation or delivery state is
  incomplete, but no destructive action should run automatically
- `needs_bk`: BK/operator attention is required, such as repeated Telegram
  reply failures
- `unsafe_to_continue`: the current machine should not run automation, or lock
  and heartbeat evidence points at dead pids

Diagnostics cover stale heartbeats, missing locks, dead pids, missing service
templates or timers for the active provider, old unprocessed inbox files,
Telegram reply failures, and missing local env prerequisites. Reports redact
known token/secret patterns from diagnostic messages.

## Linux systemd User Service

Install the template:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/samantha-inbox-watch.service ~/.config/systemd/user/
cp ops/systemd/samantha-actions-watch.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

Start and enable:

```bash
systemctl --user start samantha-inbox-watch
systemctl --user start samantha-actions-watch
systemctl --user enable samantha-inbox-watch
systemctl --user enable samantha-actions-watch
```

The service templates read `%h/projects/samantha-codex/.env`, so `SAMANTHA_REPO_ROOT`, `SAMANTHA_CODEX_BIN`, and project repo-root overrides can be set there without committing local paths.

Inspect:

```bash
systemctl --user status samantha-inbox-watch
systemctl --user status samantha-actions-watch
journalctl --user -u samantha-inbox-watch -n 100 --no-pager
journalctl --user -u samantha-actions-watch -n 100 --no-pager
bun run samantha health:check
```

Stop:

```bash
systemctl --user stop samantha-inbox-watch
systemctl --user stop samantha-actions-watch
```

If the service should run after logout, enable lingering once:

```bash
loginctl enable-linger "$USER"
```

## macOS launchd LaunchAgents

The macOS templates assume this repo is cloned at `~/projects/samantha-codex`. If it is elsewhere, set `SAMANTHA_HOME` in the copied plist command or keep a symlink at that path.

The shared runner reads `~/projects/samantha-codex/.env`, exports those values, and then runs `bun run samantha <command>`.

Install:

```bash
mkdir -p ~/Library/LaunchAgents
cp ops/launchd/com.bk.samantha.*.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.inbox-watch.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.actions-watch.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.telegram-poll.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.telegram-reply.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.ceo-notify.plist
```

Inspect:

```bash
launchctl print "gui/$(id -u)/com.bk.samantha.inbox-watch"
launchctl print "gui/$(id -u)/com.bk.samantha.actions-watch"
launchctl print "gui/$(id -u)/com.bk.samantha.telegram-poll"
launchctl print "gui/$(id -u)/com.bk.samantha.telegram-reply"
launchctl print "gui/$(id -u)/com.bk.samantha.ceo-notify"
bun run samantha health:check
bun run samantha doctor
```

Stop:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.inbox-watch.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.actions-watch.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.telegram-poll.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.telegram-reply.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.bk.samantha.ceo-notify.plist
```

Keep the macOS automation host awake while services should run. SSH and Tailscale connectivity are separate host setup steps.

## Telegram Scheduled Adapters

`telegram:poll` is a one-shot remote adapter. For 24/7 remote commands, run it through the host service manager while `inbox:watch` handles processing.

Prepare local env:

```bash
cp .env.example .env
```

Set local, uncommitted values:

```text
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<telegram-chat-id>
# Optional, required when no project profile supplies the worker repo root:
SAMANTHA_REPO_ROOT=$HOME/projects/samantha-codex
# Optional, required when the host service cannot find codex in PATH:
SAMANTHA_CODEX_BIN=$HOME/.local/bin/codex
# Optional per-profile repo root overrides:
SAMANTHA_PROJECT_OMHT_REPO_ROOT=$HOME/projects/oh-my-health-trainer
SAMANTHA_PROJECT_SAMANTHA_REPO_ROOT=$HOME/projects/samantha-codex
```

Project profile ids and source-controlled repo-root expressions remain the
portable identity. The `SAMANTHA_PROJECT_<ID>_REPO_ROOT` values are
host-local runtime resolution only and must stay in uncommitted host env.

Install and enable on Linux/WSL:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/samantha-telegram-poll.service ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-poll.timer ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-reply.service ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-reply.timer ~/.config/systemd/user/
cp ops/systemd/samantha-ceo-notify.service ~/.config/systemd/user/
cp ops/systemd/samantha-ceo-notify.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start samantha-telegram-reply.service
systemctl --user enable --now samantha-telegram-poll.timer
systemctl --user enable --now samantha-telegram-reply.timer
systemctl --user enable --now samantha-ceo-notify.timer
```

The first `samantha-telegram-reply.service` run baselines existing `outbox/remote-*.md` files without sending them. New remote outbox reports are sent after that.

`samantha-ceo-notify` is automation-host work. It runs `ceo:notify` hourly, writes a compact CEO report into `outbox/remote-*.md`, and leaves delivery to the Telegram reply adapter. Report generation is recorded in `state/ceo-reports.jsonl`; Telegram delivery, retries, and failures are recorded in `state/telegram-replies.json`.

Inspect:

```bash
systemctl --user status samantha-telegram-poll.timer
systemctl --user status samantha-telegram-reply.timer
systemctl --user status samantha-ceo-notify.timer
journalctl --user -u samantha-telegram-poll.service -n 100 --no-pager
journalctl --user -u samantha-telegram-reply.service -n 100 --no-pager
journalctl --user -u samantha-ceo-notify.service -n 100 --no-pager
bun run samantha health:check
bun run samantha doctor
```

The host service templates are tuned for interactive latency:

- `inbox:watch` polls local inbox every 1 second.
- Telegram poll restarts about 3 seconds after the prior poll exits.
- Telegram reply scans outbox about 3 seconds after the prior reply pass exits.
- CEO notification generation runs hourly.

Normal reply latency should usually be a few seconds. It can be longer when Telegram network calls are slow or when the machine is sleeping.

For routine operation, use Telegram `/now` first. It reports the next command to send, usually `/plan`, `/plan_current`, `/answer <answer>`, `/go`, `/revise <feedback>`, `/cancel`, `/recover`, `/problems`, or `/check`. Use `/check` for compact status and `/problems` when `/check` or `/now` reports warnings or failures.

## Safety Notes

- Do not run multiple watchers manually; the lock should block duplicates, but one service instance is the intended shape.
- Keep remote adapters write-only into `inbox/`.
- Keep merge, push, and worktree cleanup as explicit gated Samantha commands.
- Client machines may edit, test, commit, and push normal repo code. Do not run Samantha daemon, watch, poll, reply, worker dispatch, dashboard runtime, systemd timers, or launchd agents from a client machine.
- The active automation host owns `state/`, `runs/`, `.samantha-worktrees/`, dashboard runtime output, and final automation verification.
- Host-only verification commands are run on the active automation host: `bun run test:host`, `bun run verify:host`, and `bun run test:all`.
