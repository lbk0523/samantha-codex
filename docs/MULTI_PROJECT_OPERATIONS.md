# Multi-Project Operations

Last updated: 2026-05-10

Status: planned.

This document contains the execution stages for roadmap Phase 6:
[Multi-Project Operations](CEO_OFFICE_ROADMAP.md#6-multi-project-operations).

This phase assumes Phase 5 is implemented: Samantha has deterministic
governance taxonomy, append-only governance events, shared risk policy,
profile/capability gates, connector and secret authority boundaries,
cost/budget audit hooks, operator reconstruction reports, dangerous transition
gate tests, and rollback/recovery drills.

The purpose of Phase 6 is not to broaden autonomy. It is to let Samantha manage
multiple active projects while keeping project identity, goal ancestry, remote
commands, safety policy, reporting, and audit reconstruction deterministic.

## Assumptions

- The deterministic CEO Office remains the owner of durable state, task/action
  creation, approval, dispatch, merge, push, cleanup, recovery, and audit.
- LLM orchestrator calls remain bounded proposal generators.
- Project profiles are the current source of project identity, but they need a
  stronger contract before they become the backbone of multi-project operation.
- A materialized execution work item should belong to one project unless a
  later approved stage explicitly adds multi-project work items with tests.
- Cross-project views may aggregate and rank work across projects, but they do
  not bypass per-project gates.
- The current writer cap remains `1`; Phase 6 does not enable multi-writer
  execution.
- Durable records should prefer stable project, goal, and work-item ids.
  Runtime-local resolved paths are execution evidence, not portable identity.
- Existing single-project Samantha and OMHT flows must continue to work during
  migration.
- Mac-side work may edit, test, and document normal repo code. Ubuntu host
  runtime verification remains host-owned.

## Non-Scope

- No project import/export, company template system, or bulk workspace cloning.
- No writer cap increase.
- No multi-writer execution.
- No general self-organizing agent teams or role topology expansion.
- No durable SOP, preference, or long-term memory layer.
- No routine scheduler, webhook trigger, or API-triggered execution.
- No automatic budget stop, quota enforcement, or throttling.
- No new connector or secret access surface.
- No LLM-owned durable state mutation.

## M1: Multi-Project Baseline And Inventory

Goal: define the current project identity gaps before changing schemas or
runtime behavior.

Focus:

- inventory current records that carry project identity, including
  orchestration requests, plans, decisions, tasks, actions, runs, lifecycle
  records, recovery records, reports, governance events, and budget observations
- identify records that currently infer project from `repoRoot`, task text,
  latest active item, or profile defaults
- create representative fixtures with at least two project profiles and one
  ambiguous project request
- document which existing flows are single-project assumptions and which can be
  safely generalized
- define migration and compatibility expectations for old records

Verification focus:

- fixtures prove where project identity is present, missing, inferred, or
  ambiguous
- tests document the existing single-project behavior before it changes
- no runtime behavior changes in this stage
- Phase 6 follow-up stages have clear ownership for every identified gap

Outcome:

- Added the M1 inventory in
  [MULTI_PROJECT_BASELINE_INVENTORY.md](MULTI_PROJECT_BASELINE_INVENTORY.md).
- Used the existing `samantha` and `omht` project profiles as the two-profile
  baseline fixtures.
- Fixed the ambiguous request baseline as `다음 작업 계획 보고`: with multiple
  configured profiles and no project keyword, Samantha currently infers no
  project profile.
- Added `tests/multi-project-baseline.test.ts` as a current-behavior baseline
  for project identity carriers and gaps across requests, plans, decisions,
  tasks, actions, runs, lifecycle records, recovery records, reports,
  governance events, and budget observations.
- Left schemas, runtime behavior, remote command behavior, `writerCap`,
  `state/`, and `runs/` unchanged.
- Assigned every identified gap to M2-M10 in the inventory stage handoff.

## M2: Project Profile Contract And Resolution

Goal: make project profile loading, validation, and selection deterministic
enough for multiple active projects.

Focus:

- explicit project profile schema validation for id, repo root expression,
  keywords, remote scopes, setup commands, verify commands, and forbidden
  changes
- unique project ids and deterministic tie handling for keyword matches
- project root resolution through profile expressions or environment overrides,
  not hard-coded repo-local absolute paths
- clear distinction between profile identity, resolved runtime root, remote
  scope, and report label
- fail-closed behavior for unknown project ids, missing profiles, ambiguous
  matches, invalid default scopes, and invalid path expressions

Verification focus:

- valid multi-profile fixtures load in stable order
- ambiguous project inference requires BK clarification instead of choosing a
  project silently
- environment overrides resolve roots without changing source-controlled
  profile identity
- invalid profile records fail before planning, materialization, or dispatch

Outcome:

- Added explicit project profile validation in `src/lib/project-profile.ts` for
  project ids, repo root expressions, keywords, remote scope contracts, default
  remote scope references, setup commands, verify commands, and forbidden
  changes.
- Made profile loading fail closed for duplicate project ids, conflicting
  project identifiers, invalid default scopes, and invalid path expressions.
- Kept `repoRoot` as the resolved runtime root for existing single-project
  flows while adding `repoRootExpression` so source-controlled profile identity
  remains distinct from host-local execution paths.
- Kept environment overrides limited to runtime root resolution; overrides do
  not mutate project id, keywords, default scope, or source repo root
  expression.
- Made multi-profile inference fail closed when more than one project keyword
  matches instead of silently choosing by score.
- Added focused project-profile tests for stable multi-profile load order,
  env override identity preservation, duplicate/ambiguous profile identifiers,
  invalid default scopes, invalid path expressions, and ambiguous inference.

## M3: Goal And Work-Item Ancestry Contract

Goal: define project -> goal -> work item ancestry before propagating it through
all stores.

Focus:

- define minimal goal records with stable id, project id, title, status, created
  timestamp, optional priority, and optional parent context
- define work-item ancestry fields for request, plan, decision, task, action,
  run, lifecycle, recovery, report, governance event, and budget observation
  records
- decide the legacy representation for old records without silently assigning
  them to a project or goal
- require same-project ancestry for a materialized execution plan unless a
  later stage explicitly adds cross-project work-item support
- keep ancestry fields deterministic and serializable without depending on
  local filesystem paths

Verification focus:

- schema tests reject mismatched project, goal, and work-item ancestry
- old records load with explicit legacy or unassigned ancestry instead of
  inferred false precision
- a work item can be traced from request to plan to task/action/run without
  reading prose
- cross-project materialization is blocked unless it has an explicit approved
  contract

Outcome:

- Added the M3 ancestry contract in `src/lib/ancestry.ts`, including minimal
  goal records with stable id, project id, title, status, created timestamp,
  optional priority, and optional parent context.
- Defined a common optional `ancestry` field contract for requests, plans,
  decisions, tasks, actions, runs, lifecycle records, recovery requests,
  reports, governance events, and budget observations.
- Kept old records compatible by normalizing missing ancestry to explicit
  `legacy` records and allowing explicit `unassigned` records when BK has not
  selected project or goal context. M3 does not infer project or goal from
  prose, paths, latest active work, or profile defaults.
- Added validation helpers that reject unknown goals, project/goal mismatches,
  unstable path-like ids, duplicate ancestry records, and materialized
  execution plans whose task/action/run/lifecycle ancestry differs from the
  plan's project, goal, or work item.
- Preserved governance event and budget observation ancestry through their
  existing create/parse helpers without changing planner prompts,
  materializer runtime behavior, store migration behavior, cross-project
  execution support, or `writerCap`.
- Added focused M3 tests in `tests/ancestry.test.ts` for goal validation,
  legacy/unassigned handling, deterministic mismatch rejection, same-project
  materialized execution ancestry, full request-to-run traceability, and
  governance/budget ancestry preservation.

## M4: Ancestry Propagation Through Planning And Materialization

Goal: carry project, goal, and work-item ancestry through the existing
orchestrator flow without widening execution authority.

Focus:

- create or select project and goal context at request intake
- include ancestry in orchestrator prompt context and structured plan records
- validate that proposed tasks use known project ids and the selected project
  context
- materialize tasks and actions with ancestry copied from the approved plan
- carry ancestry into plan synthesis, recovery requests, and blocked-question
  decisions
- preserve existing question-first behavior when project or goal context is
  unclear

Verification focus:

- `/work -> /plan -> /go` preserves project, goal, and work-item ids
- materializer rejects task proposals with unknown or mismatched project ids
- recovery uses the canonical project profile root for the failed plan's
  project
- question-only and blocker-clarification plans do not create tasks or actions

Outcome:

- Added deterministic orchestration ancestry propagation through request
  intake, orchestrator prompt context, structured plan records, materialized
  task records, and materialized action records.
- Request intake now assigns project, goal, and work-item ancestry when a
  project can be selected from an explicit project id, a deterministic project
  keyword match, or the existing single-profile fallback. Ambiguous
  multi-project requests stay unassigned so the existing question-first flow is
  preserved.
- Orchestrator prompts now include the selected ancestry context and instruct
  executable task proposals to use the selected project id. Synthesis prompts
  also carry the plan ancestry as evidence context.
- Materialization now rejects assigned plans whose task proposals use an
  unknown project id, omit the selected project id, or name a different project
  id. Plans with unassigned ancestry cannot materialize execution records.
- Approved plan materialization copies the approved plan ancestry onto every
  created task and dispatch action without changing writer cap, dispatch
  authority, remote wrong-project guards, dashboard filters, or per-project
  safety policy.
- Recovery requests copy ancestry from the failed plan and include the failed
  plan project's profile canonical repo root before action/run-log evidence
  roots. Revision requests and blocker clarification decisions also preserve
  the linked plan ancestry.
- Added focused tests for orchestrator prompt ancestry, materializer ancestry
  copy/rejection behavior, question-only no-materialization behavior,
  `/work -> /plan -> /go` request/plan/task/action ancestry propagation, and
  recovery request ancestry plus canonical project root usage.

## M5: Project-Isolated Queues And Reports

Goal: make project-level queues visible without hiding the cross-project state
BK needs to run the whole CEO office.

Focus:

- project filters for requests, plans, decisions, tasks, actions, runs,
  lifecycle records, recovery records, governance events, and budget audit
  observations
- per-project sections in CEO status, operator reports, and dashboard views
- clear labels for unassigned, legacy, blocked, active, and completed work
- project-level counts for pending BK decisions, active actions, failed runs,
  recovery needs, and audit gaps
- no mutation from dashboard filters unless an existing deterministic write gate
  supports it

Verification focus:

- CLI and dashboard can show one project without dropping global blockers
- cross-project reports aggregate counts consistently with per-project reports
- legacy or unassigned records are visible instead of disappearing
- routine display text still avoids raw ids where they are not needed

Outcome:

- Added a shared project queue snapshot in `src/lib/project-queues.ts` for
  requests, plans, decisions, tasks, actions, runs, lifecycle records, recovery
  requests, CEO reports, governance events, and budget audit observations.
- Project queues now classify assigned project records separately from explicit
  `unassigned` records and legacy records without inferring project identity
  from repo paths or prose.
- CEO status supports `--project=<id>` and filters the primary status sections
  to the selected project while preserving cross-project project counts,
  legacy/unassigned counts, and global blockers from diagnostics.
- Operator status reports and the read-only dashboard Daily Review now show
  project queue summaries with pending BK decisions, active actions, failed
  runs, recovery needs, and audit gaps.
- Worker run logs, run summaries, and lifecycle bases now preserve task
  ancestry so future runs participate in project-level queue and report
  filters.
- Added focused M5 tests for project queue aggregation, CEO status filtering,
  operator status reports, and read-only dashboard rendering.

## M6: Remote Project Selection And Wrong-Project Guards

Goal: prevent Telegram or another compact adapter from operating on the wrong
project when several projects have active work.

Focus:

- deterministic remote project selection for `/work` and `/plan`
- project-aware current-plan and current-decision selection
- `/go`, `/approve`, `/answer`, `/revise`, `/cancel`, and `/recover` refuse to
  advance when more than one current item could match
- compact ambiguity reports that ask BK to name the project instead of exposing
  raw internal ids
- local fallback commands for precise operator inspection

Verification focus:

- two simultaneous project plans cannot be approved or materialized by an
  ambiguous remote command
- stale project context cannot approve a newer plan from another project
- `/now` explains the safest next project-specific action
- unsupported project ids or scope ids fail closed before inbox processing
  writes executable work

Outcome:

- Added project-aware remote current-item selection for pending requests,
  actionable orchestrator plans, plan approval decisions, blocker
  clarifications, and recovery candidates.
- `/plan` now refuses ambiguous pending requests and validates requested
  project/scope context before running the orchestrator. Unknown projects,
  unknown scopes, and scope-without-project inputs fail closed before plans,
  tasks, or actions are created.
- `/go`, `/approve`, `/answer`, `/revise`, `/cancel`, `/recover`, and
  `/plan_current` now refuse when more than one current item could match the
  command. Project-qualified compact commands can narrow the current item
  without accepting decision, plan, task, action, run, shell, or repo-path ids.
- `/now` now reports cross-project current-plan ambiguity as a project-specific
  safest-action summary instead of presenting `/go` as safe.
- Added compact ambiguity reports that ask BK to specify the project while
  confirming state was not changed and executable work was not created.
- Added the local fallback command `orchestrator:current [--project=<id>]` for
  precise inspection of current requests, plans, and decisions with ids.
- Added focused remote project selection tests for ambiguous approve/go,
  stale project context, unsupported project/scope ids, `/now` ambiguity
  wording, and compact parser behavior.

## M7: Per-Project Safety Policy

Goal: allow projects to be stricter than the global safety policy without
creating a hidden authority expansion path.

Focus:

- per-project safety policy overlays for forbidden changes, allowed remote
  scopes, host-only verification needs, risk defaults, and dispatch
  prerequisites
- deterministic composition where the stricter global or project rule wins
- governance event and approval requirements for changes that expand project
  authority
- clear denial reasons when a task is valid globally but blocked by project
  policy
- keep `writerCap` global and unchanged in Phase 6

Verification focus:

- project policy cannot loosen global writer, skill, connector, secret, merge,
  push, cleanup, or approval gates without governed approval
- stricter project forbidden changes and remote scopes block unsafe plans before
  materialization
- reports show the project-specific blocked reason and next safe action
- existing Phase 5 authority-change tests remain valid

## M8: Project And Goal Cost/Budget Reporting

Goal: use the Phase 5 budget audit hooks to show cost and budget observations
by project and goal without enforcing budget stops yet.

Focus:

- propagate project, goal, and work-item context into budget audit observations
  where available
- roll up measured, estimated, and unknown cost observations by project, goal,
  action, run, model, and command
- distinguish missing cost data from zero cost in every aggregate view
- show budget-relevant audit gaps when ancestry or cost data is missing
- keep automatic budget enforcement deferred to Phase 9

Verification focus:

- project and goal filters return the expected budget observations
- measured zero remains distinct from unknown cost
- cross-project cost summaries do not imply totals where data is missing
- missing budget data does not block existing work execution

## M9: Cross-Project Prioritization And CEO Ranking

Goal: let BK ask what matters across projects and receive one ranked,
explainable answer.

Focus:

- deterministic ranking inputs such as BK decisions needed, blocked recovery,
  active worker state, stale failures, explicit priority, recency, and audit
  gaps
- one ranked cross-project next-action view for CLI, dashboard, and compact
  remote reports
- optional bounded synthesis for wording only, using Samantha-provided evidence
- clear separation between ranking recommendations and execution approval
- no automatic dispatch, merge, push, cleanup, or budget enforcement from a
  ranking result

Verification focus:

- ranking is stable for equal inputs and explains tie-breakers
- urgent BK decisions outrank routine completed-work summaries
- blocked recovery remains visible until fixed or explicitly closed
- CLI, dashboard, and compact remote reports show the same top recommendation

## M10: Dogfood, Migration, And Exit Review

Goal: prove Phase 6 behavior on real multi-project Samantha use before moving
to evidence-based parallelism expansion.

Focus:

- dogfood at least two active project profiles with one implementation flow and
  one report-only flow
- migrate or explicitly classify legacy records without destructive state edits
- update architecture, remote-adapter, dashboard, operations, and roadmap docs
  only where actual behavior changed
- review Phase 6 exit criteria against test and dogfood evidence
- identify which role-topology requirements belong to Phase 7
- identify which memory/SOP requirements belong to Phase 8
- identify which routine and budget-enforcement requirements belong to Phase 9

Verification focus:

- Phase 6 exit criteria have explicit evidence links
- wrong-project remote commands are blocked in tests and dogfood
- project and goal ancestry reconstructs a completed work item end to end
- `writerCap` remains `1`
- Mac-side verification passes
- Ubuntu host verification is run only when host runtime behavior is touched

## Standard Verification

Mac-side verification:

```bash
bun typecheck
bun run test:portable
bun run verify:docs
bun run verify:mac
```

Ubuntu host verification, when host runtime behavior is touched:

```bash
bun run test:host
bun run test:all
bun run verify:host
```

Do not run Samantha daemon, watch, poll, reply, worker dispatch, or dashboard
runtime processes from Mac.
