# Samantha Remote Adapters

Last updated: 2026-05-07

## Policy

Remote adapters are input adapters first. They may create inbox command files for the narrow supported control-plane transitions. A separate local action runner executes approved actions. Remote adapters may not execute shell commands, dispatch workers directly, merge, push, clean worktrees, or accept internal ids as the normal workflow.

Telegram is not Samantha's core product surface. It is a notification, approval, short-feedback, and compact status adapter for the deterministic CEO office. Long review, dashboard inspection, and operational debugging should stay in CLI or dashboard surfaces.

All remote input must pass through:

```text
remote input -> allowlist -> command mapping -> inbox/*.json -> inbox:watch
```

## Practical Telegram Flow

Use this as the existing Telegram adapter path:

```text
/work <request> -> /plan -> /go -> /now
wrong plan -> /revise <feedback> -> /plan -> /go
failed plan result -> /recover -> /plan -> /go
```

- `/now` shows the next Telegram command, local command, or read-only inspection command for the current state.
- `/work <request>` captures new work as an orchestration request; it does not create a task or dispatch a worker.
- `/plan` runs the local Codex CLI `codex-orchestrator` profile in read-only mode and returns the generated plan.
- `/plan_current` shows the current unapproved plan again without rerunning the orchestrator.
- `/go` validates the orchestrator plan, creates task records, and approves dispatch actions. It does not execute workers inside `inbox:watch`.
- `/revise <feedback>` supersedes the current unapproved plan and creates a new planning request with the feedback.
- `/cancel` discards the current pending planning request or unapproved plan. It cannot stop workers or cancel actions.
- `/recover` turns the latest failed materialized plan result into a new orchestration request. It does not retry or dispatch by itself.
- `/check` is the compact status view.
- `/problems` is the diagnostic view.

`/help` shows only this short flow. Lower-level inspection and explicit id-based commands are not exposed as Telegram commands. Deprecated Telegram commands return a short replacement hint instead of running the old flow.

## Supported Commands

The current Telegram adapter spellings are:

- `/help`
- `/start`
- `/now`
- `/work <text>`
- `/plan [project_id] [scope_id]`
- `/plan_current`
- `/go`
- `/revise <feedback>`
- `/cancel [reason]`
- `/recover`
- `/check`
- `/problems`

Unsupported commands are ignored or rejected.

Supported Telegram commands are operational reports plus orchestration request intake/planning/revision/materialization/recovery. `/work` writes an orchestration request to `state/orchestration-requests.jsonl`; `/plan` writes an orchestrator plan to `state/orchestrator-plans.jsonl`; `/plan_current` reads the latest `planned` or `questions` plan without creating a new plan; `/revise <feedback>` marks the current unapproved plan `superseded` and writes a new pending orchestration request containing the previous plan plus feedback; `/go` validates that plan, writes tasks to `state/tasks.jsonl`, approves dispatch actions in `state/remote-actions.jsonl`, or advances the latest passed committed run through merge, push, and cleanup gates using stored run metadata; `/recover` writes a new recovery-oriented orchestration request from the latest failed materialized plan result. Direct worker dispatch, arbitrary shell execution, arbitrary repo paths, arbitrary merge/push/cleanup paths, run/task/action/proposal/draft id entry, and worker execution inside inbox processing are intentionally not exposed remotely.

`/now` is the default operating command. It chooses one next remote command from current action state, orchestrator plans, orchestration requests, failed plan recovery state, diagnostics, pending tasks, and latest run state. After `/work <request>`, `/now` should show the pending orchestration request and `/plan` instead of reporting no immediate action. When a plan is waiting for approval, reports show `/plan_current`, `/go`, and `/revise <feedback>` so BK can reread, approve, or redirect without starting over. After a failed materialized plan result is reported and no newer active item exists, `/now` should show `/recover`. It must not present inspect-only commands or id-based commands as the next action.

`/check` is the quick operational view. It includes daemon heartbeat, queue counts, proposal counts, draft counts, latest run, latest run lifecycle, Telegram offset, reply state, latest remote command/report, and unsent remote outbox count.

`/problems` is the deeper diagnostic view. It checks local env readiness, daemon health, queue state, Telegram poll/reply state, latest remote command/report context, reply failures, and expected systemd template installation without printing secret values.

Proposal and task draft records still exist as local fallback state, but they are not part of the normal Telegram command surface. Old proposal/draft Telegram commands return deprecated-command guidance and point back to `/work`, `/plan`, `/go`, or `/now`.

Local draft commands remain available for precise patch edits and debugging:

```bash
bun run samantha drafts:check <draft-id>
bun run samantha drafts:template <draft-id> [--project=<id>]
bun run samantha drafts:update <draft-id> --from=<draft-patch.json>
bun run samantha drafts:prepare <draft-id> --project=<id> [--from=<draft-patch.json>]
bun run samantha drafts:approve <draft-id>
```

