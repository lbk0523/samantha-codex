# Samantha Hosting Handoff Pending

Last updated: 2026-05-11

## Purpose

This document records the paused work needed to continue Samantha hosting setup
later without relying on chat history.

The immediate goal is to make this Mac a valid Samantha automation host only
after the previous active host is stopped or explicitly abandoned.

## Current State

- Local repo: `/Users/byung/Documents/samantha-codex`
- Local Mac host id detected by `doctor`: `ibyeong-gwan-ui-noteubug-2.local`
- Local host ownership: `unknown`
- Local automation allowed: `false`
- Local `state/host-ownership.json`: missing
- Local `.env`: missing
- Local launchd templates: not installed
- Local daemon heartbeat: missing
- Local daemon lock: missing
- Tailscale candidate seen: `samantha-wsl`
- `samantha-wsl` status during check: offline, last seen 1 day ago
- SSH check to `samantha-wsl`: timed out

The local Mac has not been claimed as the active automation host.

## Why The Work Is Paused

Samantha allows exactly one active automation host at a time. Claiming this Mac
without either stopping the old host or explicitly abandoning the old host state
could create an active-active operational risk.

Do not run `host:claim`, daemon, watch, poll, reply, worker dispatch, dashboard
runtime, or launchd services on this Mac until the handoff path is chosen.

## Resume Decision

Choose one path before continuing.

### Path A: Handoff From Existing Host

Use this when the previous runtime state should be preserved.

Requirements before continuing:

- Bring `samantha-wsl` or the actual previous host online.
- Confirm SSH access from this Mac.
- Stop Samantha runtime processes on the previous host.
- Mark the previous host as `client_machine`.
- Preserve the previous host ownership record as migration evidence.
- Copy or restore required runtime state to this Mac.

Then continue with:

```bash
bun run samantha restore:validate --manifest=<backup-manifest.json> --current-host-id=<new-host-id>
bun run samantha host:claim --host-id=<new-host-id>
bun run samantha migration:validate \
  --old-host-ownership=<old-host-ownership.json> \
  --new-host-ownership=state/host-ownership.json \
  --target-host-id=<new-host-id>
bun run samantha doctor
```

### Path B: Fresh Mac Bootstrap

Use this only when the previous host is confirmed stopped and the previous
runtime state can be intentionally discarded.

Requirements before continuing:

- Explicitly confirm the old host is stopped or no longer authoritative.
- Create the Mac host-local `.env`.
- Set `SAMANTHA_HOST_ID` to a stable value.
- Configure Telegram and Codex environment values.
- Claim this Mac as active.
- Install launchd templates only after manual checks pass.

Then continue with:

```bash
bun run samantha host:claim --host-id=<new-host-id>
bun run samantha doctor --local-only
bun run samantha doctor
```

After `doctor` is clean, start manual runtime checks before installing launchd.

## Commands Already Run

```bash
bun run samantha doctor --local-only --json
tailscale status
ssh -o BatchMode=yes -o ConnectTimeout=5 samantha-wsl hostname
```

Observed result:

- `doctor --local-only --json` failed because ownership, `.env`, heartbeat,
  daemon lock, and launchd templates are missing.
- `tailscale status` showed `samantha-wsl` as offline.
- SSH to `samantha-wsl` timed out.

## Success Criteria

The hosting handoff is complete only when all of these are true:

- Exactly one host has `role: active_automation_host`.
- The previous host is stopped, expired, or explicitly marked
  `client_machine`.
- The new host owns `state/host-ownership.json`.
- `bun run samantha doctor` reports automation allowed on the new host.
- The old host does not run daemon/watch/poll/reply/dispatch/dashboard runtime
  processes.
- One safe inbox command can be processed exactly once.
- Dashboard output can be built from the new host state.

## Follow-Up Skill

After one real handoff succeeds, create a Codex skill for this workflow. The
skill should encode the guardrail that `host:claim` is never run until the old
host is stopped or explicitly abandoned.
