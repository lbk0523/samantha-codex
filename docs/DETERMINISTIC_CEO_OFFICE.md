# Deterministic CEO Office

Last updated: 2026-05-07

## Decision

Samantha's first MVP is a status reporting and work operations system, not a Telegram-first command bot.

The core product direction is:

```text
Samantha is not a persistent LLM boss.
Samantha is a deterministic CEO office that selectively hires LLM agents for bounded work.
```

In Korean:

```text
Samantha는 상주하는 LLM CEO가 아니라,
LLM 직원들을 필요할 때 호출하는 결정론적 운영실이다.
```

## Why This Exists

Telegram was introduced so BK could give Codex work from anywhere. After Tailscale access to the Ubuntu Samantha host, that assumption changed.

Mobile is useful for quick checks, approvals, and short feedback. It is not a realistic primary surface for long, intense, or massive development work. The real goal is not "a mobile bot for Codex." The real goal is a personal development operations control plane.

## Company Model

Use this mental model when evaluating architecture decisions:

```text
BK
  = founder / final decision maker

Deterministic CEO Office
  = operating system for status, queues, approvals, reporting, schedules, and safety gates

LLM agents
  = executives, workers, reviewers, researchers, evaluators, or consultants called for bounded tasks
```

The "CEO office" is deterministic TypeScript code. It owns state and operational authority. LLMs do not stay awake forever, remember the system state, or run the company from conversation memory.

## Responsibility Split

The deterministic CEO office owns:

- task store
- run store
- action queue
- approval queue
- status reporting schedule
- safety policy validation
- writer cap
- audit log
- dispatch gates
- merge, push, and cleanup gates

LLM agents may produce:

- status summaries
- issue analysis
- proposed next actions
- task decomposition
- review and evaluation reports
- report drafts
- minimal clarification questions for BK

LLM output is a proposal, analysis, or draft. State changes happen only after deterministic code validates and records them.

## First MVP Scope

The first MVP was scoped to prove that Samantha can:

1. Store structured work state.
2. Track task status, owner, blocker, risk, and next action.
3. Maintain a separate queue of items needing BK decisions.
4. Generate a clear periodic or on-demand status report.
5. Refuse risky actions without the required approval and safety gates.

This MVP is useful before broad Telegram control, multi-agent team construction,
or multi-writer execution.

## Remote Interface Policy

Telegram should be demoted from primary command surface to adapter.

Good Telegram responsibilities:

- new status report available
- approval required
- task failed
- blocker detected
- short BK response captured

Poor Telegram responsibilities for MVP:

- long-form task design
- intense review sessions
- internal task/action/run id navigation
- arbitrary command execution
- primary development workspace

The stable core should be independent of Telegram:

```text
Core:
  - task store
  - orchestrator/control-plane state
  - report generator
  - approval queue
  - safety gates

Adapters:
  - CLI
  - dashboard
  - Telegram
  - email or future surfaces
```

## Guardrails

When future work starts drifting, use these checks:

- If a feature mainly expands Telegram commands, ask whether it advances status reporting and work operations.
- If an LLM must stay alive to remember state, move that state into the deterministic store.
- If an LLM can dispatch, merge, push, cleanup, or mutate state directly, route that through the CEO office gates instead.
- If a workflow cannot produce a useful status report, the task model is not structured enough yet.
- If a mobile interaction requires long context review, move the interaction to CLI or dashboard and keep mobile for notification or approval.

## Practical Direction

Do not let Telegram implementation details define Samantha's core architecture.
Use the roadmap as the source of truth for current and future phases.

The previous command-driven user workflow contract has been retired after
remote dogfood. Rewrite the workflow playbook after the remote autopilot
contract is stable.
For the long-range roadmap, see [CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md).
For the current system contract, see [ARCHITECTURE.md](ARCHITECTURE.md).
For the remote adapter contract, see [REMOTE_ADAPTERS.md](REMOTE_ADAPTERS.md).