`drafts:check` returns a readiness summary with missing fields and next commands. `drafts:template` prints an editable JSON patch, optionally filled with project defaults. `drafts:update` rejects unknown patch fields instead of silently ignoring them. `drafts:approve` and `/go` refuse drafts without `targetFiles`, `verifyCommands`, `instructions`, and a known `targetAgent`. Approval writes one pending task to `state/tasks.jsonl` and marks the draft approved, but still does not dispatch a worker inside inbox processing.

Draft/proposal target-file preparation is now local fallback only. Telegram users should submit the actual work request with `/work <request>` and let `/plan` choose the project, scope, files, and verification plan.

Telegram reports use a consistent next-action shape:

- `Telegram` is the command to send next when remote progress can continue.
- `Local` is a local shell command that must be run before Telegram can continue safely.
- Routine inspection should go through `/now`, `/check`, `/problems`, or the read-only dashboard rather than id-based Telegram commands.

Draft patches may include `setupCommands`. Use this for fresh worktree dependencies, for example:

```json
{
  "setupCommands": ["bun install"],
  "verifyCommands": ["bun typecheck"]
}
```

Project profiles can provide these defaults plus remote scope recipes. The first bundled profile is `omht`, which supplies the local OMHT repo root, `bun install`, a conservative default typecheck command, and remote scopes for implementation and planning/report work. Korean planning/report requests such as `계획`, `보고`, `검토`, and `다음 작업` are routed to the planning/report scope. Use `/plan` for normal Telegram operation and `drafts:prepare` when converting a rough draft into an executable task draft locally.

Remote scopes may set `resultMode` to `write` or `report`. `write` remains the default implementation mode and still fails if a writer returns `pass` without changed files. `report` is for planning or read-only dogfood requests: if the worker returns a valid passing HARNESS_RESULT and changes no files, Samantha records the run as successful without requiring a commit.

Direct worker dispatch is local-only:

```bash
bun run samantha tasks:dispatch <task-id> --repo-root=<repo>
bun run samantha tasks:dispatch <task-id> --repo-root=<repo> --execute
bun run samantha tasks:dispatch <task-id> --repo-root=<repo> --execute --tmux
```

Without `--execute`, `tasks:dispatch` only prepares and prints the Codex command. With `--execute`, it writes a run log under `runs/`, appends `state/runs.jsonl`, and updates the task to `completed` or `failed`.

Remote dispatch uses an action gate plus a separate runner instead of direct command execution:

```text
/go -> state/tasks.jsonl pending tasks + state/remote-actions.jsonl approved actions
actions:watch -> tasks:dispatch <task-id> --allocate --execute --tmux
```

`/go` first checks for an active orchestrator plan. If the plan is ready, it validates all proposed tasks, writes task records, writes dispatch actions, marks dependency-free actions approved, leaves dependent actions waiting, and marks the plan materialized. If the plan has questions or unsafe fields, it returns a block report and does not create tasks or actions. If a request is still waiting for a plan, `/go` returns the same next-step guidance as `/now`. If no orchestration state exists, `/go` may advance Samantha's fixed integration gates for the latest passed run; otherwise it reports that there is no actionable plan instead of approving stale task/action/draft state. No worker is started inside `inbox:watch`.

Dependent plan actions use `waiting` status with explicit `dependsOnActionIds`. `actions:watch` promotes a waiting action only after every dependency action completed successfully. If a dependency fails or disappears, the dependent action is marked failed without running a worker.

When all actions belonging to one materialized orchestrator plan finish, `actions:watch` reruns `codex-orchestrator` in synthesis mode and writes one additional `# plan-result` Telegram outbox report. The plan-level report is compact: outcome first, then worker notes, changed files or report artifacts, remaining risk, and one next safe Telegram command. Local merge-check candidates remain local fallback detail rather than the routine Telegram path. If synthesis fails, Samantha still writes a deterministic fallback report and records the synthesis failure on the plan.

Lower-level action preparation and explicit action approval remain available through local CLI/inbox commands for debugging, but they are no longer Telegram commands. Telegram should use `/go` to advance the current safe gate.

`actions:watch` or one-shot `actions:run-pending` executes only existing approved action ids. Telegram cannot supply shell commands, extra flags, arbitrary repo paths, or arbitrary integration instructions. After a passed run, `/go` may advance Samantha's fixed merge, push, and cleanup gates for the latest recorded run only. Drafts prepared with a project profile carry that profile's `repoRoot` into the promoted task and dispatch action; otherwise the repo root must be configured locally through `SAMANTHA_REPO_ROOT`. If neither is set, action preparation fails with an explicit report. If systemd cannot find Codex, set `SAMANTHA_CODEX_BIN` in `.env`.

