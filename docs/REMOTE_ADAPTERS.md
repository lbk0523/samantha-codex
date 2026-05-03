# Samantha Remote Adapters

Last updated: 2026-05-03

## Policy

Remote adapters are input adapters only. They may create inbox command files, but they may not execute shell commands, dispatch workers directly, merge, push, or clean worktrees.

All remote input must pass through:

```text
remote input -> allowlist -> command mapping -> inbox/*.json -> inbox:watch
```

## Supported Commands

The current remote command mapper supports only:

- `/runs`
- `/tasks`
- `/dashboard`
- `/task <task-id>`

Unsupported commands are ignored or rejected.

## Telegram Poll Adapter

`telegram:poll` performs one Telegram `getUpdates` poll and writes allowed commands into `inbox/`.

Required:

- `TELEGRAM_BOT_TOKEN` or `--bot-token=<token>`
- `TELEGRAM_ALLOWED_SENDER_ID`, `TELEGRAM_CHAT_ID`, or `--allowed-sender-id=<id>`

`TELEGRAM_CHAT_ID` is supported for compatibility with the older Claude-side Samantha Telegram environment.
`telegram:poll` authorizes by Telegram `chat.id` first, then falls back to `from.id`.

Example:

```bash
TELEGRAM_BOT_TOKEN=<token> \
TELEGRAM_CHAT_ID=<telegram-chat-id> \
bun run samantha telegram:poll --timeout-seconds=0
```

Local env file:

```bash
cp .env.example .env
```

Then fill only local, uncommitted values:

```text
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<telegram-chat-id>
```

Offset state is stored in:

```text
state/telegram-offset.json
```

Use with the daemon:

```bash
bun run samantha inbox:watch
```

Then run `telegram:poll` periodically from a separate timer or service. The adapter only writes to `inbox/`; `inbox:watch` remains responsible for processing.

systemd user timer templates are included:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/samantha-telegram-poll.service ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-poll.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now samantha-telegram-poll.timer
```

The timer reads `%h/projects/samantha-codex/.env`. If the older Claude-side Samantha environment file exists elsewhere, either copy only the two Telegram values into this repo's ignored `.env` or adjust the copied service's `EnvironmentFile=` path locally.

## Safety

- Sender allowlist is mandatory.
- Bot tokens should be supplied via environment variables or local service environment, not committed files.
- Merge, push, and cleanup commands remain explicit local Samantha commands.
