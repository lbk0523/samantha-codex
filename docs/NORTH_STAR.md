# North Star

Last updated: 2026-05-07

This document defines what it means for Samantha's Deterministic CEO Office to
reach the north star. It is not an implementation plan. Execution stages for the
north-star phase should be written when Samantha is close enough for those
stages to be actionable.

## Target Product

Samantha is BK's personal development operations control plane.

BK should be able to run real product work through Samantha without personally
tracking every worker, task id, run id, branch, or recovery path.

The durable operating authority is deterministic TypeScript code. LLMs are
bounded agents that help with planning, synthesis, review, evaluation, research,
content, operations, and coding, but they do not become the permanent CEO.

## Operating Model

BK:

- sets direction
- approves risky or ambiguous decisions
- receives periodic reports
- redirects priorities when needed

Deterministic CEO Office:

- owns durable state
- schedules reports
- manages queues
- validates plans
- gates dispatch, merge, push, cleanup, and recovery
- records audit history
- asks BK only when a decision is required

Bounded LLM Agents:

- handle scoped planning, synthesis, review, research, content, operations, and
  code tasks
- operate under explicit prompts and file scopes
- return structured results
- do not bypass deterministic safety gates

## Product Criteria

Samantha reaches the north star when all of the following are true:

- BK can inspect the state of work from one operating surface.
- Periodic CEO reports clearly explain finished work, active work, blockers,
  risks, required BK decisions, and recommended next actions.
- Mobile usage is practical because Telegram or another adapter is limited to
  compact reports, approvals, and status checks.
- Dashboard and CLI support long review and recovery without requiring BK to
  inspect raw state files.
- Risky, ambiguous, or irreversible actions require explicit approval.
- Planning and synthesis can use LLM judgment, but validated deterministic code
  owns state mutation.
- Worker execution is isolated, auditable, and recoverable.
- Multi-agent parallelism expands only after evidence supports it.
- Host automation can run continuously and reports its own failures.
- State can be backed up, restored, and audited.

## Non-Goals

The north star is not:

- a Telegram-first command bot
- a permanently running LLM conversation
- arbitrary remote shell access
- autonomous merging or pushing without deterministic gates
- multi-writer execution without dogfood evidence and explicit approval

## Readiness Questions

Before declaring the north star achieved, Samantha should be able to answer:

- What is BK waiting on?
- What is Samantha waiting on?
- What work completed since the last report?
- What failed, and what is the recovery path?
- What decision is needed before progress can continue?
- What did each agent do, and under what scope?
- What state changed, who approved it, and where is the audit record?
- What is the next safe action?