Use `--tmux` for a read-only supervisor view while the worker runs. Samantha still owns the worker process, safety gates, merge, and push; tmux only tails `runs/live/<run-id>.jsonl` through a formatter. Attach with:

```bash
tmux attach -t samantha
```

If tmux is unavailable, dispatch continues and the JSON result includes a warning. Use `--live-log` without `--tmux` to write the live JSONL stream without opening a tmux observer. When `--tmux` is used, Samantha opens an observer window while the worker is active and closes that observer window after the worker finishes; the live JSONL file remains available for the dashboard and later inspection.

Merge/push/cleanup lifecycle is recorded locally in `state/run-lifecycle.jsonl`. Use the run log when pushing so Samantha can verify the run commit is integrated and stop recommending already-completed work:

```bash
bun run samantha merge:push --repo-root=<repo> --run-log=<run-log.json>
```

For older runs that were merged/pushed/cleaned before lifecycle recording existed, backfill explicitly:

```bash
bun run samantha runs:mark-lifecycle --run-log=<run-log.json> --repo-root=<repo> --merged --pushed --cleaned
```

If an entire orchestrator plan reports a failed result, use Telegram recovery:

```text
/recover -> state/orchestration-requests.jsonl pending recovery request
/plan -> Orchestrator Agent recovery plan
/go -> materialize the approved recovery plan
```

`/recover` copies the failed plan id, original request, synthesis summary, failed action reasons, relevant changed files, run log paths, and report artifact previews into the new request. It explicitly tells the Orchestrator Agent to inspect the failure, avoid blind retry, and build recovery tasks from canonical project profile repo roots instead of old worker worktrees.

If a standalone worker run fails for a recoverable reason, keep the recovery local:

```bash
bun run samantha tasks:retry <task-id>
bun run samantha tasks:finalize-worktree <task-id> --repo-root=<repo> --worktree=<worker-worktree>
```

Use `tasks:retry` only after understanding the failed run. Use `tasks:finalize-worktree` only after fixing/verifying the existing worker worktree locally.

Stale or obsolete tasks should be archived locally:

```bash
bun run samantha tasks:archive <task-id> --reason=<text>
```

Archived tasks remain in `state/tasks.jsonl`, but `/tasks` and `tasks:list` exclude them by default. Use `tasks:list --include-archived` for audit/debugging.

`/now` is the only routine next-action Telegram command. It should recommend the safest remote-safe next step, such as `/plan`, `/plan_current`, `/go`, `/recover`, or `/problems`, rather than local retry commands or id-based inspection commands.

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

Telegram replies are compacted before sending. Routine replies hide workflow ids, local fallback commands, and raw report headers unless those details are needed in the human-facing report. Reports are split into multiple Telegram messages when needed, but ids are not sent as separate copy-only follow-up messages.

Sent state is stored in:

```text
state/telegram-replies.json
```

Periodic CEO notification generation is stored separately in:

```text
state/ceo-reports.jsonl
```

Each `ceo:notify` record points to the generated `outbox/remote-*.md` file and the Telegram delivery state file. Delivery, retry, and failure evidence remains in `state/telegram-replies.json`.

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
cp ops/systemd/samantha-ceo-notify.service ~/.config/systemd/user/
cp ops/systemd/samantha-ceo-notify.timer ~/.config/systemd/user/
cp ops/systemd/samantha-actions-watch.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now samantha-actions-watch.service
systemctl --user enable --now samantha-telegram-poll.timer
systemctl --user enable --now samantha-telegram-reply.timer
systemctl --user enable --now samantha-ceo-notify.timer
```

The timer reads `%h/projects/samantha-codex/.env`. If the older Claude-side Samantha environment file exists elsewhere, either copy only the two Telegram values into this repo's ignored `.env` or adjust the copied service's `EnvironmentFile=` path locally.

`samantha-ceo-notify.timer` is Ubuntu-host automation. It generates a compact CEO notification hourly; `samantha-telegram-reply.timer` is the only timer that sends the generated remote outbox files.

The timer templates favor interactive replies:

- poll restarts 3 seconds after the prior `telegram:poll` exits
- reply restarts 3 seconds after the prior `telegram:reply` exits
- CEO notification generation runs hourly
- local inbox processing runs every 1 second in the service template
- approved action processing runs every 1 second in the action service template

## Safety

- Sender allowlist is mandatory.
- Bot tokens should be supplied via environment variables or local service environment, not committed files.
- Merge, push, and cleanup remain explicit Samantha gates; Telegram can only approve the latest passed run through `/go`, not provide arbitrary paths or commands.
