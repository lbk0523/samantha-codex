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

- `/help`
- `/status`
- `/doctor`
- `/health`
- `/runs`
- `/run <run-id>`
- `/failures`
- `/propose <text>`
- `/proposals`
- `/proposal <proposal-id>`
- `/tasks`
- `/dashboard`
- `/task <task-id>`

Unsupported commands are ignored or rejected.

Supported remote commands are operational reports, a safe dashboard rebuild, and proposal intake. `/propose` may write a pending proposal to `state/proposals.jsonl`; worker dispatch, merge, push, cleanup, and arbitrary shell execution are intentionally not exposed remotely.

`/status` is the quick operational view. It includes daemon heartbeat, queue counts, latest run, Telegram offset, reply state, and unsent remote outbox count.

`/doctor` is the deeper diagnostic view. It checks local env readiness, daemon health, queue state, Telegram poll/reply state, and expected systemd template installation without printing secret values.

Proposal commands are intake only:

- `/propose <text>` writes a pending proposal to `state/proposals.jsonl`
- `/proposals` lists recent proposals
- `/proposal <proposal-id>` shows one proposal

No proposal command dispatches workers or creates commits. A proposal must still be reviewed and converted into an explicit task before execution.

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

## Telegram Reply Adapter

`telegram:reply` performs one outbound pass over remote outbox reports and sends unsent reports to Telegram with `sendMessage`.

Required:

- `TELEGRAM_BOT_TOKEN` or `--bot-token=<token>`
- `TELEGRAM_REPLY_CHAT_ID`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_SENDER_ID`, or `--chat-id=<id>`

The adapter only reads `outbox/remote-*.md` by default. It does not execute commands, dispatch workers, merge, push, or clean worktrees.

Long outbox reports are split into multiple Telegram messages instead of truncated.

Sent state is stored in:

```text
state/telegram-replies.json
```

Safe first-run behavior:

- If `state/telegram-replies.json` does not exist, existing `outbox/remote-*.md` files are marked as already sent and no Telegram message is sent.
- Use `--send-existing` only if you intentionally want to send existing historical remote outbox files.
- Use `--mark-existing` to explicitly baseline current remote outbox files before enabling the timer.
- Failed sends are not marked sent. Failure attempts, last errors, and split-message progress are stored in `state/telegram-replies.json`, and the next timer pass retries from the next unconfirmed message.

systemd user timer templates are included:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/samantha-telegram-poll.service ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-poll.timer ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-reply.service ~/.config/systemd/user/
cp ops/systemd/samantha-telegram-reply.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now samantha-telegram-poll.timer
systemctl --user enable --now samantha-telegram-reply.timer
```

The timer reads `%h/projects/samantha-codex/.env`. If the older Claude-side Samantha environment file exists elsewhere, either copy only the two Telegram values into this repo's ignored `.env` or adjust the copied service's `EnvironmentFile=` path locally.

The timer templates favor interactive replies:

- poll restarts 3 seconds after the prior `telegram:poll` exits
- reply restarts 3 seconds after the prior `telegram:reply` exits
- local inbox processing runs every 1 second in the service template

## Safety

- Sender allowlist is mandatory.
- Bot tokens should be supplied via environment variables or local service environment, not committed files.
- Merge, push, and cleanup commands remain explicit local Samantha commands.
