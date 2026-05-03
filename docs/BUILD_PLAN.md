# Samantha-Codex Build Plan

Last updated: 2026-05-03

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
- OMHT read-only canary
- OMHT tests-only write canary

Important dogfood findings:

- Fresh worktrees need deterministic setup. This is why `setupCommands` exists.
- Codex worker commits need controlled access to parent `.git` worktree metadata.
- Audit logs are mandatory before 24/7 operation; otherwise Samantha cannot explain what happened after the fact.

## Near-Term Roadmap

### Phase 1: Run Index And Task Ledger

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

Goal: move from "worker produced a pass result" to "Samantha can safely prepare integration."

Build:

- merge candidate detection from pass runs
- clean-main-worktree check
- base commit check
- target branch check
- fast-forward merge where possible
- cherry-pick fallback only with explicit policy
- post-merge verify commands
- push stays separate until the gate is proven

Success criteria:

- Samantha can say "safe to merge", "blocked", or "needs human decision" with concrete reasons
- no worker can merge or push independently

### Phase 4: Plan Runner

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

Goal: run Samantha continuously without adding remote UX risk too early.

Build:

- local inbox directory, for example `inbox/*.json`
- local outbox directory, for example `outbox/*.md`
- polling loop or systemd user service
- graceful shutdown
- duplicate command protection

Success criteria:

- BK can drop a command into inbox
- Samantha processes it and writes a report to outbox
- process restarts do not lose task state

### Phase 6: Remote Command Surface

Goal: let BK instruct Samantha remotely after local loop safety is proven.

Preferred order:

1. file-backed local loop
2. narrow authenticated Telegram commands
3. optional web dashboard

Success criteria:

- remote input only creates orchestrator commands
- remote interface cannot bypass safety gates
- every remote command maps to a ledger entry and audit log

### Phase 7: Dashboard

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

## What Not To Build Yet

Do not prioritize these until the ledger, CLI, and merge gate exist:

- Telegram-first 24/7 loop
- multi-writer parallelism
- web dashboard with write controls
- general marketplace-style multi-agent platform
- complex plugin system beyond pinned skill bundle references
- autonomous push/deploy behavior

## Immediate Next Step

Build Phase 1: Run Index And Task Ledger.

The practical next implementation should:

1. append a compact run summary whenever `dispatch-worker --execute` writes a run log
2. keep the full run JSON in `runs/`
3. keep the compact index in `state/runs.jsonl`
4. add tests for pass run, setup-blocked run, and verify-failed run summaries

This turns Samantha from "a command that can run workers" into "a system that remembers and can explain worker activity."
