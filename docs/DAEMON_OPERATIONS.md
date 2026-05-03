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

Run full local diagnostics:

```bash
bun run samantha doctor
```

Build dashboard with daemon status:

```bash
bun run samantha dashboard:build
```

## Runtime Files

- `state/daemon.lock`: prevents duplicate `inbox:watch` processes
- `state/heartbeat.json`: last daemon heartbeat
- `state/proposals.jsonl`: remote work proposals and review state
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

## Telegram Timer

`telegram:poll` is a one-shot remote adapter. For 24/7 remote commands, run it through the included user timer while `inbox:watch` handles processing.

Prepare local env:

```bash
cp .env.example .env
```

Set local, uncommitted values:

```text
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<telegram-chat-id>
```

Install and enable:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/samantha-telegram-poll.service ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-poll.timer ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-reply.service ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-reply.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start samantha-telegram-reply.service
systemctl --user enable --now samantha-telegram-poll.timer
systemctl --user enable --now samantha-telegram-reply.timer
```

The first `samantha-telegram-reply.service` run baselines existing `outbox/remote-*.md` files without sending them. New remote outbox reports are sent after that.

Inspect:

```bash
systemctl --user status samantha-telegram-poll.timer
systemctl --user status samantha-telegram-reply.timer
journalctl --user -u samantha-telegram-poll.service -n 100 --no-pager
journalctl --user -u samantha-telegram-reply.service -n 100 --no-pager
bun run samantha doctor
```

The service templates are tuned for interactive latency:

- `inbox:watch` polls local inbox every 1 second.
- `samantha-telegram-poll.timer` restarts polling 3 seconds after the prior poll exits.
- `samantha-telegram-reply.timer` scans outbox 3 seconds after the prior reply pass exits.

Normal reply latency should usually be a few seconds. It can be longer when Telegram network calls are slow or when the machine is sleeping.

## Safety Notes

- Do not run multiple watchers manually; the lock should block duplicates, but one service instance is the intended shape.
- Keep remote adapters write-only into `inbox/`.
- Keep merge, push, and worktree cleanup as explicit gated Samantha commands.
