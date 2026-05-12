# CEO Office Roadmap

Last updated: 2026-05-12

## Purpose

This document is the long-range roadmap for Samantha's CEO operating system.
It records product direction and maturity gates, not implementation TODOs.

Detailed stage plans, handoff prompts, and completed implementation notes belong
in PRs, issues, commits, tests, or git history. Do not add new phase execution
logs here unless they describe a repeatable product principle that future work
must keep following.

## North Star

Build Samantha into BK's personal development operations control plane with a
natural CEO conversation surface and deterministic execution authority.

The target experience is:

```text
BK
  = founder, final decision maker

Samantha CEO Conversation Layer
  = natural turn-by-turn CEO / executive assistant surface for goals,
    tradeoffs, product direction, feedback, and decisions

Deterministic TypeScript Kernel
  = durable operating system for work state, reporting, queues, approvals,
    schedules, safety gates, dispatch, recovery, memory gates, and audit

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

Samantha should converse with BK at roughly the breadth and flexibility of the
Codex CLI experience. The natural conversation layer may discuss context,
push back, ask multi-part questions, summarize tradeoffs, and translate intent
into work. It must not directly mutate production state or grant authority.

The authority direction is:

```text
Natural CEO conversation is broad.
Execution authority is narrow and deterministic.
Memory is context, not authority.
```

BK should state intent, exchange product feedback, make decisions, and review
results without manually choosing internal workflow commands. Samantha should
perform safe deterministic progress on BK's behalf until the next useful CEO
conversation turn, approval boundary, result, or local repair boundary.

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

The autopilot dogfood pass exposed a deeper product gap in this baseline: the
command-driven flow is safe, but it is too operator-heavy. Asking BK to choose
`/plan`, `/go`, `/approve`, `/now`, or `/check` makes BK the scheduler instead
of letting Samantha act as a CEO/assistant. That gap should be treated as the
next product correction, not as a reason to add more commands.

## Product Principles

- Samantha needs a natural CEO conversation layer, not a command-bot primary
  interface.
- The TypeScript control plane remains the state, policy, execution, and audit
  kernel.
- BK talks to Samantha in natural language; Samantha translates conversation
  into structured proposals and safe internal transitions.
- Remote adapters capture intent, short feedback, approvals, and compact
  reports; they do not define the core product surface and do not execute shell
  commands or accept arbitrary paths or internal ids.
- Safe deterministic transitions should advance without making BK choose
  internal workflow commands.
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
- `CEO_Conversation_MEMORY.md`, governed memory records, decision summaries, and
  project briefs are planning context. They can preserve product direction and
  improve future CEO turns, but only deterministic policy can grant runtime
  authority.
- Exactly one active automation host owns runtime state at a time.

## Next Direction

Near-term work should turn Samantha from a command workflow into a natural CEO
turn loop before broadening scope:

### Phase 1 - CEO Turn Loop

Apply the turn-by-turn agent CEO direction. BK should be able to talk to
Samantha in natural language at Codex CLI-level breadth and flexibility.
Samantha should understand intent, constraints, priorities, and risk; retrieve
conversation context; propose or execute only safe deterministic transitions;
and respond as a CEO/assistant rather than as a command router.

Phase 1 succeeds when routine planning/report/product-feedback work no longer
requires BK to drive `/plan`, `/go`, `/approve`, or `/now` choreography. The
implemented command surfaces may remain as debug and adapter compatibility, but
they must not be the product workflow.

### Phase 2 - Memory And Context System

Build the learning structure behind CEO conversation. Separate:

- short-term context: current conversation, active request, pending decisions,
  active plans, recent runs, and current blockers
- long-term memory: `CEO_Conversation_MEMORY.md`, governed memory records,
  decision-history summaries, project briefs, and cited reports/artifacts

The memory process is:

```text
retrieve -> summarize -> cite/source -> use as context -> propose update
-> deterministic memory write gate
```

Memory preserves context and product direction. It must not grant execution
authority, connector access, secret access, budget authority, routine authority,
profile authority, or host authority.

### Phase 3 - Software Development Organization

Build Samantha's general software development organization after the CEO turn
loop and memory system are usable. The organization should flex across web,
app, game, and other software projects by understanding each product's context,
constraints, platform, design goals, and delivery process.

The first Phase 3 success criterion is one real project flow: BK and Samantha
discuss product direction naturally, Samantha organizes the right spec,
research, review, evaluation, operations, and writer roles, then work proceeds
through implementation, verification, reporting, feedback, and recovery gates.
General multi-domain capability should come from repeated dogfood evidence, not
from speculative framework expansion.

Keep the durable reference split:

- keep `ARCHITECTURE.md` as the durable system contract
- keep `CEO_Conversation_MEMORY.md` as the current durable conversation memory
  file until a governed structured memory flow supersedes it
- keep `REMOTE_ADAPTERS.md` as the compact adapter implementation contract
- keep `DAEMON_OPERATIONS.md` as the active-host and runtime operations
  contract
- keep legacy remote-autopilot notes under `docs/legacy/` as historical context
  only
- keep `PARALLELISM_EVIDENCE.md` as the writer-cap evidence ledger
- keep `ROLLBACK_AND_RECOVERY_DRILLS.md` as the recovery drill catalog

New work should update docs only when it changes a repeatable rule, contract, or
operator workflow. Concrete implementation task lists should stay out of
`docs/`.

## Future Gates

Before expanding Samantha beyond the current baseline, answer these questions:

- What deterministic record owns the new state?
- What approval or safety gate blocks unsafe use?
- What natural CEO turn, report, or approval boundary shows the next useful
  action?
- Can Samantha make safe progress without asking BK to choose an internal
  workflow command?
- What conversation memory should be retrieved or updated, and is it context
  only?
- Which verification profile proves the change?
- Does this expand worker, connector, secret, routine, budget, merge, push,
  cleanup, recovery, memory, SOP, skill, or host authority?

If authority expands, add governance, tests, and dogfood evidence before relying
on it. If the change is only wording or display, keep it inside the existing
operating surface without creating new state.

Future authority expansion should follow this path:

```text
BK decisions -> decision memory -> pattern synthesis -> proposed authority grant
-> BK approval -> deterministic policy
```

Do not let preference memory, operational memory, judgment history, SOPs, or
skills directly grant runtime authority.
