# CEO Office Roadmap

Last updated: 2026-05-07

## Ultimate Goal

Build Samantha into BK's personal development operations control plane.

The target experience is:

```text
BK
  = founder, final decision maker

Deterministic CEO Office
  = durable operating system for work state, reporting, queues, approvals, schedules, safety gates, dispatch, and audit

Bounded LLM Agents
  = planners, synthesizers, reviewers, evaluators, researchers, content agents, operations agents, and coding agents called only for bounded work
```

Samantha should let BK periodically receive a clear company-style report:

- what finished
- what is active
- what is blocked
- what needs BK's decision
- what risks exist
- what Samantha recommends next

Samantha should then execute only the approved, safe next steps through deterministic gates. LLMs may propose and summarize, but durable state and operational authority stay in TypeScript code.

## Success Shape

Samantha is successful when BK can run real product work through one operating surface without personally tracking every worker, task id, run id, branch, and recovery path.

The stable product should support:

- periodic and on-demand CEO reports
- structured task, run, action, and decision state
- approval gates for risky or ambiguous work
- bounded LLM planning and synthesis
- role-aware specialist agents
- one safe writer at first, with parallel non-writers
- audit logs that explain what happened after the fact
- CLI and dashboard as the primary review surfaces
- Telegram as a compact notification and approval adapter

## Work Stages

### Stage 1: CEO Status Snapshot And Report

Goal: create the first useful CEO report from existing stores.

This stage should aggregate current state from task, run, action, orchestration, lifecycle, daemon, and diagnostics stores into one deterministic status snapshot. The report should make BK's next decision obvious without requiring internal ids.

Deliverables:

- canonical status snapshot type
- deterministic report formatter
- CLI command for the CEO report
- tests with empty, active, blocked, failed, and decision-needed states
- no new remote commands required

### Stage 2: BK Decision Queue

Goal: make "BK must decide" a first-class state instead of burying it in prose reports.

Deliverables:

- file-backed decision queue
- decision item contract
- create, list, resolve, and archive operations
- report section ordered before optional details
- deterministic rule that risky or unclear actions wait for a decision

### Stage 3: Dashboard And CLI Operating Surface

Goal: make the local/Tailscale operating surface useful for long review.

Deliverables:

- dashboard section for active work, blockers, decisions, and next action
- CLI report command suitable for daily use
- compact text output reusable by adapters
- no write controls in dashboard yet

### Stage 4: Bounded Orchestrator Calls

Goal: use LLMs only where judgment or language synthesis helps.

Deliverables:

- bounded planning calls for requests that need decomposition
- bounded synthesis calls for completed plans
- bounded question-drafting calls for ambiguous blockers
- deterministic validation before any output mutates state

### Stage 5: Role-Aware Specialist Agents

Goal: let Samantha choose specialist non-writer agents before or alongside a single writer.

Deliverables:

- codex-reviewer, codex-evaluator, and codex-spec report-only tasks
- writer tasks still serialized under writer cap `1`
- plan reports that explain role outcomes without raw ids
- no multi-writer execution until dogfood evidence supports it

### Stage 6: Recovery And Continuity

Goal: make failures recoverable without blind retries or state confusion.

Deliverables:

- failed-plan recovery context
- canonical repo-root recovery tasks
- stale task/archive rules
- reports that say whether recovery fixed the original problem

### Stage 7: Remote Notification And Approval Adapters

Goal: let BK receive and approve compact updates from mobile without turning mobile into the workspace.

Deliverables:

- Telegram report notification
- Telegram decision approval or redirect
- compact status checks
- no arbitrary shell commands, repo paths, or internal id workflows

### Stage 8: Host Automation And Periodic Reports

Goal: make the Ubuntu Samantha host operate continuously.

Deliverables:

- scheduled CEO report generation
- daemon health checks
- outbox delivery policy
- audit trail for generated reports and delivered notifications

### Stage 9: Parallelism Expansion By Evidence

Goal: expand only after the safety model proves itself.

Deliverables:

- parallel non-writer confidence
- explicit dogfood evidence before writer cap > 1
- merge and cleanup gates that remain deterministic
- documented rollback/recovery path

Evidence policy: `docs/PARALLELISM_EVIDENCE.md`. Stage 9 currently keeps the
writer cap at `1`; no multi-writer behavior is enabled.

