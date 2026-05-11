# Local And SSH Host Candidates

Last updated: 2026-05-11

Status: implemented for ownership helpers and local-only diagnostics. Handoff
remains manual and single-active-host only.

## Decision

Samantha should support both the local Mac and a separate SSH-accessible
environment as automation host candidates, but exactly one candidate may be the
active automation host at a time.

This is a host handoff model, not an active-active distributed system.

## Assumptions

- The local Mac and SSH environment may both have the repository, Bun, Codex
  CLI, git credentials, project profile overrides, and service-manager
  templates installed.
- Only the active host runs Samantha daemon, watch, poll, reply, worker
  dispatch, dashboard runtime, merge, push, cleanup, or host-owned verification
  processes.
- Inactive candidates are client machines. They may edit, test, commit, and
  push normal repository code, but must not own runtime state.
- Host-owned runtime files remain local to the active host until an explicit
  handoff copies or restores them: `state/`, `runs/`, `.samantha-worktrees/`,
  `inbox/`, `outbox/`, `archive/`, dashboard runtime output, and live logs.
- Source-controlled code and docs must not hard-code machine-specific absolute
  paths. Use repo-relative paths, project ids, `$HOME`, `SAMANTHA_HOST_ID`,
  `SAMANTHA_REPO_ROOT`, or `SAMANTHA_PROJECT_<ID>_REPO_ROOT`.

## Non-Scope

- No active-active host operation.
- No distributed lock, central database, central task queue, or replicated
  state service.
- No concurrent Telegram polling/replying from multiple hosts.
- No concurrent worker dispatch, merge, push, cleanup, dashboard runtime, or
  daemon loops from multiple hosts.
- No writer-cap increase.

## Why This Does Not Require A Large Rewrite

The current implementation already models a single active automation host:

- `doctor` reads `state/host-ownership.json` and classifies the current machine
  as active, client, stale, or unknown.
- Runtime locks and heartbeats are host-local. They protect one machine, not a
  fleet.
- `inbox:watch`, `actions:watch`, `telegram:poll`, `telegram:reply`,
  `ceo:notify`, `dashboard:serve`, dispatch, merge, push, and cleanup are
  already local operator commands.
- macOS launchd and Linux/WSL systemd templates both exist.
- Project profile repo roots can be resolved from host-local environment
  overrides without changing project identity.

The missing work is operational polish: host candidate setup, ownership
claiming, handoff documentation, diagnostics that reduce setup noise, and
repeatable drills.

## Implementation Plan

### 1. Inventory Host Candidates

Record for each candidate:

- stable host id
- repository location
- Bun command path
- Codex CLI command path
- git authentication state
- Telegram environment availability
- project profile repo-root overrides
- service manager provider: launchd or systemd

Verification:

- Repository checks pass on each candidate with the appropriate profile:
  `bun run verify:mac` for local Mac-side verification, and host verification
  only on the active automation host.
- `bun run samantha doctor --json` reports clear missing prerequisites instead
  of ambiguous failures.

### 2. Standardize Host-Local Environment

Each host candidate should have an ignored `.env` or equivalent service-manager
environment file with host-local values:

```text
SAMANTHA_HOST_ID=<stable-host-id>
SAMANTHA_REPO_ROOT=$HOME/projects/samantha-codex
SAMANTHA_CODEX_BIN=<codex-command-or-path>
SAMANTHA_PROJECT_SAMANTHA_REPO_ROOT=$HOME/projects/samantha-codex
SAMANTHA_PROJECT_<ID>_REPO_ROOT=<project-repo-root>
TELEGRAM_BOT_TOKEN=<token-when-this-host-is-active>
TELEGRAM_CHAT_ID=<chat-id-when-this-host-is-active>
```

Verification:

- `doctor` sees the expected host id.
- Codex is executable from the same environment used by the service manager.
- Project profile overrides resolve to the intended local repos.

### 3. Make Host Ownership Explicit

The active host has `state/host-ownership.json` like:

```json
{
  "schemaVersion": 1,
  "role": "active_automation_host",
  "hostId": "<stable-host-id>",
  "updatedAt": "<iso-timestamp>",
  "expiresAt": "<optional-iso-timestamp>"
}
```

Inactive candidates should either have:

```json
{
  "schemaVersion": 1,
  "role": "client_machine",
  "hostId": "<stable-host-id>",
  "updatedAt": "<iso-timestamp>"
}
```

or no runtime state at all.

Verification:

- Active host: `doctor` reports `automationAllowed: true` after the daemon is
  running and required env exists.
- Inactive host: `doctor` reports client, stale, or unknown and does not appear
  safe for automation.

Use the ownership helpers instead of hand-editing JSON:

