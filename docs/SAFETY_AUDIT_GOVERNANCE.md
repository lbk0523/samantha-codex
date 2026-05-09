# Safety, Audit, And Governance

Last updated: 2026-05-09

Status: active.

This document contains the execution stages for roadmap Phase 5:
[Safety, Audit, And Governance](CEO_OFFICE_ROADMAP.md#5-safety-audit-and-governance).

This phase assumes Phase 4 is implemented: Samantha can classify requests,
produce bounded plans, ask clarification questions, materialize only selected
safe plans, run report-only specialists, run at most one writer, synthesize
results, and recover from failed plans through deterministic gates.

The purpose of Phase 5 is not to broaden autonomy. It is to make future
authority expansion reviewable before Samantha later grows into multi-project,
parallel, memory, routine, or budget-enforced operation.

## Assumptions

- The deterministic CEO Office remains the owner of durable state, task/action
  creation, approval, dispatch, merge, push, cleanup, recovery, and audit.
- LLM orchestrator calls remain bounded proposal generators.
- The current writer cap remains `1`; Phase 5 does not enable multi-writer
  execution.
- Telegram remains a thin adapter for compact reporting, approval, answers, and
  status checks. It does not accept shell commands, repo paths, or internal ids
  for routine workflows.
- Existing Phase 4 plan, synthesis, question-draft, materialization, recovery,
  and remote-answer behavior should remain compatible unless a schema migration
  is explicitly implemented with tests.
- Mac-side work may edit, test, and document normal repo code. Ubuntu host
  runtime verification remains host-owned.

## Non-Scope

- No writer cap increase.
- No multi-writer execution.
- No general self-organizing agent teams.
- No connector marketplace, broad plugin runtime, or new secret access surface.
- No automatic routine scheduler or webhook/API trigger execution.
- No budget-based stopping or throttling beyond recording audit data.
- No project import/export or company template system.
- No LLM-owned durable state mutation.

## G1: Governance Baseline And Taxonomy

Goal: define the subjects, event kinds, risk classes, and transition categories
that later stages can enforce.

Focus:

- inventory existing state sources for decisions, orchestrator plans, tasks,
  remote actions, runs, lifecycle records, reports, and recovery context
- define governed subject types for request, plan, task, action, run, merge,
  push, cleanup, recovery, agent profile, capability, skill, connector, routine,
  policy, and budget records
- define risk classes that are simple enough to enforce deterministically
- define which records are source-of-truth events and which reports are derived
  views
- document the transition matrix before changing runtime behavior

Verification focus:

- taxonomy tests or fixtures cover every governed subject type
- unknown subject or transition kinds fail closed instead of being treated as
  safe
- docs explain which later roadmap phase owns project ancestry, role topology,
  SOP memory, routines, and budget enforcement

Outcome:

- Added a deterministic governance taxonomy in `src/lib/governance-taxonomy.ts`
  with governed subject types, event kinds, transition kinds, risk classes,
  source-of-truth record kinds, and derived view kinds.
- Added `references/governance/taxonomy.json` and
  `tests/governance-taxonomy.test.ts` to prove fixture coverage for every
  governed subject type and transition kind.
- Unknown subject, transition, event, or risk values now fail closed in taxonomy
  helpers instead of defaulting to safe.
- G1 does not add the append-only event store, runtime governance gates, writer
  cap changes, routines, connector access, or budget enforcement.
- Later ownership remains deferred: project ancestry belongs to Phase 6, role
  topology to Phase 7, SOP memory to Phase 8, and routines plus budget
  enforcement to Phase 9.

## G2: Append-Only Governance Event Store

Goal: create one durable audit trail that can reconstruct risky state changes
without mutating historical records.

Focus:

- append-only governance event records with stable id, timestamp, actor, source,
  subject, kind, risk class, summary, and related decision/action/run refs
- deterministic helpers for appending, listing, filtering, and loading events
- idempotency for repeated report generation or repeated safe no-op commands
- no history rewriting; corrections are additional events
- CLI inspection suitable for local operator review

Verification focus:

- appending events preserves order and does not rewrite prior lines
- duplicate-safe operations do not create duplicate meaningful audit events
- malformed or unknown events are reported clearly
- event filters can retrieve the history for one subject

Outcome:

- Added `src/lib/governance-event-store.ts` with append-only JSONL governance
  events containing stable ids, timestamp, actor, source, subject, event kind,
  risk class, summary, and related decision/action/run refs.
- Event creation and loading validate governed subject type, event kind, risk
  class, and source kind against the G1 taxonomy.
- Duplicate deterministic event ids return the first recorded event without
  rewriting the JSONL file; corrections remain separate future events.
- Added `tests/governance-event-store.test.ts` for append order, idempotent
  no-op appends, load/list/filter behavior, and clear malformed/unknown event
  errors.
- G2 does not add profile/capability approval behavior, runtime governance
  gates, daemon/watch/poll/reply/dispatch behavior, or history rewriting.

## G3: Risk Classification And Policy Contracts

Goal: make dangerous transitions explicit before execution rather than relying
on agent judgment or report wording.

Focus:

- deterministic risk classification for plans, actions, profile changes,
  capability changes, skill allowances, connector/secret access, merge, push,
  cleanup, and recovery transitions
- policy contracts that describe which risk classes require BK approval
- fail-closed behavior for unknown risk, unknown role, unknown capability, or
  missing approval evidence
- shared helpers so reports, gates, and adapters use the same risk decision
- policy drift tests for transitions that previously had special-case logic

Verification focus:

- high-risk and irreversible transitions require explicit pending-to-approved
  decision evidence
- unknown risk cannot be dispatched, materialized, merged, pushed, cleaned, or
  promoted silently
- CLI, dashboard, and Telegram describe the same blocked reason and next safe
  action
- existing Phase 4 safe flows still pass without extra manual decisions

Outcome:

- Added `src/lib/risk-policy.ts` with deterministic risk classification for
  plan materialization, action/task dispatch, profile and capability activation,
  skill allowance, connector/secret access, merge, push, cleanup, recovery, and
  other governed taxonomy transitions.
- Unknown subject, transition, risk class, risk drift, missing subject id, and
  missing approval evidence fail closed in the shared risk decision helper.
- High and irreversible transitions now require resolved BK approval evidence;
  existing orchestrator plan approval remains the explicit evidence for Phase 4
  plan materialization.
- `decisionAllowsOrchestratorMaterialization` now uses the shared helper while
  keeping Phase 4 `/go` behavior compatible.
- Added `tests/risk-policy.test.ts` for contract coverage, dangerous transition
  classifications, explicit approval evidence, unknown risk, risk drift, and
  safe informational flows.
- G3 does not add profile/capability decision kinds, expand connector/secret
  authority, change runtime merge/push/cleanup behavior, or change `writerCap`.

## G4: Agent Profile And Capability Governance

Goal: ensure new roles, profile edits, writer authority, and capability changes
are approved and auditable before they affect execution.

Focus:

- `agent_profile_change` and `capability_change` decision kinds
- structured diff or summary for proposed profile and capability changes
- approval gates for adding roles, changing writer authority, changing model or
  Codex profile, allowing skill bundles, granting connector/secret access, and
  changing safety policy
- role/capability registry that remains advisory unless the deterministic gate
  explicitly grants authority
- profile validation that keeps `codex-worker` as the only production writer
  unless a later evidence phase changes the policy

Verification focus:

- unapproved profile or capability changes are rejected before use
- approved changes record approver, timestamp, risk class, and diff summary
- non-writer profiles remain report-only with `worktreePolicy: "none"` and
  `mergePolicy: "none"`
- LLMs, workers, skills, remote commands, and dashboard views cannot create or
  activate profiles directly

Outcome:

- Added `agent_profile_change` and `capability_change` decision kinds with
  governed subjects for agent profiles, capabilities, and safety policy.
- Added deterministic profile/capability gates in
  `src/lib/profile-governance.ts`; dispatch, direct worker execution, plan runs,
  and Samantha profile loading reject unapproved authority changes before use.
- Existing governance keeps `codex-worker` as the only production writer, keeps
  non-writers report-only with no worktree or merge authority, and requires
  separate capability approval for allowed skill bundles and connector/secret
  grants.
- Approved governed decisions now append `transition_approved` governance events
  with BK approver, timestamp, risk class, and the prompt diff/summary. No
  connector implementation, profile activation command, or multi-writer
  execution was added.

## G5: Skill, Connector, And Secret Authority Gates

Goal: prevent skills and connectors from becoming hidden authority expansion
paths.

Focus:

- skills remain work methodology, not orchestration authority
- allowed skill bundles are treated as governed capabilities when they materially
  change agent behavior
- connector and secret access require explicit governed capability records
- no implicit inheritance of user connector access into worker runtimes
- prompt and policy language that makes connector/secret boundaries visible to
  workers and reviewers

Verification focus:

- a skill cannot override Samantha worktree, dispatch, merge, push, cleanup, or
  approval gates
- connector/secret access is unavailable without an approved capability record
- report-only agents remain read-only even when a skill suggests broader action
- denial reports explain the missing approval without exposing secrets

## G6: Cost And Budget Audit Hooks

Goal: record budget-relevant facts now so later budget enforcement can be built
on evidence instead of guesswork.

Focus:

- cost/budget audit event shape for model, command, run, project, goal, and
  action context where available
- distinguish measured, estimated, and unknown costs
- avoid treating missing cost data as zero
- roll up budget observations in operator reports without enforcing automatic
  stops yet
- keep budget enforcement and throttling explicitly deferred to Phase 9

Verification focus:

- run or action cost observations can be recorded and retrieved
- reports distinguish unknown cost from measured or estimated cost
- missing cost data does not block existing Phase 4 workflows
- no automatic budget stop is introduced in Phase 5

## G7: Operator Review And Reconstruction Reports

Goal: let BK or a local operator reconstruct what happened from original
request to final state without manually chasing raw files.

Focus:

- review reports for completed, failed, blocked, recovered, and partially
  integrated work
- request -> plan -> decision -> task -> action -> run -> verify -> merge ->
  push -> cleanup -> recovery chain reconstruction
- explicit display of approvals, risk classes, changed files, verify commands,
  run logs, commits, and remaining risks
- missing links shown as audit gaps rather than silently ignored
- compact summary plus local audit references for deeper inspection

Verification focus:

- one completed work item can be reconstructed from stored state
- failed and recovered work shows the recovery link and whether the original
  problem is fixed
- missing or stale records are flagged in the review report
- routine Telegram output remains compact and does not require ids

## G8: Dangerous Transition Gate Tests

Goal: harden the transitions most likely to cause irreversible damage before
expanding future scope.

Focus:

- focused tests for materialize, dispatch, promote dependency, merge, push,
  cleanup, recovery, profile activation, capability activation, and policy
  changes
- stale decision and stale plan rejection
- dirty worktree, target-file violation, forbidden-change violation, failed
  verify, merge conflict, push failure, and cleanup refusal coverage
- remote adapter no-op behavior for ambiguous or unsupported approvals
- dashboard remains read-only unless a deterministic write gate exists

Verification focus:

- every dangerous transition has a passing positive case and at least one
  fail-closed negative case
- remote approval still requires exactly one current applicable decision
- no transition can be triggered by LLM output alone
- existing portable verification remains green

## G9: Rollback And Recovery Drills

Goal: prove the operator can recover from realistic governance and execution
failures without hidden manual state surgery.

Focus:

- documented drills for failed worker verification, dirty worktree, merge
  conflict, failed push, stale approval, mistaken profile proposal, and blocked
  capability request
- recovery reports that distinguish "fixed", "still blocked", and "needs BK"
- rollback guidance for pre-merge and post-merge cases
- no automatic retry after failed plans or failed workers
- audit events for drill execution and outcomes

Verification focus:

- drills can be run against fixtures or controlled local state
- recovery instructions use canonical project profile roots, not stale worker
  worktrees
- rollback guidance does not bypass merge, push, cleanup, or verification gates
- failure-mode docs remain linked from operator reports where useful

## G10: Phase 5 Exit Review And Phase 6 Handoff

Goal: prove that governance is strong enough before Samantha moves into
multi-project operations.

Focus:

- review Phase 5 exit criteria against implemented tests and dogfood evidence
- update architecture, roadmap, remote-adapter, parallelism, and operations docs
  only where actual behavior changed
- identify which project/goal ancestry requirements belong to Phase 6
- identify which role topology requirements belong to Phase 7
- identify which SOP/memory requirements belong to Phase 8
- identify which routine and budget enforcement requirements belong to Phase 9

Verification focus:

- Phase 5 exit criteria have explicit evidence links
- `writerCap` remains `1`
- no unapproved profile, capability, skill, connector, routine, or budget
  authority expansion exists
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
