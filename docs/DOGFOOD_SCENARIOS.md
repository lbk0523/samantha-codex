# Samantha-Codex Dogfood Scenarios

Last updated: 2026-05-05

## Purpose

These scenarios test the current Samantha MVP without weakening safety gates.

Run them in order. Stop only when a scenario fails in a way that could cause unwanted file changes, bad merges, or misleading audit records.

## Assumptions

- Repo: `/home/lbk0523/projects/samantha-codex`
- External test repo: `/home/lbk0523/projects/oh-my-health-trainer`
- GitHub remote is already configured for `samantha-codex`
- `codex` CLI is authenticated
- `bun install` has already been run in `samantha-codex`

## Scenario 0: Baseline Health Check

Goal: confirm the control plane is healthy before dogfood.

Commands:

```bash
cd /home/lbk0523/projects/samantha-codex
git status --short --branch
bun run test
bun run typecheck
```

Pass criteria:

- git status shows `main...origin/main` with no modified files
- tests pass
- typecheck passes

Failure response:

- Do not run worker scenarios.
- Fix harness/test failures first.

## Scenario 1: Operator CLI And Empty State

Goal: confirm the local Samantha CLI can read ledgers even when no state exists.

Commands:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha runs:list
bun run samantha tasks:list
bun run samantha dashboard:build
```

Pass criteria:

- `runs:list` returns `[]` or existing run summaries
- `tasks:list` returns `[]` or existing task specs
- `dashboard:build` writes `dashboard/index.html`
- generated dashboard is ignored by git

Check:

```bash
git status --short
```

Expected:

- no tracked file changes

## Scenario 2: Task Ledger

Goal: confirm a task can be added to the local task ledger and queried.

Commands:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha tasks:add references/tasks/fixture-reviewer-readonly.json
bun run samantha tasks:list
bun run samantha tasks:show fixture-reviewer-readonly
```

Pass criteria:

- `tasks:add` returns `{ "added": "fixture-reviewer-readonly" }`
- `tasks:list` includes `fixture-reviewer-readonly`
- `tasks:show fixture-reviewer-readonly` returns the task JSON
- `state/tasks.jsonl` exists and is ignored by git

Failure response:

- If duplicate task id is reported, that is acceptable for repeated dogfood.
- If JSON parsing or path lookup fails, fix CLI path handling before continuing.

## Scenario 3: Dry-Run Plan Runner

Goal: confirm Samantha can run a multi-task plan without starting Codex.

Command:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha plan:run references/plans/fixture-review-write-plan.json
```

Pass criteria:

- output contains `planId: fixture-review-write-plan`
- output batches are:
  - `review-policy`
  - `write-policy`
- both results contain prepared `codex exec` commands
- no worktree is allocated
- no Codex process is started

Failure response:

- If targetAgent/profile mismatch occurs, fix task/profile references.
- If writer runs in the same batch as non-writer despite dependency rules, fix plan batching before continuing.

## Scenario 4: Local Inbox/Outbox Loop

Goal: confirm local 24/7 command flow without remote integration.

Create one command file:

```bash
cd /home/lbk0523/projects/samantha-codex
mkdir -p inbox
printf '%s\n' '{"type":"runs:list"}' > inbox/001-runs-list.json
bun run samantha inbox:process
```

Pass criteria:

- command file moves from `inbox/` to `archive/inbox/`
- report is written to `outbox/001-runs-list.md`
- report contains a JSON block with run summaries
- `inbox/`, `outbox/`, and `archive/` are ignored by git

Check:

```bash
git status --short
```

Expected:

- no tracked file changes

## Scenario 5: Remote Command Enqueue

Goal: confirm remote input is normalized into local inbox commands without letting remote input bypass policy.

Create a simulated remote command:

```bash
cd /home/lbk0523/projects/samantha-codex
printf '%s\n' '{"senderId":"bk","text":"/now","receivedAt":"2026-05-03T10:00:00.000Z"}' > /tmp/samantha-remote-now.json
bun run samantha remote:enqueue /tmp/samantha-remote-now.json --allowed-sender-id=bk
bun run samantha inbox:process
```

Pass criteria:

- `remote:enqueue` writes one JSON command under `inbox/`
- `inbox:process` writes a report under `outbox/`
- unsupported text commands fail
- sender mismatch fails

Negative checks:

```bash
printf '%s\n' '{"senderId":"other","text":"/now"}' > /tmp/samantha-remote-denied.json
bun run samantha remote:enqueue /tmp/samantha-remote-denied.json --allowed-sender-id=bk
```

Expected:

- command fails with `remote sender is not allowed`

## Scenario 6: Real Read-Only Codex Canary Against OMHT

Goal: run one real Codex worker in an external repo without allowing any file change.

Command:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run dispatch-worker \
  --task=references/tasks/omht-readonly-status-canary.json \
  --agent=references/agent-profiles/codex-reviewer.json \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer \
  --allocate \
  --execute
```

