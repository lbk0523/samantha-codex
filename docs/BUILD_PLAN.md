# Samantha-Codex Build Plan

Last updated: 2026-05-04

Current planning status: MVP control plane built, read-only dogfood completed, the first low-risk writer dogfood passed with a Samantha-owned commit, explicit merge apply/push gates are implemented, and the local daemon has heartbeat/lock hardening. Current focus is Telegram remote adapter dogfood using the legacy Samantha bot environment.

## Purpose

Samantha-Codex is a Codex-only personal agent control plane.

The target user experience is simple: BK talks to one 24/7 orchestrator, and Samantha decomposes work, dispatches specialist Codex agents, verifies their outputs, merges only safe results, and reports back through one surface.

This is not a general multi-agent platform first. It is a safety-first operations layer for BK's real projects.

## Core Decisions

1. The orchestrator is deterministic TypeScript code, not a permanent LLM chat session.
2. Codex/GPT agents are workers, reviewers, evaluators, or spec helpers.
3. BK talks only to Samantha, not to individual worker agents.
4. Writer agents must work in isolated git worktrees.
5. Start with one writer at a time. Parallelism starts with non-writer agents.
6. Agent output is accepted only after structured result, scope, and verification gates pass.
7. External skill bundles can guide worker behavior, but cannot own orchestration, worktree allocation, merge, push, or safety policy.

## Current State

Already implemented:

- TypeScript/Bun control-plane scaffold
- agent profile contracts
- task spec contracts
- safety policy validation
- worktree allocation helpers
- Codex CLI dispatch command construction
- `--execute` worker execution
- `HARNESS_RESULT` parsing from Codex JSONL output
- scope gate: changed files must stay inside `targetFiles`
- forbidden-change gate
- verify command gate
- task `setupCommands`, run before Codex starts
- worker run audit logs under `runs/`
- compact run index under `state/runs.jsonl`
- local task ledger under `state/tasks.jsonl`
- `samantha` operator CLI
- merge candidate checks
- explicit `merge:apply` and `merge:push` gates
- completed worktree cleanup gate
- multi-task plan runner
- file-backed local inbox/outbox processing
- daemon lock, heartbeat, health check, and systemd service template
- local `doctor` diagnostics and remote `/doctor`
- narrow remote command enqueueing
- Telegram polling adapter with legacy `TELEGRAM_CHAT_ID` support
- Telegram outbox reply adapter
- remote proposal intake and review state under `state/proposals.jsonl`
- accepted proposal to task draft flow under `state/task-drafts.jsonl`
- local-only task draft check, update, and approval gate
- local-only pending task dispatch into existing worker run logs and run index
- task draft `setupCommands` promotion into worker setup
- project profiles for repo-level setup and verify defaults
- task archival so stale tasks do not pollute `/next-action`
- existing clean worktree reuse for same-task dispatch retries
- local `tasks:retry` and `tasks:finalize-worktree` recovery commands
- read-only `/next-action` Telegram command
- systemd timer templates for Telegram polling and outbox replies
- read-only static dashboard generation
- OMHT read-only canary
- OMHT tests-only write canary

Important dogfood findings:

- Fresh worktrees need deterministic setup. This is why `setupCommands` exists.
- `setupCommands` must be set before task approval when the target repo needs dependencies in an isolated worktree.
- Failed dispatch attempts may leave clean worktrees behind; Samantha can now reuse or finalize them instead of forcing manual branch cleanup.
- Already-merged runs should report as already integrated, not as generic HEAD mismatch failures.
- Codex workers should not receive parent `.git` metadata write access.
- Samantha should create commits itself after worker output passes scope and verify gates.
- Audit logs are mandatory before 24/7 operation; otherwise Samantha cannot explain what happened after the fact.
- Read-only dogfood against `oh-my-health-trainer` passed without file changes and correctly produced run log, run index, dashboard data, and a merge-gate rejection for no-commit output.
- Writer dogfood against `oh-my-health-trainer` passed with a tests-only schema canary, a full audit log, a compact run summary, and a manual fast-forward merge candidate.

## Near-Term Roadmap

### Phase 1: Run Index And Task Ledger

MVP status: implemented.

Goal: make Samantha aware of past and current work without scanning every run log manually.

Build:

- `state/runs.jsonl` or equivalent append-only run index
- `state/tasks.jsonl` task ledger
- summary fields: task id, agent id, status, pass/fail, commit, run log path, startedAt, finishedAt
- failure summary extraction for setup, Codex, scope, and verify failures

Success criteria:

- recent runs can be listed quickly
- failed runs can be inspected without opening large JSON logs first
- Samantha can answer "what is currently pending or failed?"

### Phase 2: Operator CLI

MVP status: implemented.

Goal: provide a small local command surface for BK and for future daemon usage.

