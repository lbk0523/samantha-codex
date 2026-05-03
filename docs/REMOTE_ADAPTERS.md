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

Example:

```bash
TELEGRAM_BOT_TOKEN=<token> \
TELEGRAM_CHAT_ID=<telegram-chat-id> \
bun run samantha telegram:poll --timeout-seconds=0
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

## Safety

- Sender allowlist is mandatory.
- Bot tokens should be supplied via environment variables or local service environment, not committed files.
- Merge, push, and cleanup commands remain explicit local Samantha commands.
