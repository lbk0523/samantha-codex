# MVP Implementation

Last updated: 2026-05-07

This document contains the execution stages for roadmap Phase 1:
[MVP Implementation](CEO_OFFICE_ROADMAP.md#1-mvp-implementation).

The MVP proved the first useful deterministic CEO Office slice. It did not
attempt to complete the full north-star product.

## Stage 1: CEO Status Snapshot And Report

Goal: create the first useful CEO report from existing stores.

This stage aggregates current state from task, run, action, orchestration,
lifecycle, daemon, and diagnostics stores into one deterministic status
snapshot. The report should make BK's next decision obvious without requiring
internal ids.

Deliverables:

- canonical status snapshot type
- deterministic report formatter
- CLI command for the CEO report
- tests with empty, active, blocked, failed, and decision-needed states
- no new remote commands required

## Stage 2: BK Decision Queue

Goal: make "BK must decide" a first-class state instead of burying it in prose
reports.

Deliverables:

- file-backed decision queue
- decision item contract
- create, list, resolve, and archive operations
- report section ordered before optional details
- deterministic rule that risky or unclear actions wait for a decision

## Stage 3: Dashboard And CLI Operating Surface

Goal: make the local/Tailscale operating surface useful for long review.

Deliverables:

- dashboard section for active work, blockers, decisions, and next action
- CLI report command suitable for daily use
- compact text output reusable by adapters
- no write controls in dashboard yet

## Stage 4: Bounded Orchestrator Calls

Goal: use LLMs only where judgment or language synthesis helps.

Deliverables:

- bounded planning calls for requests that need decomposition
- bounded synthesis calls for completed plans
- bounded question-drafting calls for ambiguous blockers
- deterministic validation before any output mutates state

## Stage 5: Role-Aware Specialist Agents

Goal: let Samantha choose specialist non-writer agents before or alongside a
single writer.

Deliverables:

- codex-reviewer, codex-evaluator, and codex-spec report-only tasks
- writer tasks still serialized under writer cap `1`
- plan reports that explain role outcomes without raw ids
- no multi-writer execution until dogfood evidence supports it

## Stage 6: Recovery And Continuity

Goal: make failures recoverable without blind retries or state confusion.

Deliverables:

- failed-plan recovery context
- canonical repo-root recovery tasks
- stale task/archive rules
- reports that say whether recovery fixed the original problem

## Stage 7: Remote Notification And Approval Adapters

Goal: let BK receive and approve compact updates from mobile without turning
mobile into the workspace.

Deliverables:

- Telegram report notification
- Telegram decision approval or redirect
- compact status checks
- no arbitrary shell commands, repo paths, or internal id workflows

## Stage 8: Host Automation And Periodic Reports

Goal: make the Ubuntu Samantha host operate continuously.

Deliverables:

- scheduled CEO report generation
- daemon health checks
- outbox delivery policy
- audit trail for generated reports and delivered notifications

## Stage 9: Parallelism Expansion By Evidence

Goal: expand only after the safety model proves itself.

Deliverables:

- parallel non-writer confidence
- explicit dogfood evidence before writer cap > 1
- merge and cleanup gates that remain deterministic
- documented rollback/recovery path

Evidence policy: [PARALLELISM_EVIDENCE.md](PARALLELISM_EVIDENCE.md). Stage 9
currently keeps the writer cap at `1`; no multi-writer behavior is enabled.

## Stage 1 Implementation Notes

The MVP began with Stage 1 because it was the smallest slice that directly
advanced the ultimate goal without expanding Telegram.

Assumptions:

- Existing stores remain the source of truth: `state/tasks.jsonl`,
  `state/runs.jsonl`, `state/remote-actions.jsonl`,
  `state/orchestration-requests.jsonl`, `state/orchestrator-plans.jsonl`,
  `state/run-lifecycle.jsonl`, heartbeat, inbox, outbox, and diagnostics state.
- The first CEO report is read-only. It should not dispatch, approve, merge,
  push, cleanup, or mutate state.
- The first report can be deterministic. LLM synthesis can be added later after
  the structure is proven.
- Telegram can reuse the compact report later, but Stage 1 should target CLI
  and dashboard first.

Initial aggregation rules:

- running, approved, waiting, and pending actions count as active work
- failed actions or failed plan synthesis create blocked or needs-recovery
  entries
- planned or question-status orchestrator plans create decision-needed entries
- pending orchestration requests create next action `/plan`
- passed runs with unmerged commits create next action for merge gate
- failed runs surface risk and recovery context
- no active work and no decisions means `overall: "idle"`

Report order:

1. overall
2. BK decisions
3. active work
4. blockers/recovery
5. recent completed work
6. risks
7. next safe action
