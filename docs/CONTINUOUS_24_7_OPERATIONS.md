# Continuous 24/7 Operations

Last updated: 2026-05-10

Status: in progress.

This document contains the execution stages for roadmap Phase 9:
[Continuous 24/7 Operations](CEO_OFFICE_ROADMAP.md#9-continuous-247-operations).

Phase 9 begins after Phase 8 closed source-backed memory, decision history,
bounded memory synthesis, deterministic memory write gates, SOP/skill
boundaries, and the M11 memory approval CLI gap. Samantha can now cite stored
context while planning, but durable state, approval, dispatch, merge, push,
cleanup, recovery, and audit remain owned by the deterministic CEO Office.

The purpose of Phase 9 is to make Samantha safe to leave running for long
periods on the active automation host. It should reduce host babysitting,
prevent duplicate routine work, add deterministic pressure and budget stops,
and make backup, restore, and host migration auditable.

## Inputs From Previous Phases

- Phase 5 established governance taxonomy, dangerous transition risk policy,
  append-only governance events, cost/budget observations, rollback drills, and
  explicit deferral of routines and budget enforcement to Phase 9.
- Phase 6 established project profile identity, project -> goal -> work-item
  ancestry, project-isolated queues, cross-project ranking, host-local profile
  root resolution, and project/goal budget observation reporting without
  enforcement.
- Phase 7 established report-only parallelism, advisory role topology, merge
  and cleanup classification, rollback evidence, and writer-cap governance.
  `DEFAULT_SAFETY_POLICY.writerCap` remains `1`.
- Phase 8 established source-backed memory, project briefs, decision summaries,
  searchable context, bounded memory synthesis candidates, deterministic memory
  write gates, SOP/skill validation, and planning recommendation traces.
- Existing daemon operations include `inbox:watch`, `actions:watch`,
  `telegram:poll`, `telegram:reply`, `ceo:notify`, lock/heartbeat health
  checks, systemd and launchd templates, and `doctor` diagnostics.

## Assumptions

- Exactly one active automation host owns `state/`, `runs/`,
  `.samantha-worktrees/`, dashboard runtime output, and host runtime services.
- Client machines may edit, test, commit, and push normal repo code, but must
  not run Samantha daemon, watch, poll, reply, worker dispatch, dashboard
  runtime, systemd timers, or launchd agents.
- Routine triggers are work-intake signals only. They may create deterministic
  requests or pending review items after gates pass, but they cannot dispatch,
  merge, push, cleanup, recover, or approve work by themselves.
- Budget enforcement must use deterministic records and policies. Unknown cost
  remains unknown and must not be treated as zero.
- Memory may inform routine and budget decisions as context only. Memory,
  SOPs, or skills cannot override safety, approval, dispatch, worktree, merge,
  push, cleanup, recovery, budget, routine, connector, secret, or project gates.
- Host hardening work that changes daemon/watch/poll/reply/service-template
  behavior requires host-aware tests and active-automation-host verification.

## Non-Scope

- No writerCap increase.
- No multi-writer execution.
- No self-organizing agent teams.
- No arbitrary remote shell, repo path, or internal-id operation through remote
  adapters.
- No direct worker dispatch from routine, schedule, webhook, or API triggers.
- No LLM-owned durable state mutation, scheduling, approval, budget, backup, or
  recovery authority.
- No connector or secret expansion unless a later governed capability stage
  explicitly adds it with approval and tests.
- No provider billing API integration until deterministic local budget gates are
  proven against existing audit records.
- No destructive self-healing: merge, push, cleanup, restore, recovery, and host
  migration remain explicit deterministic gates.
- No cross-host active-active runtime. A migration may hand off ownership, but
  exactly one automation host is active at a time.

## Authority Rules

- Schedule and routine records are context and intake policy, not execution
  authority.
- Trigger fingerprints must coalesce duplicate live work before any request,
  plan, task, or action can be created.
- Backpressure and budget gates may block or defer new work, but they must leave
  actionable reports and audit events.
- Host watchdogs may report, restart through the service manager where already
  configured, or ask BK for intervention. They must not silently delete state,
  rewrite history, clean worktrees, merge, push, or migrate hosts.
- Backups and restores must be manifest-based, auditable, and verified before
  a restored state is considered active.

## M1: Baseline And Phase Spec

Goal: open Phase 9 with a phase-specific execution document and roadmap link
before changing runtime behavior.

Focus:

- create this Phase 9 execution document
- link it from the roadmap phase document list and Phase 9 section
- move Phase 9 roadmap status to `in progress`
- incorporate Phase 5/6/7/8 handoff notes and current daemon operations
- define stage sequence and verification expectations
- prepare handoff prompts that can be copied into separate Codex sessions

Verification focus:

- roadmap links to this execution document
- Phase 9 status is `in progress`
- no runtime behavior changes in this stage
- all future stages have explicit Goal, Focus, Verification focus, and Outcome
  placeholders
- `bun run verify:docs` passes

Outcome:

- Created the Phase 9 execution document and linked it from the roadmap phase
  document list and the Phase 9 roadmap section.
- Marked Phase 9 `in progress` in both the roadmap and this execution document.
- Incorporated the Phase 5/6/7/8 handoff boundaries: routines, host lifecycle,
  queue pressure, budget enforcement, backup/restore, and host migration belong
  to Phase 9; memory, SOPs, skills, role topology, project profiles, and budget
  observations remain advisory or audit inputs only.
- Captured the existing daemon baseline for future stages: `inbox:watch`,
  `actions:watch`, `telegram:poll`, `telegram:reply`, `ceo:notify`,
  lock/heartbeat health checks, `doctor`, and systemd/launchd templates.
- Defined M2-M10 with explicit Goal, Focus, Verification focus, and Outcome
  placeholders plus copyable handoff prompts.
- Left runtime authority unchanged: no source code, tests, runtime state,
  daemon/watch/poll/reply/dispatch behavior, service templates, merge, push,
  cleanup, recovery, connector/secret access, routines, budget enforcement, or
  `DEFAULT_SAFETY_POLICY.writerCap` changes were made in M1.

## M2: Host Runtime Inventory And Ownership Contract

Goal: make the active automation host contract explicit and machine-checkable
before adding new continuous behavior.

Focus:

- inventory current runtime files, services, timers, state roots, run roots,
  worktree roots, dashboard output, and host-local env requirements
- define a durable host ownership record or diagnostic view that distinguishes
  active host, client machine, stale host, and unknown host states
- make cross-OS path expectations explicit without committing local absolute
  paths
- surface host ownership and runtime prerequisites in `doctor`, `/problems`, or
  equivalent diagnostics
- keep runtime processes unchanged in this stage unless the stage explicitly
  adds read-only diagnostics

Verification focus:

- diagnostics can tell whether the current machine is allowed to run automation
- missing, stale, or conflicting host ownership produces actionable failures
- Mac client and Ubuntu/WSL host path rules remain portable
- no daemon, watch, poll, reply, dispatch, dashboard runtime, merge, push, or
  cleanup behavior changes without tests

Outcome:

- Added a minimal read-only host ownership diagnostic to `ops:doctor` and the
  Telegram `/problems` path through `collectOpsSnapshot`.
- Defined host ownership state as `active`, `client`, `stale`, or `unknown`
  from host-local `state/host-ownership.json` plus the current host id
  (`SAMANTHA_HOST_ID` or OS hostname).
- Documented the host ownership record shape, cross-OS host id behavior, and
  runtime file inventory in daemon operations docs without committing local
  absolute paths.
- Added focused tests proving diagnostics distinguish active host, client
  machine, stale ownership, and unknown ownership states.
- Left runtime behavior unchanged: no services were started, no workers were
  dispatched, no routines or budget enforcement were added, no merge/push/
  cleanup/recovery behavior changed, and `DEFAULT_SAFETY_POLICY.writerCap`
  remains `1`.

## M3: Watchdog And Self-Diagnostics Hardening

Goal: make host failures visible and actionable before Samantha depends on more
continuous loops.

Focus:

- harden lock, heartbeat, service-template, Telegram poll/reply, CEO notify,
  inbox, action queue, and dashboard diagnostics
- classify failures by severity: stale, blocked, degraded, needs BK, and unsafe
  to continue
- emit compact BK-facing reports for host failures without leaking secrets
- add stale service and missing timer detection for the active host provider
- keep watchdog behavior report-first; do not add destructive self-healing

Verification focus:

- stale heartbeat, missing lock, dead pid, missing service templates, stuck
  inbox, and reply failures produce deterministic diagnostics
- diagnostics do not print secret values
- compact reports point to safe next commands
- host-owned behavior changes are covered by host tests or explicit host
  verification notes

Outcome:

- Added deterministic watchdog issue records with severity, area, message, and
  next safe action. Severities are `stale`, `blocked`, `degraded`, `needs_bk`,
  and `unsafe_to_continue`.
- Classified stale heartbeat, missing lock, dead heartbeat/lock pid, missing
  service templates or timers, stuck inbox files, Telegram reply failures, host
  ownership problems, and missing local env prerequisites in `doctor` and
  `/problems` diagnostics.
- Added oldest pending inbox age diagnostics with a configurable
  `--max-pending-inbox-age-ms` threshold for `doctor`.
- Redacted known token/secret patterns from Telegram reply failure diagnostics
  and compact doctor reports.
- Kept watchdog behavior report-first only: no services were started or
  stopped, no workers were dispatched, and no merge, push, cleanup, restore, or
  migration behavior was added.

## M4: Queue Backpressure And Admission Policy

Goal: prevent continuous operation from accepting more work than Samantha can
audit, dispatch, or report safely.

Focus:

- define queue pressure metrics for orchestration requests, pending decisions,
  task drafts, tasks, remote actions, running actions, failed plans, run
  lifecycle gaps, outbox backlog, and budget audit gaps
- add deterministic pressure classes such as normal, watch, defer, block, and
  needs BK
- make admission policy decide whether new requests, routine triggers, and
  actions are accepted, deferred, or blocked
- report pressure and deferrals in CEO status, dashboard, Telegram, or CLI
- do not change writer concurrency or dispatch gates

Verification focus:

- pressure calculation is deterministic and project-aware where possible
- overloaded queues defer or block new intake without losing the requested work
- pending BK decisions and recovery blockers outrank routine intake
- deferred work leaves an audit-visible reason
- `writerCap` remains `1`

Outcome:

- Added deterministic queue pressure metrics for pending orchestration
  requests, deferred requests, pending BK decisions, task drafts, active
  tasks/actions, running actions, failed plans, recovery needs, failed runs,
  run lifecycle gaps, remote outbox/inbox backlog, budget audit gaps, and
  unsafe host issues.
- Added pressure classes `normal`, `watch`, `defer`, `block`, and `needs_bk`
  plus an admission policy for request, recovery request, routine trigger, and
  action subjects. Pending BK decisions ask BK or defer intake; recovery and
  unsafe-host blockers stop routine/action progress before routine intake can
  advance.
- Persisted admission evidence on orchestration requests and remote actions so
  deferred or blocked work remains in state with a deterministic reason instead
  of being dropped or silently approved.
- Surfaced pressure and admission reasons through project queue formatting,
  CEO status, operator status reports, and remote request/action reports.
- Applied admission checks to new orchestration requests, recovery/revision
  request intake, planning of pending requests, action preparation, plan
  materialization action creation, and direct action approval. No dispatch,
  merge, push, cleanup, or recovery authority was expanded.
- Added focused tests for project-aware pressure, routine admission blocking,
  CEO/operator pressure reporting, deferred remote intake preserving pending BK
  decisions, and `DEFAULT_SAFETY_POLICY.writerCap` remaining `1`.

## M5: Routine Trigger Contract And Fingerprint Coalescing

Goal: define routine triggers as deterministic, reviewable work-intake records
that cannot create duplicate live work for the same fingerprint.

Focus:

- define routine records for schedule-like, webhook-like, and API-like triggers
  without adding external connector authority
- require stable trigger ids, project scope, source evidence, enabled status,
  risk class, and deterministic fingerprint inputs
- build fingerprint coalescing across active requests, plans, tasks, actions,
  and unresolved decisions
- treat duplicate triggers as coalesced observations, not new live work
- route behavior-changing routine activation through governed approval

Verification focus:

- identical trigger fingerprints do not create duplicate active work
- routine activation is governed and auditable
- routine records cannot override safety, project, approval, dispatch, budget,
  connector, secret, merge, push, cleanup, or recovery gates
- disabled or stale routines do not enqueue work

Outcome:

- Pending.

## M6: Routine Intake Through Existing Gates

Goal: allow approved routine triggers to create bounded work-intake records
only through the existing request, planning, approval, and materialization
pipeline.

Focus:

- convert accepted routine trigger observations into orchestration requests or
  pending review items, not tasks or dispatch actions
- require project ancestry and safe default scope before planning
- make routine-created requests visible in queues, reports, and audit trails
- preserve BK approval requirements for plans, risky transitions, and
  materialization
- keep routine execution unable to run workers directly

Verification focus:

- routine intake creates at most one active request per live fingerprint
- `/plan`, `/approve`, `/go`, dispatch, merge, push, cleanup, and recovery
  gates behave the same for routine-created work as for manual work
- routine-created work is project-scoped and audit-linked
- ambiguous routine requests become questions or blockers, not speculative
  tasks

Outcome:

- Pending.

## M7: Notification Throttling And Digest Policy

Goal: reduce notification noise during continuous operation without hiding
urgent decisions, failures, or unsafe states.

Focus:

- define deterministic throttling keys for repeated CEO reports, Telegram
  replies, host failure reports, budget pressure, queue pressure, and routine
  coalescing
- distinguish suppressible repeats from urgent new information
- add digest windows for routine low-risk updates
- ensure pending BK decisions, failed plans, unsafe host state, and budget
  blocks are never silently swallowed
- preserve outbox and delivery audit records

Verification focus:

- repeated low-risk notifications coalesce into digest records
- urgent changes bypass throttling with clear reasons
- outbox delivery state remains auditable and idempotent
- throttling does not approve, reject, dispatch, merge, push, cleanup, recover,
  or mutate source-of-truth work state

Outcome:

- Pending.

## M8: Deterministic Budget Enforcement Gates

Goal: turn existing cost/budget observations into deterministic block or defer
decisions without hidden LLM judgment.

Focus:

- define budget policy records for project, goal, work item, run, action, and
  model/provider scopes
- distinguish measured, estimated, and unknown cost in enforcement logic
- add deterministic budget states such as ok, watch, defer, block, and needs BK
- require explicit approval for budget policy activation or expansion
- block or defer intake/dispatch when deterministic limits require it, while
  leaving reports and audit events
- keep provider billing reconciliation out of scope unless local gates are
  already proven

Verification focus:

- unknown cost is never treated as zero
- budget enforcement can block or defer work through deterministic policy
- budget blocks are visible in CEO status, dashboard, Telegram, and audit
  records where appropriate
- budget policy cannot override safety, approval, project, dispatch, merge,
  push, cleanup, recovery, connector, or secret gates

Outcome:

- Pending.

## M9: Backup, Restore, And Host Migration Drills

Goal: make operational state recoverable and auditable before Samantha is
treated as a durable always-on system.

Focus:

- define backup manifests for state records, run logs, lifecycle records,
  outbox/inbox archives, dashboard artifacts, project profiles, and governance
  evidence
- distinguish portable repo state from host-owned runtime output and
  uncommitted worker worktrees
- add restore validation that checks schema, duplicate ids, ancestry,
  governance event integrity, budget records, and run lifecycle consistency
- document active-host handoff and stale-host shutdown steps
- dogfood migration or restore drills without activating two hosts at once

Verification focus:

- backup manifests can be generated deterministically
- restore validation catches missing files, malformed records, duplicate ids,
  and stale host ownership
- migration docs prevent active-active host operation
- restore does not merge, push, cleanup, dispatch, approve, or rewrite history
  by itself

Outcome:

- Pending.

## M10: Long-Run Dogfood, Failure Drills, And Exit Review

Goal: close Phase 9 only after Samantha has demonstrated continuous operation
with deterministic stops, recovery reports, and auditable host state.

Focus:

- run long-duration host dogfood on the active automation host
- exercise queue pressure, routine coalescing, budget block/defer, watchdog,
  notification throttling, backup, restore, and migration drills
- verify that routine and budget gates use memory only as context and cannot
  override safety or approval gates
- update architecture, daemon operations, remote adapter, and roadmap docs only
  for implemented behavior
- write the Phase 9 exit review

Verification focus:

- Samantha can run for long periods without manual babysitting
- host failures produce actionable reports instead of silent stalls
- routine triggers do not create duplicate active work for the same live
  fingerprint
- budget and queue pressure can stop or defer work through deterministic policy
- state can be backed up, restored, and audited
- BK can recover or migrate the system from another machine with documented
  steps
- `writerCap` remains `1`
- `bun run verify:docs`, `bun run verify:mac`, and host verification pass where
  host-owned behavior was touched

Outcome:

- Pending.

## Stage Handoff Prompts

Use these prompts to hand each stage to a separate Codex session. Each prompt
assumes the session starts from the repository root.

Before working on any stage, check `git status --short`, do not revert
unrelated user changes, and keep runtime authority unchanged unless the stage
explicitly implements a deterministic gate with tests. Confirm all previous
stage Outcome sections before editing. If a previous Outcome is still a
placeholder, treat it as a blocker and ask BK whether to proceed.

### M1 Prompt

Perform Phase 9 M1 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/NORTH_STAR.md`, `docs/ARCHITECTURE.md`,
`docs/DAEMON_OPERATIONS.md`, `docs/REMOTE_ADAPTERS.md`,
`docs/SAFETY_AUDIT_GOVERNANCE.md` Phase 9 handoff notes,
`docs/MULTI_PROJECT_OPERATIONS.md` Phase 9 handoff notes,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` Phase 9 references,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` Phase 9 handoff notes,
`src/lib/daemon.ts`, `src/lib/cost-budget-audit.ts`, `src/samantha.ts`,
`tests/daemon.test.ts`, `tests/ops-diagnostics.test.ts`, and
`tests/cost-budget-audit.test.ts`. 이전 stage Outcome을 확인하라. For M1,
there are no previous Phase 9 stage Outcomes, so verify Phase 5-8 exit reviews
and handoff notes instead.

Create or refine the Phase 9 execution document, link it from the roadmap
phase document list and Phase 9 section, and mark Phase 9 `in progress`. M1 is
docs and roadmap only. Do not change runtime behavior, source code, tests,
state, runs, daemon/watch/poll/reply/dispatch services, merge, push, cleanup,
recovery, connector or secret access, budgets, routines, or
`DEFAULT_SAFETY_POLICY.writerCap`. Run `bun run verify:docs`.

### M2 Prompt

Implement Phase 9 M2 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTINUOUS_24_7_OPERATIONS.md` through M2, all previous Phase 9 stage
Outcome sections, `docs/DAEMON_OPERATIONS.md`, `docs/ARCHITECTURE.md`,
`src/lib/daemon.ts`, `src/lib/ops-diagnostics.ts` if present,
`src/samantha.ts`, `tests/daemon.test.ts`, `tests/ops-diagnostics.test.ts`,
and service templates under `ops/systemd` and `ops/launchd`.
이전 stage Outcome을 확인하라.

Make the active automation host contract explicit and machine-checkable. Add
only the smallest read-only diagnostic or record shape needed to distinguish
active host, client machine, stale host, and unknown host states. Do not start
services, dispatch workers, create routines, enforce budgets, merge, push,
cleanup, recover, or change writer authority from this stage.

### M3 Prompt

Implement Phase 9 M3 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTINUOUS_24_7_OPERATIONS.md` through M3, all previous Phase 9 stage
Outcome sections, `docs/DAEMON_OPERATIONS.md`, `src/lib/daemon.ts`,
`src/lib/operator-reports.ts`, `src/samantha.ts`, `tests/daemon.test.ts`,
`tests/ops-diagnostics.test.ts`, `tests/operator-reports.test.ts`, and the
systemd/launchd templates. 이전 stage Outcome을 확인하라.

Harden watchdog and self-diagnostics so host failures become actionable
reports. Cover stale heartbeats, missing locks, dead pids, missing service
templates, stuck inboxes, Telegram reply failures, and secret-redaction. Keep
watchdog behavior report-first; do not add destructive self-healing, direct
dispatch, merge, push, cleanup, restore, or migration.

### M4 Prompt

Implement Phase 9 M4 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTINUOUS_24_7_OPERATIONS.md` through M4, all previous Phase 9 stage
Outcome sections, `src/lib/ceo-status.ts`, `src/lib/project-queues.ts`,
`src/lib/operator-reports.ts`, `src/lib/orchestrator-store.ts`,
`src/lib/decision-store.ts`, `src/lib/remote-action-store.ts`,
`tests/ceo-status.test.ts`, `tests/project-queues.test.ts`,
`tests/operator-reports.test.ts`, and `tests/remote-approval.test.ts`.
이전 stage Outcome을 확인하라.

Add deterministic queue backpressure and admission policy. Pressure may accept,
defer, block, or ask BK, but must not lose work or create hidden approval.
Pending BK decisions, failed-plan recovery, and unsafe host state must outrank
routine intake. Keep `writerCap` at `1` and do not change dispatch, merge,
push, cleanup, or recovery authority.

### M5 Prompt

Implement Phase 9 M5 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTINUOUS_24_7_OPERATIONS.md` through M5, all previous Phase 9 stage
Outcome sections, `src/lib/governance-taxonomy.ts`,
`src/lib/risk-policy.ts`, `src/lib/governance-event-store.ts`,
`src/lib/orchestrator-store.ts`, `src/lib/decision-store.ts`,
`tests/governance-taxonomy.test.ts`, `tests/risk-policy.test.ts`,
`tests/governance-event-store.test.ts`, and nearby store validation tests.
이전 stage Outcome을 확인하라.

Define the deterministic routine trigger contract and fingerprint coalescing.
Routine triggers are intake records only; they cannot dispatch, approve, merge,
push, cleanup, recover, bypass project gates, or expand connector/secret
authority. Duplicate fingerprints must coalesce instead of creating duplicate
active work. Add focused tests.

### M6 Prompt

Implement Phase 9 M6 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTINUOUS_24_7_OPERATIONS.md` through M6, all previous Phase 9 stage
Outcome sections, `src/lib/orchestrator-store.ts`,
`src/lib/orchestrator-agent.ts`, `src/lib/orchestrator-materializer.ts` if
present, `src/lib/project-profile.ts`, `src/lib/project-queues.ts`,
`src/samantha.ts`, `tests/orchestrator-planning-baseline.test.ts`,
`tests/orchestrator-materializer.test.ts`, `tests/remote-project-selection.test.ts`,
and routine tests added in M5. 이전 stage Outcome을 확인하라.

Route approved routine trigger observations through existing request,
planning, approval, and materialization gates. Routine-created work may become
an orchestration request or pending review item only. It must not create tasks,
approve plans, approve actions, dispatch workers, or advance merge/push/cleanup
directly. Preserve project ancestry and fingerprint audit links.

### M7 Prompt

Implement Phase 9 M7 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTINUOUS_24_7_OPERATIONS.md` through M7, all previous Phase 9 stage
Outcome sections, `src/lib/operator-reports.ts`, `src/lib/ceo-report-store.ts`,
`src/lib/telegram-reply-store.ts` if present, `src/samantha.ts`,
`tests/operator-reports.test.ts`, `tests/ceo-status.test.ts`,
`tests/telegram-adapter.test.ts`, and `tests/operating-surface.test.ts`.
이전 stage Outcome을 확인하라.

Add deterministic notification throttling and digest policy. Throttling may
coalesce repeated low-risk notifications, but urgent decisions, failures,
unsafe host state, and budget/queue blocks must remain visible. Preserve outbox
and delivery audit records. Do not use throttling to approve, reject, dispatch,
merge, push, cleanup, recover, or mutate work state.

### M8 Prompt

Implement Phase 9 M8 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTINUOUS_24_7_OPERATIONS.md` through M8, all previous Phase 9 stage
Outcome sections, `docs/SAFETY_AUDIT_GOVERNANCE.md` G6 and Phase 9 notes,
`docs/MULTI_PROJECT_OPERATIONS.md` M7 and Phase 9 notes,
`src/lib/cost-budget-audit.ts`, `src/lib/risk-policy.ts`,
`src/lib/governance-event-store.ts`, `src/lib/ceo-status.ts`,
`src/lib/operator-reports.ts`, `tests/cost-budget-audit.test.ts`,
`tests/risk-policy.test.ts`, `tests/governance-event-store.test.ts`, and
`tests/operator-reports.test.ts`. 이전 stage Outcome을 확인하라.

Turn existing budget observations into deterministic enforcement gates.
Unknown cost must not be treated as zero. Budget policy activation or expansion
requires explicit governance evidence. Budget gates may block or defer intake
or dispatch, but cannot override safety, approval, project, merge, push,
cleanup, recovery, connector, or secret gates. Do not add provider billing API
integration unless local deterministic gates are already proven.

### M9 Prompt

Implement Phase 9 M9 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTINUOUS_24_7_OPERATIONS.md` through M9, all previous Phase 9 stage
Outcome sections, `docs/DAEMON_OPERATIONS.md`,
`docs/ROLLBACK_AND_RECOVERY_DRILLS.md`, `src/lib/governance-event-store.ts`,
`src/lib/ancestry.ts`, state store modules for decisions, plans, tasks,
actions, runs, lifecycle, reports, memory, budget, and tests covering malformed
state or recovery drills. 이전 stage Outcome을 확인하라.

Add backup, restore, and host migration drills. Backups must use manifests and
restore validation must catch malformed records, duplicate ids, broken
ancestry, governance gaps, and stale host ownership. Migration must prevent
active-active host operation. Restore must not dispatch, approve, merge, push,
cleanup, recover, or rewrite history by itself.

### M10 Prompt

Perform Phase 9 M10 from `docs/CONTINUOUS_24_7_OPERATIONS.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
all of `docs/CONTINUOUS_24_7_OPERATIONS.md`, every previous Phase 9 stage
Outcome section, `docs/NORTH_STAR.md`, `docs/ARCHITECTURE.md`,
`docs/DAEMON_OPERATIONS.md`, `docs/REMOTE_ADAPTERS.md`,
`docs/SAFETY_AUDIT_GOVERNANCE.md`, `docs/MULTI_PROJECT_OPERATIONS.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`, all routine/backpressure/budget/backup
files and tests added by M2-M9, and host verification scripts. 이전 stage
Outcome을 확인하라.

Close Phase 9 only after long-run dogfood and failure drills prove continuous
operation is safe. Exercise host watchdogs, queue pressure, routine
coalescing, notification throttling, budget block/defer, backup/restore, and
host migration. Update roadmap, architecture, daemon operations, remote adapter
docs, and exit review only for implemented behavior. Keep `writerCap` at `1`,
do not add multi-writer execution, and do not expand connector/secret
authority. Run `bun run verify:docs`, `bun run verify:mac`, and host
verification when host-owned behavior was touched on the active automation
host.
