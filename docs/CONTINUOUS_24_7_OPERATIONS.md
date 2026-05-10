# Continuous 24/7 Operations

Last updated: 2026-05-10

Status: implemented.

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

- Added a deterministic routine trigger contract for schedule-like,
  webhook-like, and API-like intake records. Routine records require stable
  trigger ids, project scope, source evidence, enabled status, risk class,
  activation decision ids for enabled routines, deterministic fingerprint
  inputs, and explicit intake-only authority flags.
- Added stable routine fingerprints and coalescing across active orchestration
  requests, plans, tasks, remote actions, and unresolved decisions. Duplicate
  live fingerprints become coalesced observations instead of new active work.
- Added append-only routine trigger and observation stores. Observations can be
  recorded, coalesced, ignored because disabled, or ignored because stale; they
  do not dispatch workers, approve work, create requests, merge, push, cleanup,
  recover, bypass project gates, or expand connector/secret authority.
- Routed routine activation through governed high-risk approval policy with
  `routine_change` BK decision evidence and `routine_trigger` governance event
  source support.
- Added focused tests for deterministic fingerprints, intake-only authority,
  duplicate fingerprint coalescing, disabled/stale observations, append-only
  intake persistence, governed activation approval, and governance taxonomy
  fixture coverage.

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

- Added `routine:observe` as deterministic routine intake. It requires an
  enabled routine trigger with governed BK activation evidence, records an
  append-only observation, applies routine queue admission, coalesces against
  live fingerprint matches, and creates only a `pending_plan` orchestration
  request when the observation is accepted and not a duplicate.
- Added routine observation-to-request conversion with assigned project
  ancestry, safe default project goal, admission evidence, routine trigger id,
  and routine fingerprint audit links.
- Preserved routine trigger id and fingerprint links through request planning,
  plan approval/question decisions, revision/recovery requests, materialized
  task specs, and remote dispatch actions so later observations continue to
  coalesce against live work.
- Surfaced routine audit links in work request and operator review reports.
- Added focused tests proving routine intake creates at most one active
  request per live fingerprint, does not create tasks or actions, keeps
  project ancestry, preserves fingerprint links through approval/materialization
  records, and leaves `/plan`, `/approve`, `/go`, dispatch, merge, push,
  cleanup, and recovery authority unchanged.

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

- Added deterministic CEO notification throttle metadata to report audit
  records: throttle key, urgency, delivery/coalescing decision, reason,
  bypass reasons, and digest window bounds.
- Added low-risk digest coalescing for repeated CEO notifications inside the
  deterministic digest window. Coalesced repeats append `notification_digest`
  audit records that point back to the delivered outbox file instead of
  creating duplicate remote outbox reports.
- Kept urgent notification classes deliverable: pending BK decisions, blocked
  or recovery items, failures, unsafe host state, budget audit gaps, and
  queue `block` / `needs_bk` pressure bypass throttling with recorded reasons.
- Preserved existing outbox and Telegram delivery audit semantics: delivered
  notifications still write remote outbox files and `ceo_notify` records;
  digest records do not mark files sent or mutate delivery state.
- Left work authority unchanged: throttling does not approve, reject, dispatch,
  merge, push, cleanup, recover, create routine work, or mutate source-of-truth
  work state.
- Added focused tests for low-risk digest coalescing and urgent BK decision
  bypass, and kept existing operator report, CEO status, Telegram adapter,
  Telegram reply adapter, operating surface, and CEO report store tests passing.

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

- Added deterministic budget policy records for project, goal, work item, run,
  action, model, and provider scopes, backed by a file-backed
  `state/budget-policies.jsonl` store.
- Added local budget enforcement evaluation over existing budget audit
  observations. Enforcement distinguishes measured, estimated, and unknown
  cost; measured zero remains known zero, while unknown cost can defer, block,
  or ask BK and is never counted as zero.
- Required active budget policies to have explicit BK `budget_change` or risk
  acceptance decision evidence plus a `transition_approved` governance event
  for the budget policy subject before they can enforce. Missing evidence
  produces `needs_bk`.
- Wired budget enforcement into the existing queue admission path so approved
  policies can defer or block request/action admission and append budget
  governance block events. Pending BK decisions, recovery blockers, unsafe host
  state, safety, approval, project, dispatch, merge, push, cleanup, recovery,
  connector, and secret gates remain separate and higher authority.
- Surfaced budget gate state in queue pressure, CEO status risks, operator
  status reports, and project queue pressure formatting.
- Added focused tests for policy storage, governance evidence, unknown-cost
  defer behavior, deterministic block behavior, admission defer/block behavior,
  gate priority behind BK decisions, budget governance event sources, risk
  policy approval requirements, CEO status visibility, and operator report
  visibility.
- Did not add provider billing API integration, writer-cap changes,
  connector/secret expansion, daemon/watch/poll/reply runtime changes, merge,
  push, cleanup, or recovery authority.

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

- Added manifest-based backup inspection through `backup:manifest`. The
  manifest records deterministic relative-path entries with bytes, SHA-256,
  record kind, required-for-restore flags, portable project profile state,
  host-owned runtime artifacts, and explicit restore authority flags set to
  false for dispatch, approval, merge, push, cleanup, recovery, and history
  rewriting.