```bash
bun run samantha host:claim --host-id=<host-id>
bun run samantha host:client --host-id=<host-id>
```

`host:claim` accepts `--expires-at=<iso-timestamp>`. Both helpers default to
`state/host-ownership.json` and honor `--state-dir=<dir>` or
`--host-ownership-path=<path>`. They only write the ownership record.

### 4. Configure The Local Mac As A Candidate

Start manually before installing launchd:

```bash
bun run samantha inbox:watch
SAMANTHA_REPO_ROOT=$HOME/projects/samantha-codex bun run samantha actions:watch
bun run samantha dashboard:build
```

Then install launchd only after manual checks are clean.

Verification:

- `bun run samantha health:check` sees a live heartbeat and lock while
  `inbox:watch` is running.
- `bun run samantha doctor` reports no unsafe host ownership issue on the
  active Mac.
- A simple inbox command is processed once and archived once.
- Dashboard HTML builds from local state.

### 5. Configure The SSH Environment As A Candidate

Prepare the SSH environment without making it active first:

- clone or update the repository
- install dependencies
- configure host-local `.env`
- install or stage systemd user templates
- keep host ownership as client until handoff

Verification:

- Repository verification passes.
- `doctor` identifies it as a client or inactive candidate until ownership is
  claimed.
- Service templates point at the intended repo and env paths for that host.

### 6. Run Handoff Drills

Mac to SSH:

1. Stop Mac launchd/manual Samantha runtime processes.
2. Confirm Mac `health:check` no longer reports a live watcher.
3. Copy or restore required host-owned runtime state to the SSH environment.
4. Mark Mac as client or let ownership expire.
5. Mark SSH as `active_automation_host`.
6. Run restore and migration validation where manifests are available.
7. Start SSH service-manager processes.
8. Run `doctor`, process one safe inbox command, and build the dashboard.

SSH to Mac uses the same sequence in reverse.

Verification:

- `restore:validate` and `migration:validate` pass when manifests and old/new
  ownership records are available.
- Only the new active host reports automation allowed.
- No Telegram message, inbox command, action, dispatch, merge, push, or cleanup
  runs twice during the drill.

### 7. Add Small Operator Improvements

Implemented operator improvements:

- `host:claim` and `host:client` write valid host ownership records without
  manual JSON editing.
- `doctor --local-only` suppresses Telegram-required failures when BK wants
  local CLI/dashboard use without Telegram.
- Document Mac/SSH candidate setup and handoff in `DAEMON_OPERATIONS.md`.
- Keep all runtime authority unchanged.

Verification:

- Focused tests cover host ownership helper output and local-only diagnostics.
- `bun run verify:docs` passes.
- `bun run verify:mac` passes after code changes.
- Active-host verification runs only when host-owned runtime behavior changes
  on the active host.

## Copyable Implementation Prompt

Use this prompt in a fresh Codex session:

```text
We are in the samantha-codex repo. Implement the agreed Mac/SSH host-candidate
handoff plan from docs/LOCAL_AND_SSH_HOST_CANDIDATES.md.

Goal:
- Support a local Mac and a separate SSH environment as automation host
  candidates.
- Preserve the current safety model: exactly one active automation host at a
  time. Do not implement active-active behavior.

Scope:
1. Add minimal CLI helpers for host ownership records:
   - `host:claim --host-id=<id> [--expires-at=<iso>]`
   - `host:client --host-id=<id>`
   - Use `state/host-ownership.json` by default and existing `--state-dir` /
     `--host-ownership-path` conventions where practical.
   - The helpers should write only the ownership record and should not start,
     stop, migrate, dispatch, merge, push, cleanup, or recover anything.
2. Add a local-only diagnostics mode if it fits the existing design:
   - `doctor --local-only` should suppress Telegram-required failures when the
     operator only wants CLI/dashboard local use.
   - It must still report unsafe host ownership, daemon health, stuck inbox,
     missing Codex, and service/runtime issues that matter locally.
3. Update docs:
   - Link the new workflow from `docs/DAEMON_OPERATIONS.md`.
   - Keep README/readme links coherent.
   - Do not hard-code local absolute paths.
4. Add focused tests for the new CLI/diagnostic behavior.

Constraints:
- Do not create distributed locks, central state, central queues, or
  active-active behavior.
- Do not change writerCap.
- Do not run Samantha daemon/watch/poll/reply/dispatch/dashboard runtime from a
  client machine.
- Do not modify host-owned runtime state except in isolated test temp dirs or
  through the explicit host ownership helper being implemented.
- Keep changes surgical and match existing code style.

Verification:
- Run `bun run verify:docs`.
- Run `bun run verify:mac`.
- If host-owned runtime behavior changes, clearly state what still requires
  active-host verification.
```
