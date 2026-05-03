# Samantha Daemon Operations

Last updated: 2026-05-03

## Purpose

`inbox:watch` is the local 24/7 loop. It watches `inbox/*.json`, writes reports to `outbox/*.md`, archives processed commands, and updates daemon state.

## Local Commands

Start manually:

```bash
bun run samantha inbox:watch
```

Check health:

```bash
bun run samantha health:check
```

Build dashboard with daemon status:

```bash
bun run samantha dashboard:build
```

## Runtime Files

- `state/daemon.lock`: prevents duplicate `inbox:watch` processes
- `state/heartbeat.json`: last daemon heartbeat
- `inbox/*.json`: queued local commands
- `outbox/*.md`: command reports
- `archive/inbox/*.json`: processed input commands

Bad inbox commands are archived and get an outbox failure report instead of crashing the watcher.

## systemd User Service

Install the template:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/samantha-inbox-watch.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

Start and enable:

```bash
systemctl --user start samantha-inbox-watch
systemctl --user enable samantha-inbox-watch
```

Inspect:

```bash
systemctl --user status samantha-inbox-watch
journalctl --user -u samantha-inbox-watch -n 100 --no-pager
bun run samantha health:check
```

Stop:

```bash
systemctl --user stop samantha-inbox-watch
```

If the service should run after logout, enable lingering once:

```bash
loginctl enable-linger "$USER"
```

## Safety Notes

- Do not run multiple watchers manually; the lock should block duplicates, but one service instance is the intended shape.
- Keep remote adapters write-only into `inbox/`.
- Keep merge, push, and worktree cleanup as explicit gated Samantha commands.