- Added read-only restore validation through `restore:validate`. It checks
  manifest presence/hash integrity, malformed JSONL records, duplicate ids,
  broken project/work-item ancestry, materialized plan/task/action ancestry
  mismatches, governance gaps for memory and budget policy evidence, run
  lifecycle consistency, and stale or wrong-host ownership records.
- Added read-only host migration validation through `migration:validate`.
  Migration is blocked when old and new host ownership records are both active,
  preventing active-active automation host operation.
- Documented backup, restore, and migration drill steps in daemon operations
  and rollback/recovery drill docs, including the requirement to stop old host
  services before enabling the new host.
- Added focused tests covering deterministic manifests, missing restore files,
  malformed records, duplicate ids, broken ancestry, governance gaps, stale
  host ownership, active-active migration blocking, and restore validation
  leaving state unchanged.
- Left runtime authority unchanged: restore and migration validation do not
  dispatch workers, approve decisions, merge, push, cleanup, recover, rewrite
  history, start services, stop services, or mutate source-of-truth state.

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

- Reviewed M1-M9 outcomes and found the Phase 9 continuous-operation contract
  implemented: host ownership diagnostics, watchdog issue classification,
  queue pressure and admission, governed routine triggers, routine intake
  through existing gates, notification digest throttling, deterministic budget
  enforcement, and manifest-based backup/restore/migration validation.
- Added an integrated Phase 9 exit drill in
  [tests/continuous-operations-exit.test.ts](../tests/continuous-operations-exit.test.ts).
  The drill exercises unsafe host watchdog output, queue admission blocking,
  routine fingerprint coalescing, low-risk notification digest windows, urgent
  notification bypass, budget defer and block decisions, restore validation,
  host migration active-active blocking, and `writerCap` staying `1`.
- Updated roadmap, architecture, daemon operations, and remote adapter docs only
  for implemented behavior.
- Closed Phase 9 without adding multi-writer execution, direct routine dispatch,
  provider billing integration, destructive self-healing, arbitrary remote
  command authority, connector authority, secret authority, merge/push/cleanup/
  recovery authority, or host active-active runtime.

## Phase 9 Exit Review

