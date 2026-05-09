# CEO Office Roadmap

Last updated: 2026-05-09

## Purpose

This document is the long-range roadmap for Samantha's Deterministic CEO
Office. It should answer:

- where Samantha is going
- which product phase is current
- what must be true before moving to the next phase
- where detailed execution stages live

Detailed implementation stages do not belong in this roadmap. Each roadmap
phase gets its own execution document when that phase is reached.

Terminology:

- Roadmap phase: a major product maturity step toward the north star.
- Execution stage: the concrete stage list inside a phase-specific document.

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

Samantha should let BK periodically receive a clear company-style report:

- what finished
- what is active
- what is blocked
- what needs BK's decision
- what risks exist
- what Samantha recommends next

Samantha should then execute only approved, safe next steps through
deterministic gates. LLMs may propose and summarize, but durable state and
operational authority stay in TypeScript code.

North-star criteria are tracked in [NORTH_STAR.md](NORTH_STAR.md).

## Phase Documents

- Phase 1 execution spec: [MVP_IMPLEMENTATION.md](MVP_IMPLEMENTATION.md)
- Phase 2 execution spec: [MVP_HARDENING.md](MVP_HARDENING.md)
- Phase 3 execution spec:
  [OPERATING_SURFACE_CONSOLIDATION.md](OPERATING_SURFACE_CONSOLIDATION.md)
- Phase 4 execution spec:
  [PLANNING_AND_DELEGATION_MATURITY.md](PLANNING_AND_DELEGATION_MATURITY.md)
- North-star criteria: [NORTH_STAR.md](NORTH_STAR.md)

Future phase execution specs should be added only when Samantha reaches that
phase. Until then, this roadmap should keep those phases at objective and exit
criteria level.

## Roadmap

### 1. MVP Implementation

Status: implemented as the first Stage 1-9 MVP slice.

Objective: prove that a deterministic CEO Office can aggregate state, create
BK-facing reports, hold decisions, run bounded orchestration, dispatch safe
worker tasks, and notify BK without making Telegram the primary workspace.

Exit criteria:

- CEO status snapshot and report exist.
- BK decision queue exists.
- CLI and dashboard can show current operating state.
- Bounded orchestrator calls are validated before state mutation.
- Specialist report-only roles can be represented.
- Recovery context exists for failed plans and failed runs.
- Telegram is a compact notification and approval adapter.
- Ubuntu host automation can generate scheduled CEO reports.
- Writer cap remains `1`; non-writer parallelism has initial evidence.

Detailed stages: [MVP_IMPLEMENTATION.md](MVP_IMPLEMENTATION.md).

### 2. MVP Hardening

Status: implemented.

Objective: make the implemented MVP reliable enough for real daily dogfood.
This phase should reduce report noise, harden decision behavior, make
notifications idempotent, improve recovery clarity, and verify Ubuntu host
operation.

Exit criteria:

- CEO reports distinguish current actionable blockers from historical failures.
- Pending BK decisions are impossible to miss and safe to resolve remotely.
- Periodic notifications are idempotent and auditable.
- CLI and dashboard are useful for long review sessions.
- Recovery reports make the next safe action obvious.
- Ubuntu host automation diagnostics cover the CEO notification loop.
- Writer cap remains `1`; any parallelism expansion remains evidence-gated.

Detailed stages: [MVP_HARDENING.md](MVP_HARDENING.md).

### 3. Operating Surface Consolidation

Status: implemented.

Objective: make one operating surface feel like the real "CEO office" instead
of a collection of commands, files, dashboard pages, and Telegram messages.

Likely scope:

- unified daily review flow
- dashboard-first long review
- Telegram-first compact approval
- CLI as precise operator fallback
- consistent wording across report, dashboard, and Telegram adapters
- reduced reliance on raw ids for normal operation

Exit criteria:

- BK can understand current work from one surface in under a minute.
- Every displayed next action maps to a deterministic command or approval.
- Dashboard and Telegram present the same core state with different density.
- Internal ids remain available for audit, but are not required for routine use.

Detailed stages:
[OPERATING_SURFACE_CONSOLIDATION.md](OPERATING_SURFACE_CONSOLIDATION.md).

### 4. Planning And Delegation Maturity

Status: implemented.

Objective: improve bounded planning quality while keeping the deterministic CEO
Office in control of durable state and safety gates.

Likely scope:

- better request classification
- explicit plan alternatives and tradeoffs
- better worker task decomposition
- clearer prerequisite and dependency handling
- bounded synthesis of completed work
- bounded ambiguity-question drafting
- role-specific reviewer, evaluator, spec, research, content, operations, and
  coding profiles

