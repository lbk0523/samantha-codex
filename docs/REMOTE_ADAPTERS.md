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
- `/draft-propose <text>`
- `/proposals`
- `/proposal <proposal-id>`
- `/accept <proposal-id>`
- `/reject <proposal-id>`
- `/draft <proposal-id>`
- `/drafts`
- `/draft <draft-id>`
- `/tasks`
- `/next-action`
- `/dashboard`
- `/task <task-id>`

Unsupported commands are ignored or rejected.

Supported remote commands are operational reports, a safe dashboard rebuild, proposal intake/review, and conservative task draft creation. `/propose` may write a pending proposal to `state/proposals.jsonl`; `/draft-propose` may write an accepted proposal plus a draft; `/accept` and `/reject` may update proposal review state; `/draft <proposal-id>` may write a draft to `state/task-drafts.jsonl`. Worker dispatch, task ledger promotion, merge, push, cleanup, and arbitrary shell execution are intentionally not exposed remotely.

`/status` is the quick operational view. It includes daemon heartbeat, queue counts, proposal counts, draft counts, latest run, Telegram offset, reply state, and unsent remote outbox count.

`/doctor` is the deeper diagnostic view. It checks local env readiness, daemon health, queue state, Telegram poll/reply state, and expected systemd template installation without printing secret values.

Proposal commands are intake/review only:

- `/propose <text>` writes a pending proposal to `state/proposals.jsonl`
- `/draft-propose <text>` writes an accepted proposal to `state/proposals.jsonl` and a draft to `state/task-drafts.jsonl`
- `/proposals` lists recent proposals
- `/proposal <proposal-id>` shows one proposal
- `/accept <proposal-id>` marks one proposal accepted
- `/reject <proposal-id>` marks one proposal rejected

No proposal command dispatches workers or creates commits. Accepted proposals must still be converted into explicit tasks before execution.

Task draft commands are draft-only:

- `/draft <proposal-id>` creates one draft from an accepted proposal
- `/draft-propose <text>` creates an accepted proposal and one draft in a single command
- `/drafts` lists recent task drafts
- `/draft <draft-id>` shows one task draft

Drafts use conservative defaults and empty `targetFiles` / `verifyCommands`. Draft creation does not add to `state/tasks.jsonl`, dispatch workers, or create commits.

Task promotion is local-only:

```bash
bun run samantha drafts:check <draft-id>
bun run samantha drafts:update <draft-id> --from=<draft-patch.json>
bun run samantha drafts:prepare <draft-id> --project=<id> [--from=<draft-patch.json>]
bun run samantha drafts:approve <draft-id>
```

`drafts:approve` refuses drafts without `targetFiles`, `verifyCommands`, `instructions`, and a known `targetAgent`. Approval writes one pending task to `state/tasks.jsonl` and marks the draft approved, but still does not dispatch a worker.

Draft patches may include `setupCommands`. Use this for fresh worktree dependencies, for example:

```json
{
  "setupCommands": ["bun install"],
  "verifyCommands": ["bun typecheck"]
}
```

Project profiles can provide these defaults. The first bundled profile is `omht`, which supplies the local OMHT repo root, `bun install`, and a conservative default typecheck command. Use `drafts:prepare` when converting a rough draft into an executable task draft for a known project.

Worker dispatch is local-only:

```bash
bun run samantha tasks:dispatch <task-id> --repo-root=<repo>
bun run samantha tasks:dispatch <task-id> --repo-root=<repo> --execute
```

Without `--execute`, `tasks:dispatch` only prepares and prints the Codex command. With `--execute`, it writes a run log under `runs/`, appends `state/runs.jsonl`, and updates the task to `completed` or `failed`. Remote adapters cannot call this command.

Merge/push/cleanup lifecycle is recorded locally in `state/run-lifecycle.jsonl`. Use the run log when pushing so Samantha can verify the run commit is integrated and stop recommending already-completed work:

```bash
bun run samantha merge:push --repo-root=<repo> --run-log=<run-log.json>
```

For older runs that were merged/pushed/cleaned before lifecycle recording existed, backfill explicitly:

```bash
bun run samantha runs:mark-lifecycle --run-log=<run-log.json> --repo-root=<repo> --merged --pushed --cleaned
```

If a worker run fails for a recoverable reason, keep the recovery local:

```bash
bun run samantha tasks:retry <task-id>
bun run samantha tasks:finalize-worktree <task-id> --repo-root=<repo> --worktree=<worker-worktree>
```

Use `tasks:retry` only after understanding the failed run. Use `tasks:finalize-worktree` only after fixing/verifying the existing worker worktree locally.

Stale or obsolete tasks should be archived locally:

```bash
bun run samantha tasks:archive <task-id> --reason=<text>
```

Archived tasks remain in `state/tasks.jsonl`, but `/tasks`, `tasks:list`, and `/next-action` exclude them by default. Use `tasks:list --include-archived` for audit/debugging.

`/next-action` is read-only. It reports the safest next local command, such as dispatching a pending task, checking/applying a merge candidate, retrying a failed task, finalizing a blocked worktree, or cleaning up after merge/push.

After a successful merge and push, clean the worker worktree locally:

```bash
bun run samantha worktree:cleanup --run-log=<run-log.json> --repo-root=<repo>
```

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

Reports that return proposal, draft, run, or task IDs also send each detected ID as its own follow-up message. This keeps iPhone Telegram copy/paste practical; status values, timestamps, and paths are not sent as copy-only messages.

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
