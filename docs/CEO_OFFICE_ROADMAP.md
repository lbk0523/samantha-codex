# CEO Office Roadmap

Last updated: 2026-05-11

## Purpose

This document is the long-range roadmap for Samantha's Deterministic CEO
Office. It records product direction and maturity gates, not implementation
TODOs.

Detailed stage plans, handoff prompts, and completed implementation notes belong
in PRs, issues, commits, tests, or git history. Do not add new phase execution
logs here unless they describe a repeatable product principle that future work
must keep following.

## North Star

Build Samantha into BK's personal development operations control plane.

The target experience is:

```text
BK
  = founder, final decision maker

Deterministic CEO Office
  = durable operating system for work state, reporting, queues, approvals,
    schedules, safety gates, dispatch, recovery, and audit

Bounded LLM Agents
  = planners, synthesizers, reviewers, evaluators, researchers, content agents,
    operations agents, and coding agents called only for bounded work
```

Samantha should periodically report:

- what finished
- what is active
- what is blocked
- what needs BK's decision
- what risks exist
- what Samantha recommends next

Samantha should execute only approved, safe next steps through deterministic
gates. LLMs may propose and summarize, but durable state and operational
authority stay in TypeScript code.

North-star criteria are tracked in [NORTH_STAR.md](NORTH_STAR.md).

## Current Baseline

The Codex-only control-plane baseline is implemented for the current scope:

- deterministic work state, plans, decisions, actions, runs, and audit records
- bounded orchestrator planning, synthesis, and question drafting
- report-only non-writer roles and one production writer
- Telegram as a compact remote adapter, not the primary workspace
- CLI and dashboard as long-review operator surfaces
- project profiles, project/goal ancestry, and wrong-project guards
- governance gates for risk, authority, skills, connectors, secrets, routines,
  budgets, merge, push, cleanup, recovery, memory, and SOP changes
- active-host ownership diagnostics for single-host automation
- routine intake, queue pressure, notification throttling, budget gates, backup,
  restore, and host migration validation

This baseline does not expand runtime authority. `writerCap` remains `1`;
remote adapters remain non-shell; routines remain intake-only; backup, restore,
and migration remain read-only validation plus manual handoff.

## Product Principles

- Samantha is a deterministic CEO office, not a persistent LLM boss.
- BK talks to the orchestrator surface; production state changes go through
  deterministic stores and safety gates.
- Remote adapters capture narrow intent and approvals; they do not execute
  shell commands or accept arbitrary paths or internal ids.
- Normal reports should provide one safe next action instead of making BK choose
  from raw state.
- Telegram UX must not require task, action, run, decision, proposal, or draft
  ids for routine operation.
- Cancellation and pending-request cleanup must stay narrow: clean stale
  request records only, and do not mutate existing plans, tasks, actions, runs,
  or integration state.
- Non-writer agents are report-only. They may run in parallel, but they do not
  get worktrees, merge policies, connector authority, or runtime mutation
  rights.
- Writer-cap increases require explicit dogfood evidence, conflict detection,
  merge/cleanup reliability, rollback evidence, and BK approval.
- Skills, SOPs, memory, routines, budgets, connectors, and secrets are context
  or governed capabilities. They cannot override safety policy.
- Exactly one active automation host owns runtime state at a time.

## Next Direction

Near-term work should be boring operational consolidation:

- keep `ARCHITECTURE.md` as the durable system contract
- keep `REMOTE_ADAPTERS.md` as the compact remote UX contract
- keep `DAEMON_OPERATIONS.md` as the active-host and runtime operations
  contract
- keep `SAMANTHA_WORKFLOW_PLAYBOOK.md` as the operator guide
- keep `PARALLELISM_EVIDENCE.md` as the writer-cap evidence ledger
- keep `ROLLBACK_AND_RECOVERY_DRILLS.md` as the recovery drill catalog

New work should update docs only when it changes a repeatable rule, contract, or
operator workflow. Concrete implementation task lists should stay out of
`docs/`.

## Future Gates

Before expanding Samantha beyond the current baseline, answer these questions:

- What deterministic record owns the new state?
- What approval or safety gate blocks unsafe use?
- What command or report shows the next safe action?
- Which verification profile proves the change?
- Does this expand worker, connector, secret, routine, budget, merge, push,
  cleanup, recovery, memory, SOP, skill, or host authority?

If authority expands, add governance, tests, and dogfood evidence before relying
on it. If the change is only wording or display, keep it inside the existing
operating surface without creating new state.