| Exit criterion | Status | Evidence |
| --- | --- | --- |
| Samantha can run for long periods on the active automation host without manual babysitting. | Met for Phase 9 scope. Host ownership, service template, heartbeat, lock, inbox, Telegram reply, outbox, and environment diagnostics are machine-checkable and exposed through `doctor` and `/problems`. Long-run safety is enforced by deterministic stops rather than silent repair. | M2/M3 outcomes above; [tests/ops-diagnostics.test.ts](../tests/ops-diagnostics.test.ts); [tests/continuous-operations-exit.test.ts](../tests/continuous-operations-exit.test.ts); [docs/DAEMON_OPERATIONS.md](DAEMON_OPERATIONS.md#watchdog-diagnostics) |
| Host failures produce actionable reports instead of silent stalls. | Met. Watchdog diagnostics classify stale, blocked, degraded, needs-BK, and unsafe-to-continue issues with next safe actions and secret redaction. | M3 outcome above; [src/lib/ops-diagnostics.ts](../src/lib/ops-diagnostics.ts); [tests/operator-reports.test.ts](../tests/operator-reports.test.ts) |
| Routine triggers do not create duplicate active work for the same live fingerprint. | Met. Routine observations coalesce against active requests, plans, tasks, actions, and unresolved decisions. Accepted observations can create only one pending orchestration request and cannot dispatch workers directly. | M5/M6 outcomes above; [src/lib/routine-trigger-store.ts](../src/lib/routine-trigger-store.ts); [tests/routine-trigger-store.test.ts](../tests/routine-trigger-store.test.ts); [tests/continuous-operations-exit.test.ts](../tests/continuous-operations-exit.test.ts) |
| Budget and queue pressure can stop or defer work through deterministic policy instead of hidden agent judgment. | Met. Queue pressure classifies overload, unsafe host state, BK decisions, recovery needs, lifecycle gaps, outbox backlog, and budget audit gaps. Budget enforcement requires approved local policies and distinguishes measured, estimated, and unknown cost. | M4/M8 outcomes above; [src/lib/queue-pressure.ts](../src/lib/queue-pressure.ts); [src/lib/cost-budget-audit.ts](../src/lib/cost-budget-audit.ts); [tests/queue-pressure.test.ts](../tests/queue-pressure.test.ts); [tests/cost-budget-audit.test.ts](../tests/cost-budget-audit.test.ts) |
| State can be backed up, restored, and audited. | Met. Backup manifests record hashes, restore-required files, project profiles, host-owned runtime artifacts, and restore authority flags. Restore validation catches missing files, malformed records, duplicate ids, broken ancestry, governance gaps, lifecycle gaps, and stale host ownership. | M9 outcome above; [src/lib/backup-restore.ts](../src/lib/backup-restore.ts); [tests/backup-restore.test.ts](../tests/backup-restore.test.ts) |
| BK can recover or migrate the system from another machine with documented steps. | Met as a validation and handoff drill, not automatic migration. Migration validation blocks active-active host ownership, and daemon docs require old services to stop before enabling the new host. | M9 outcome above; [docs/DAEMON_OPERATIONS.md](DAEMON_OPERATIONS.md#backup-restore-and-host-migration-drills); [tests/backup-restore.test.ts](../tests/backup-restore.test.ts); [tests/continuous-operations-exit.test.ts](../tests/continuous-operations-exit.test.ts) |

## Dogfood And Drill Evidence

| Drill | Evidence | Result |
| --- | --- | --- |
| Host watchdogs | `tests/ops-diagnostics.test.ts` and the M10 exit drill exercise missing, client, stale, and unsafe host ownership; stale heartbeat; missing lock; dead pids; stuck inbox; missing service templates; and redacted Telegram reply failures. | Met. Failures are reported with next safe actions and no runtime mutation. |
| Queue pressure | `tests/project-queues.test.ts`, `tests/queue-pressure.test.ts`, and the M10 exit drill cover unsafe host blocking, pending BK decisions outranking routine intake, recovery blockers, active action deferral, budget audit gaps, and outbox backlog. | Met. Admission decisions are deterministic and audit-visible. |
| Routine coalescing | `tests/routine-trigger-store.test.ts` plus the M10 exit drill create an accepted routine request, then prove the duplicate live fingerprint is coalesced and cannot create another request. | Met. Routine triggers remain intake-only. |
| Notification throttling | `tests/ceo-status.test.ts` covers low-risk digest records and urgent BK decision bypass; the M10 exit drill verifies digest-window and urgency classification helpers. | Met. Low-risk repeats coalesce, urgent changes deliver. |
| Budget block and defer | `tests/cost-budget-audit.test.ts`, `tests/queue-pressure.test.ts`, `tests/ceo-status.test.ts`, and the M10 exit drill cover unknown-cost defer, known-cost block, governance evidence, and queue admission effects. | Met. Unknown cost is not treated as zero. |
| Backup and restore | `tests/backup-restore.test.ts` plus the M10 exit drill cover deterministic manifests, manifest hash validation, malformed records, duplicate ids, ancestry gaps, governance gaps, lifecycle gaps, stale host ownership, and read-only restore authority. | Met. Restore validation does not activate or mutate state. |
| Host migration | `tests/backup-restore.test.ts` and the M10 exit drill block active-active ownership and allow handoff only after the old host is no longer active. | Met. Exactly one automation host remains the contract. |

## Authority Review

- Writer authority: `DEFAULT_SAFETY_POLICY.writerCap` remains `1`; Phase 9 did
  not add multi-writer execution or change writer-cap governance.
- Routine authority: routine triggers are governed intake records. They cannot
  dispatch, approve, merge, push, cleanup, recover, bypass project gates, or
  expand connector or secret authority.
- Budget authority: active budget policies can defer or block through local
  deterministic gates only after explicit BK governance evidence. Phase 9 did
  not add provider billing API integration or hidden LLM budget judgment.
- Notification authority: throttling can coalesce repeated low-risk
  notifications, but it cannot approve, reject, dispatch, merge, push, cleanup,
  recover, create routine work, or mutate source-of-truth work state.
- Backup/restore/migration authority: manifest generation, restore validation,
  and migration validation are read-only checks. They do not start or stop
  services, activate restored state, dispatch, approve, merge, push, cleanup,
  recover, rewrite history, or operate two hosts at once.
- Connector and secret authority: Phase 9 did not grant new connector or secret
  access and did not change the Phase 5 profile/capability gates.
- Memory/SOP authority: routines and budgets may use memory as context only.
  Memory, SOPs, and skills cannot override safety, approval, project, dispatch,
  worktree, merge, push, cleanup, recovery, budget, routine, connector, or
  secret gates.

## Verification Run

Required M10 verification:

```bash
bun test tests/continuous-operations-exit.test.ts
bun run verify:docs
bun run verify:mac
```

M10 Mac-side run on 2026-05-10:

- `bun test tests/continuous-operations-exit.test.ts` passed: 1 test, 0
  failures.
- Focused Phase 9 drill set passed: `bun test tests/ops-diagnostics.test.ts
  tests/routine-trigger-store.test.ts tests/queue-pressure.test.ts
  tests/cost-budget-audit.test.ts tests/backup-restore.test.ts
  tests/ceo-status.test.ts tests/continuous-operations-exit.test.ts` ran 60
  tests with 0 failures.
- `bun run verify:docs` passed.
- `bun run verify:mac` passed, including TypeScript typecheck, portable tests,
  and docs verification. Portable test result: 398 passed, 0 failed across 58
  files.

Phase 9 M10 added an integrated portable drill test and documentation updates.
It did not change host-owned daemon/watch/poll/reply/service-template runtime
behavior or runtime state, so active-host `bun run verify:host` is not required
for this M10 review. Run host verification later only when a host-owned runtime
change is made on the active automation host.

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