Build commands like:

- `runs:list`
- `runs:show <run-id>`
- `tasks:list`
- `tasks:show <task-id>`
- `tasks:add <task.json>`

Success criteria:

- no need to remember raw file paths for common status checks
- run/task status is visible from a single CLI

### Phase 3: Merge Gate

MVP status: implemented as `merge:check`, `merge:apply`, and separate `merge:push`.

Goal: move from "worker produced a pass result" to "Samantha can safely prepare integration."

Build:

- merge candidate detection from pass runs
- clean-main-worktree check
- base commit check
- target branch check
- fast-forward merge apply
- cherry-pick fallback only with explicit policy
- post-merge verify commands
- push stays separate from merge

Success criteria:

- Samantha can say "safe to merge", "blocked", or "needs human decision" with concrete reasons
- no worker can merge or push independently
- `merge:apply` runs task verify commands after the fast-forward merge
- `merge:push` refuses dirty worktrees and branch mismatches
- `worktree:cleanup` removes completed worker worktrees only after integration is present on target main

### Phase 4: Plan Runner

MVP status: implemented.

Goal: run a multi-task plan, not only one task JSON at a time.

Build:

- plan JSON schema
- dependency ordering between tasks
- parallel non-writer execution
- writer concurrency cap of `1`
- plan summary report

Success criteria:

- reviewer/spec/evaluator agents can run in parallel
- writer tasks remain serialized until dogfood evidence justifies more
- one plan produces one final report

### Phase 5: Local 24/7 Loop

MVP status: implemented as file-backed `inbox:process`, hardened `inbox:watch`, and a systemd user-service template.

Goal: run Samantha continuously without adding remote UX risk too early.

Build:

- local inbox directory, for example `inbox/*.json`
- local outbox directory, for example `outbox/*.md`
- polling loop
- daemon lockfile
- heartbeat file under `state/heartbeat.json`
- `health:check`
- failure outbox reports for bad inbox commands
- systemd user service template
- graceful shutdown
- duplicate command protection

Success criteria:

- BK can drop a command into inbox
- Samantha processes it and writes a report to outbox
- process restarts do not lose task state
- duplicate `inbox:watch` starts are blocked
- dashboard can display daemon heartbeat and pending inbox count
- systemd setup is documented in `docs/DAEMON_OPERATIONS.md`

### Phase 6: Remote Command Surface

MVP status: implemented as `remote:enqueue` plus `telegram:poll`, both mapping narrow remote input into the local inbox. Telegram supports both `TELEGRAM_ALLOWED_SENDER_ID` and the older Claude-side `TELEGRAM_CHAT_ID` env name.

Goal: let BK instruct Samantha remotely after local loop safety is proven.

Preferred order:

1. file-backed local loop
2. narrow authenticated Telegram commands
3. optional web dashboard

Success criteria:

- remote input only creates orchestrator commands
- remote interface cannot bypass safety gates
- every remote command maps to a ledger entry and audit log
- sender allowlist is mandatory for Telegram

### Phase 7: Dashboard

MVP status: implemented as read-only static HTML generation from run summaries. Queue state, merge candidates, and project/repo status are still pending.

Goal: make long-running operation inspectable.

Build:

- current queue
- recent runs
- failed gates
- pending merge candidates
- project/repo status

Success criteria:

- dashboard is read-heavy first
- write actions remain gated through CLI/orchestrator policy

## Safety Gates To Preserve

These gates should not be weakened for convenience:

- writer tasks require `targetFiles`
- writer tasks require `forbiddenChanges`
- writers use per-task worktrees
- workers cannot dispatch subagents
- workers cannot create worktrees
- workers cannot push
- merges are Samantha-controlled
- external skills cannot override Samantha policy
- every accepted worker run needs `HARNESS_RESULT`
- every accepted worker run needs passing verify commands
- writer commits are created by Samantha, not by worker agents

## What Not To Build Yet

Do not prioritize these until Telegram dogfood proves the remote command loop is stable:

- multi-writer parallelism
- web dashboard with write controls
- broad Telegram command surface beyond read-mostly status commands
- general marketplace-style multi-agent platform
- complex plugin system beyond pinned skill bundle references
- autonomous push/deploy behavior

## Immediate Next Step

Dogfood the Telegram adapter with a real bot token after the local `inbox:watch` soak remains healthy.

The practical next implementation should:

1. keep `inbox:watch` running through the systemd user service
2. configure local, uncommitted Telegram env values in `.env`
3. run one manual `telegram:poll --timeout-seconds=0` with `/runs` or `/tasks`
4. verify the adapter only writes an inbox command
5. verify `inbox:watch` writes the final outbox report
6. then enable `samantha-telegram-poll.timer`

The detailed next plan is in [NEXT_PLAN.md](NEXT_PLAN.md).