Pass criteria:

- output includes `runLog`
- output includes `runSummary`
- `runSummary.outcome` is `pass`
- `runSummary.pass` is `true`
- `runSummary.commit` is empty
- `evaluation.changedFiles` is `[]`
- `evaluation.scopeViolations` is `[]`
- `state/runs.jsonl` receives one compact run summary
- `runs/*.json` receives one full audit log
- `/home/lbk0523/projects/oh-my-health-trainer` remains clean

Post-check:

```bash
cd /home/lbk0523/projects/oh-my-health-trainer
git status --short
git worktree list
```

Expected:

- main worktree clean
- one external Samantha worker worktree may remain for inspection

Read-only cleanup after inspection remains manual because no commit exists for the completed-worktree cleanup gate:

```bash
cd /home/lbk0523/projects/oh-my-health-trainer
git worktree list
git worktree remove <readonly-worktree-path>
git branch -D samantha/omht-readonly-status-canary
```

Only run cleanup if the listed worktree/branch exists.

## Scenario 7: Dashboard From Real Run Index

Goal: confirm run summaries become a readable dashboard.

Commands:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha runs:list
bun run samantha dashboard:build
```

Pass criteria:

- `runs:list` includes the OMHT read-only canary run
- `dashboard/index.html` exists
- dashboard includes task id, agent id, outcome, commit, and failure reason columns
- dashboard is read-only static HTML

## Scenario 8: Merge Gate Negative Check

Goal: confirm Samantha refuses to merge non-writer or no-commit runs.

Find the latest read-only run log path from `state/runs.jsonl`, then run:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha merge:check \
  --run-log=<latest-readonly-run-log-path> \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer
```

Pass criteria:

- `mayMerge` is `false`
- violations include no reported commit or missing allocated writer base conditions
- no merge is executed

This verifies the merge gate stays conservative.

## Scenario 9: Writer Dogfood Checklist

Goal: prepare a safe future writer task without reusing stale write canaries.

Do not rerun `omht-schema-07-new-block-fixture-canary` as-is. It was already applied once, so rerunning it may create duplicate tests or misleading reports.

For the next writer dogfood, create a new task with these constraints:

- target repo starts clean
- one small target file or one report file
- exact `targetFiles`
- broad `forbiddenChanges`
- `setupCommands` includes required dependency setup, for example `bun install`
- verify commands are focused and deterministic
- worker must not commit or push
- Samantha must create exactly one commit after scope and verify gates pass
- Samantha must run `merge:check` before any integration

Recommended first writer dogfood candidates:

1. Add a tests-only fixture that does not already exist.
2. Add a generated report under a new dated path.
3. Update one narrow docs file in a test repo, not production app code.

Pass criteria:

- worker run passes
- run index and full audit log are created
- `merge:check` returns `mayMerge: true`
- human reviews the diff before running any actual merge command

## Scenario 10: Real Writer Codex Canary Against OMHT

Goal: prove Samantha can run a real writer task while keeping Git integration under Samantha control.

Command:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run dispatch-worker \
  --task=references/tasks/omht-schema-07-unknown-block-negative-canary.json \
  --agent=references/agent-profiles/codex-worker.json \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer \
  --allocate \
  --execute