Exit criteria:

- Samantha can create useful plans for ambiguous work without immediately
  dispatching unsafe tasks.
- Plan materialization remains deterministic and validated.
- Worker prompts are role-aware and narrow.
- Failed or incomplete plans produce actionable recovery paths.

Detailed stages:
[PLANNING_AND_DELEGATION_MATURITY.md](PLANNING_AND_DELEGATION_MATURITY.md).

### 5. Safety, Audit, And Governance

Status: planned.

Objective: make Samantha trustworthy for larger and riskier work by improving
traceability, policy enforcement, and post-fact review.

Likely scope:

- stronger safety policy contracts
- explicit risk classification
- richer audit trails for decisions, actions, runs, merges, pushes, and cleanup
- immutable event views
- operator review reports
- policy tests for dangerous transitions
- rollback and recovery drills

Exit criteria:

- A completed work item can be reconstructed from request to final state.
- Unsafe transitions are blocked before execution.
- BK can see who or what approved each risky transition.
- Recovery and rollback paths are documented and dogfooded.

Execution stages: write a phase-specific document when this phase begins.

### 6. Multi-Project Operations

Status: planned.

Objective: let Samantha manage multiple active projects without path drift,
state confusion, or cross-project safety leaks.

Likely scope:

- stronger project profile resolution
- project-level queues and reporting
- cross-project prioritization
- per-project safety policies
- shared host runtime without hard-coded local paths
- project-specific dashboards or filters

Exit criteria:

- BK can ask what matters across projects and get one ranked answer.
- Project state is isolated where needed and aggregated where useful.
- Remote commands cannot accidentally operate on the wrong project.
- Host runtime remains portable between Mac client and Ubuntu automation host.

Execution stages: write a phase-specific document when this phase begins.

### 7. Evidence-Based Parallelism Expansion

Status: planned.

Objective: expand parallel execution only when dogfood evidence proves that the
safety model can handle it.

Likely scope:

- stronger non-writer parallel reports
- evidence ledger for successful parallel runs
- conflict detection before considering writer cap changes
- merge queue and cleanup reliability
- explicit rollback plans
- possible writer cap increase only after evidence review

Exit criteria:

- Parallel non-writer work is routine and auditable.
- Writer cap changes have explicit evidence and BK approval.
- Merge and cleanup gates remain deterministic under higher load.
- Rollback behavior has been tested before any multi-writer enablement.

Evidence policy: [PARALLELISM_EVIDENCE.md](PARALLELISM_EVIDENCE.md).

Execution stages: write a phase-specific document when this phase begins.

### 8. Context And Knowledge Memory

Status: planned.

Objective: give Samantha durable project memory so BK does not have to restate
strategic context, product decisions, recurring preferences, or known risks.

Likely scope:

- durable project briefs
- decision history summaries
- recurring preference capture
- product strategy context
- searchable reports and artifacts
- bounded memory synthesis with deterministic write gates

Exit criteria:

- Samantha can cite prior decisions when planning new work.
- Memory updates are explicit, reviewable, and reversible.
- LLM-generated summaries cannot silently overwrite source-of-truth state.
- BK can ask why a recommendation was made and trace it to stored context.

Execution stages: write a phase-specific document when this phase begins.

### 9. Continuous 24/7 Operations

Status: planned.

Objective: make Samantha operate continuously with minimal manual host care.

Likely scope:

- robust host service installation and upgrades
- watchdog and self-diagnostics
- queue backpressure
- notification throttling
- backup and restore
- host migration notes
- failure-mode drills

Exit criteria:

- Samantha can run for long periods on the Ubuntu host without manual babysitting.
- Host failures produce actionable reports instead of silent stalls.
- State can be backed up, restored, and audited.
- BK can recover the system from another machine with documented steps.

Execution stages: write a phase-specific document when this phase begins.

### 10. North Star Achieved

Status: target.

Objective: Samantha functions as BK's personal development operations control
plane across planning, execution, reporting, recovery, and audit.

Exit criteria:

- BK can run real product work through Samantha without tracking worker ids,
  branches, run logs, or recovery paths manually.
- Samantha gives periodic company-style reports and asks for BK decisions only
  when needed.
- Deterministic gates own all durable state transitions.
- Bounded LLM agents improve judgment and communication without becoming the
  permanent orchestrator.
- Remote mobile use is practical because it is limited to reports, approvals,
  and compact checks.
- The system is safe enough to expand deliberately, and honest enough to stop
  when it cannot proceed safely.

Detailed criteria: [NORTH_STAR.md](NORTH_STAR.md).