## Stage 1 Implementation Plan

Stage 1 should be implemented first. It is the smallest slice that directly advances the ultimate goal without expanding Telegram.

### Assumptions

- Existing stores remain the source of truth: `state/tasks.jsonl`, `state/runs.jsonl`, `state/remote-actions.jsonl`, `state/orchestration-requests.jsonl`, `state/orchestrator-plans.jsonl`, `state/run-lifecycle.jsonl`, heartbeat, inbox, outbox, and diagnostics state.
- The first CEO report is read-only. It should not dispatch, approve, merge, push, cleanup, or mutate state.
- The first report can be deterministic. LLM synthesis can be added later after the structure is proven.
- Telegram can reuse the compact report later, but Stage 1 should target CLI and dashboard first.

### Proposed Files

Add:

- `src/lib/ceo-status.ts`
- `tests/ceo-status.test.ts`

Update:

- `src/samantha.ts`
- `src/lib/operator-reports.ts`
- `src/lib/dashboard.ts`
- `tests/operator-reports.test.ts`
- `tests/operations.test.ts`
- `docs/NEXT_PLAN.md`

### Data Model

Create a `CeoStatusSnapshot` type with at least:

```ts
interface CeoStatusSnapshot {
  generatedAt: string;
  overall: "idle" | "active" | "needs_decision" | "blocked" | "failed" | "needs_recovery";
  completed: CeoStatusItem[];
  active: CeoStatusItem[];
  blocked: CeoStatusItem[];
  needsDecision: CeoDecisionSummary[];
  risks: string[];
  nextAction: CeoNextAction;
}
```

Keep this model derived from existing records. Do not duplicate task or run data into another state file in Stage 1.

### Aggregation Rules

Build a pure function that accepts already-loaded records and returns `CeoStatusSnapshot`.

Initial rules:

- running, approved, waiting, and pending actions count as active work
- failed actions or failed plan synthesis create blocked or needs-recovery entries
- planned or question-status orchestrator plans create decision-needed entries
- pending orchestration requests create next action `/plan`
- passed runs with unmerged commits create next action for merge gate
- failed runs surface risk and recovery context
- no active work and no decisions means `overall: "idle"`

### Report Formatter

Add a deterministic formatter that prints:

```text
# ceo:status

Overall: needs_decision

Needs BK:
- ...

Active:
- ...

Blocked:
- ...

Completed:
- ...

Risks:
- ...

Next:
- ...
```

Order must be stable:

1. overall
2. BK decisions
3. active work
4. blockers/recovery
5. recent completed work
6. risks
7. next safe action

### CLI Command

Add:

```bash
bun run samantha ceo:status
```

The command should read existing stores and print the deterministic CEO report.

Optional flags:

- `--json` prints the raw `CeoStatusSnapshot`
- `--limit=<n>` limits completed/recent items

Do not add a Telegram command in this stage.

### Dashboard Integration

Add one read-only dashboard section for the same CEO status summary.

The dashboard should show:

- overall status
- BK decision count
- active work count
- blocked/recovery count
- next safe action

Keep dashboard write controls out of scope.

### Tests

Add focused tests for:

- empty state reports `idle`
- pending orchestration request recommends planning
- planned/questions orchestrator plan appears under `needsDecision`
- running/approved/waiting action appears under `active`
- failed action or failed synthesis appears under `blocked` or `needsRecovery`
- passed run with missing lifecycle merge appears as next integration action
- CLI command prints `# ceo:status`

Use existing portable test profile. Stage 1 should pass:

```bash
bun typecheck
bun run test:portable
bun run verify:docs
```

### Non-Goals

Do not build in Stage 1:

- new Telegram commands
- new dashboard write controls
- new worker dispatch behavior
- LLM-generated report prose
- multi-agent team construction
- writer concurrency changes
- a new database or framework

### Acceptance Criteria

Stage 1 is done when:

- `bun run samantha ceo:status` gives BK a useful report from real state files
- the report clearly separates active work, blocked work, completed work, BK decisions, risks, and next action
- tests cover the aggregation rules
- the implementation is read-only
- existing `/now`, `/check`, Telegram, dispatch, merge, and dashboard flows still work
- `bun typecheck`, `bun run test:portable`, and `bun run verify:docs` pass on Mac
