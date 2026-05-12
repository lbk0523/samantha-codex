# Deterministic CEO Office

Last updated: 2026-05-12

## Decision

Samantha's first MVP proved the deterministic work-operations baseline. The
next product correction is a natural CEO conversation layer on top of that
baseline, not a larger Telegram command bot.

The core product direction is:

```text
Samantha has a natural CEO conversation layer.
Samantha has a deterministic TypeScript policy and state kernel.
Samantha selectively hires bounded LLM agents for scoped work.
```

In Korean:

```text
Samantha는 BK와 자연어로 대화하는 CEO/비서 표면을 가진다.
실행 권한과 영속 상태는 결정론적 TypeScript kernel이 가진다.
LLM 직원들은 필요할 때 제한된 범위로 호출된다.
```

## Why This Exists

Telegram was introduced so BK could give Codex work from anywhere. After Tailscale access to the Ubuntu Samantha host, that assumption changed.

Mobile is useful for quick checks, approvals, and short feedback. It is not a
realistic primary surface for long, intense, or massive development work. The
real goal is not "a mobile bot for Codex." The real goal is a personal
development operations control plane where BK can talk naturally with Samantha
and Samantha can route safe work through deterministic gates.

## Company Model

Use this mental model when evaluating architecture decisions:

```text
BK
  = founder / final decision maker

Samantha CEO Conversation Layer
  = natural owner/CEO discussion surface for goals, feedback, tradeoffs,
    product direction, and decisions

Deterministic TypeScript Kernel
  = operating system for status, queues, approvals, reporting, schedules,
    memory gates, execution gates, and safety policy

LLM agents
  = executives, workers, reviewers, researchers, evaluators, or consultants called for bounded tasks
```

The conversation layer may use LLM judgment and retrieved memory to discuss and
plan. The TypeScript kernel owns state and operational authority. Conversation
memory improves continuity, but it does not grant runtime permission.

## Responsibility Split

The TypeScript kernel owns:

- task store
- run store
- action queue
- approval queue
- conversation memory write gate
- status reporting schedule
- safety policy validation
- writer cap
- audit log
- dispatch gates
- merge, push, and cleanup gates

LLM agents may produce:

- natural CEO turns and summaries
- status summaries
- issue analysis
- proposed next actions
- task decomposition
- review and evaluation reports
- report drafts
- questions, pushback, and tradeoff analysis for BK

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

The next MVP is the CEO turn loop:

1. Accept BK's natural language request.
2. Retrieve short-term context and durable conversation memory.
3. Understand intent, constraints, risk, priorities, and product direction.
4. Continue safe internal progress without exposing command choreography.
5. Stop at a useful CEO response, approval boundary, result, or local repair
   boundary.
6. Propose conversation memory updates when the turn changes future decisions.

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

The primary product surface should be Samantha's natural CEO conversation
surface. Telegram may carry compact fragments of that conversation, but
Telegram command spelling must not define the architecture.

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
- If an LLM must remember durable context, move that context into conversation
  memory or governed structured memory.
- If an LLM can dispatch, merge, push, cleanup, or mutate state directly, route that through the CEO office gates instead.
- If a workflow cannot produce a useful status report, the task model is not structured enough yet.
- If a mobile interaction requires long context review, move the interaction to CLI or dashboard and keep mobile for notification or approval.

## Practical Direction

Do not let Telegram implementation details define Samantha's core architecture.
Use the roadmap as the source of truth for current and future phases.

The previous command-driven user workflow contract has been retired after
dogfood. Rewrite future workflow playbooks around the CEO turn loop and memory
model, not around additional Telegram commands.
For the long-range roadmap, see [CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md).
For the current system contract, see [ARCHITECTURE.md](ARCHITECTURE.md).
For the remote adapter contract, see [REMOTE_ADAPTERS.md](REMOTE_ADAPTERS.md).