```

Pass criteria:

- `runSummary.outcome` is `pass`
- `runSummary.commit` is non-empty
- worker output leaves `HARNESS_RESULT.commit` empty
- `execution.commit.commitHash` is non-empty
- changed files are within `targetFiles`
- verify commands pass in Samantha evaluation
- target repo main remains clean

## Scenario 11: Merge Gate Positive Check

Goal: confirm a passing Samantha-owned writer commit becomes a manual merge candidate.

Command:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha merge:check \
  --run-log=<writer-run-log-path> \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer
```

Pass criteria:

- `mayMerge` is `true`
- `commit` matches `runSummary.commit`
- `command` is `git merge --ff-only <commit>`
- no merge is executed during this scenario

## Scenario 12: Merge Apply Gate

Goal: apply an approved passing writer run without combining merge and push.

Command:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha merge:apply \
  --run-log=<writer-run-log-path> \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer
```

Pass criteria:

- `gate.mayMerge` is `true`
- `applied` is `true`
- `verified` is `true`
- `headAfter` matches `gate.commit`
- task verify commands run after the fast-forward merge
- no push is executed

Only run this scenario after BK approves integrating the writer commit.

## Scenario 13: Merge Push Gate

Goal: push an already accepted main branch separately from merge application.

Command:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha merge:push \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer \
  --remote=origin \
  --branch=main
```

Pass criteria:

- target repo is on `main`
- target repo is clean
- push command exits `0`

Only run this scenario after BK approves pushing the integrated main branch.

## Scenario 14: Completed Worktree Cleanup

Goal: remove a completed worker worktree only after its commit is integrated.

Command:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha worktree:cleanup \
  --run-log=<writer-run-log-path> \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer
```

Pass criteria:

- `mayCleanup` is `true`
- `cleaned` is `true`
- `git worktree list` no longer shows the worker worktree
- completed `samantha/<task-id>` branch is deleted
- target repo main remains clean

Only run this scenario after the writer commit is merged into target main.

## Scenario 15: Daemon Health

Goal: confirm `inbox:watch` can run as a single local daemon with heartbeat visibility.

Commands:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha inbox:watch --interval-ms=1000
```

In another shell:

```bash
cd /home/lbk0523/projects/samantha-codex
bun run samantha health:check
bun run samantha dashboard:build
```

Pass criteria:

- a second `inbox:watch` is blocked by the daemon lock
- `health:check` reports `ok: true`
- `state/heartbeat.json` updates while the daemon is running
- dashboard shows heartbeat and pending inbox count
- stopping the daemon releases `state/daemon.lock`

## Scenario 16: Telegram Poll Adapter

Goal: confirm Telegram input can only create allowlisted inbox commands, the practical Telegram flow stays short, and Telegram replies only send outbox reports.

Command:

```bash
cd /home/lbk0523/projects/samantha-codex
TELEGRAM_BOT_TOKEN=<token> \
TELEGRAM_CHAT_ID=<telegram-chat-id> \
bun run samantha telegram:poll --timeout-seconds=0
```

Reply command:

```bash
cd /home/lbk0523/projects/samantha-codex
TELEGRAM_BOT_TOKEN=<token> \
TELEGRAM_CHAT_ID=<telegram-chat-id> \
bun run samantha telegram:reply
```

Pass criteria:

- allowed practical commands `/help`, `/start`, `/now`, `/work <text>`, `/plan`, `/plan_current`, `/go`, `/revise <feedback>`, `/cancel`, `/recover`, `/check`, and `/problems` create inbox files
- old advanced/id-based Telegram commands return a deprecated-command report with a replacement command instead of running the old flow
- hyphenated aliases are deprecated because Telegram breaks command links at hyphens
- `/help` shows the short `/work <request> -> /plan -> /go` operating flow instead of a long command catalog
- unsupported messages are ignored
- messages from other sender ids are ignored
- `state/telegram-offset.json` is updated after a successful poll
- `state/telegram-replies.json` prevents duplicate Telegram replies
- long remote outbox replies are split into multiple Telegram messages instead of truncated
- reports that return proposal, draft, action, run, or task IDs also send each ID as a separate copy-only Telegram message
- `/propose <text>` writes only to `state/proposals.jsonl` and does not dispatch a worker
- `/work <text>` writes only to `state/orchestration-requests.jsonl` and does not dispatch a worker
- `/draft_propose <text>` writes only to `state/proposals.jsonl` and `state/task-drafts.jsonl` and does not dispatch a worker
- `/accept <id>` and `/reject <id>` update proposal review state only and do not dispatch workers
- `/draft <proposal-id>` writes only to `state/task-drafts.jsonl`; unaccepted proposals are rejected
- `drafts:check`, `drafts:update`, and `drafts:approve` stay local-only
- `drafts:approve` writes one pending task to `state/tasks.jsonl` only after `targetFiles`, `verifyCommands`, `instructions`, and `targetAgent` pass checks
- direct `tasks:dispatch` stays local-only; dry-run prints the prepared Codex command, and `--execute` writes run logs and run index entries
- `/plan` runs `codex-orchestrator` in read-only mode and returns a detailed plan without dispatching a worker
- `/go` materializes safe orchestrator plans into tasks and approved actions; unsafe plans are blocked before task/action creation
- dependent materialized actions wait until prerequisite actions complete successfully
- completed materialized plans rerun `codex-orchestrator` in synthesis mode and produce one `# plan-result` outbox report in addition to per-action reports
- old lower-level Telegram action commands return deprecated-command guidance instead of running the old flow
- `actions:watch` executes approved dispatch action ids with fixed `--allocate --execute --tmux` flags and locally configured repo root
- no remote path accepts shell, arbitrary repo paths, arbitrary merge/push/cleanup paths, or direct worker dispatch
- `inbox:watch` processes the created inbox commands later
- `telegram:reply` sends only `outbox/remote-*.md` report text to Telegram
- the systemd timer can be enabled after one manual real-token poll passes

## Stop Conditions

Stop dogfood and fix Samantha before continuing if any of these happen:

- read-only worker changes a file
- run summary says pass but full log shows failed verify
- dashboard omits a failed run
- `merge:check` allows a no-commit read-only run
- `merge:apply` applies a blocked run
- `merge:push` pushes from a dirty worktree or wrong branch
- `worktree:cleanup` removes an unmerged or dirty worker worktree
- Telegram input bypasses the inbox or sender allowlist
- Telegram reply sends local non-remote outbox files unexpectedly
- Telegram reply resends the same outbox file repeatedly
- Telegram reply sends status values, timestamps, or file paths as copy-only ID messages
- `/propose` dispatches a worker, creates a commit, or changes project files
- `/draft_propose` dispatches a worker, creates a commit, writes `state/tasks.jsonl`, or changes project files
- `/accept` or `/reject` dispatches a worker, creates a commit, or changes project files
- `/draft` dispatches a worker, creates a commit, writes `state/tasks.jsonl`, or changes project files
- any remote Telegram command can run `drafts:approve` or write `state/tasks.jsonl`
- any remote Telegram command can run `tasks:dispatch` directly, bypass `actions:watch`, or change the repo root/flags for an approved action
- remote command can create arbitrary shell execution
- writer task modifies files outside `targetFiles`
- target repo main worktree becomes dirty unexpectedly

## Expected Dogfood Outcome

After Scenarios 0-8, Samantha should demonstrate:

- local operator visibility
- task ledger support
- dry-run plan orchestration
- local inbox/outbox command loop
- narrow remote command normalization
- real Codex read-only worker execution
- audit log and compact run index persistence
- read-only dashboard generation
- conservative merge gating

After Scenarios 9-16, Samantha should additionally demonstrate:

- real Codex writer execution
- Samantha-owned commit creation
- positive merge candidate detection without automatic merge
- explicit merge application with post-merge verification
- separate clean-worktree push gating
- completed worktree cleanup
- daemon lock, heartbeat, health check, and dashboard daemon status
- narrow Telegram polling into inbox, including legacy `TELEGRAM_CHAT_ID` authorization
- Telegram outbox replies for remote command reports
- remote proposal intake without worker execution

At that point the next engineering step is hardening `/check` and `/problems` so Telegram works as the practical operating console.
