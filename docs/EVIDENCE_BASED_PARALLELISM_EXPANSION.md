# Evidence-Based Parallelism Expansion

Last updated: 2026-05-10

Status: in progress.

This document contains the execution stages for roadmap Phase 7:
[Evidence-Based Parallelism Expansion](CEO_OFFICE_ROADMAP.md#7-evidence-based-parallelism-expansion).

This phase assumes Phase 6 is implemented: Samantha has deterministic project
profiles, project -> goal -> work-item ancestry, cross-project queues and
ranking, per-project safety overlays, wrong-project remote command guards, and
project/goal budget observation reporting.

The purpose of Phase 7 is not to unlock broad multi-agent autonomy. It is to
make report-only parallel work routine and auditable, define advisory role
relationships, and collect enough deterministic evidence before any writer-cap
change can even be considered.

## Assumptions

- The deterministic CEO Office remains the owner of durable state, task/action
  creation, approval, dispatch, merge, push, cleanup, recovery, and audit.
- LLM orchestrator calls remain bounded proposal generators.
- Role relationships are advisory metadata for planning and reporting. They do
  not grant execution authority, connector access, secret access, writer
  authority, merge authority, push authority, cleanup authority, or approval
  authority by themselves.
- The current writer cap remains `1` until dogfood evidence, deterministic
  conflict detection, rollback tests, and explicit BK approval support a
  governed change.
- Non-writer parallel work must remain report-only, read-only, and free of
  merge or worktree authority.
- Phase 7 may improve merge queue and cleanup reliability, but merge, push, and
  cleanup remain explicit Samantha gates.
- Mac-side work may edit, test, and document normal repo code. Ubuntu host
  runtime verification remains host-owned.

## Non-Scope

- No immediate writer cap increase.
- No multi-writer execution unless a later Phase 7 stage proves every required
  evidence gate and BK explicitly approves the governed change.
- No self-organizing agent teams.
- No LLM-owned durable state mutation.
- No connector or secret authority expansion.
- No durable SOP, preference, or long-term memory layer.
- No routine scheduler, webhook trigger, API-triggered execution, or budget
  enforcement.
- No bypass of project ancestry, project safety overlays, remote command
  guards, merge gates, cleanup gates, or recovery gates.

## M1: Baseline And Phase Spec

Goal: open Phase 7 with a phase-specific execution document, roadmap link, and
accurate evidence-policy baseline before changing runtime behavior.

Focus:

- create this Phase 7 execution document
- link it from the roadmap phase document list and Phase 7 section
- align the existing parallelism evidence policy with Phase 7 terminology
- state that writerCap remains `1` at Phase 7 entry
- define the implementation stage sequence and verification expectations
- prepare handoff prompts that can be copied into separate Codex sessions

Verification focus:

- roadmap links to this execution document
- evidence policy names Phase 7, not an older stage label
- no runtime behavior changes in this stage
- future stages have explicit scope and verification criteria

Outcome:

- Added this Phase 7 execution document.
- Linked Phase 7 detailed stages from
  [CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md).
- Updated [PARALLELISM_EVIDENCE.md](PARALLELISM_EVIDENCE.md) to refer to
  Phase 7 evidence-based parallelism instead of the older Stage 9 wording.
- Left runtime behavior unchanged. `DEFAULT_SAFETY_POLICY.writerCap` remains
  `1`.

## M2: Parallel Evidence Ledger

Goal: record successful and failed parallel execution evidence as structured
state without duplicating full run logs.

Focus:

- add a small parallelism evidence store
- record plan id, project/goal ancestry, batch shape, task/action/run refs,
  agent roles, result modes, writer count, changed files, verification summary,
  merge status, cleanup status, and outcome
- keep the ledger append-only or jsonl-style, consistent with nearby stores
- reference existing run/action/task records instead of copying full artifacts
- expose enough query helpers for reports and governance checks

Verification focus:

- ledger append/list/filter tests
- report-only parallel batch produces evidence
- failed parallel evidence is preserved
- writerCap remains `1`

Outcome:

- Added `src/lib/parallelism-evidence-store.ts` as an append-only JSONL ledger
  for compact parallel evidence records.
- The ledger records plan refs, project/goal/work-item ancestry, batch shape,
  task/action/run refs, agent roles, result modes, writer count, changed files,
  verification summary, merge status, cleanup status, and outcome without
  copying full run logs.
- Added focused tests for append/list/filter, successful report-only evidence,
  failed evidence preservation, and blocking evidence records that exceed the
  current writer cap.
- Left dispatch authority unchanged. `DEFAULT_SAFETY_POLICY.writerCap` remains
  `1`.

## M3: Advisory Role Topology Contract

Goal: define visible role relationships for planning and reporting without
granting new authority.

Focus:

- add a role topology contract for advisory relationships such as reviews,
  researches, evaluates, specifies, reports-to, or advises
- tie topology changes to Phase 5 profile/capability governance
- make role relationships available to planning/reporting surfaces
- prevent topology metadata from changing dispatch, connector, secret, writer,
  merge, push, cleanup, or approval authority

Verification focus:

- role topology validates known agent roles
- unapproved topology or capability changes are blocked where required
- topology appears in operator-facing summaries
- topology alone does not change dispatch policy

Outcome:

- Added an advisory role topology contract for role relationships across
  reviewer, researcher, evaluator, spec, content, operations, and writer roles.
- Made the topology explicitly non-authoritative: it grants no dispatch, writer,
  connector, secret, merge, push, cleanup, approval, or safety-policy authority.
- Tied topology changes to the existing capability-governance decision baseline.
- Surfaced topology guidance in orchestrator planning prompts and
  operator-facing role summaries.
- Left dispatch authority unchanged. `DEFAULT_SAFETY_POLICY.writerCap` remains
  `1`.

## M4: Stronger Non-Writer Parallel Routine

Goal: make report-only non-writer parallel work routine while preserving
read-only behavior.

Focus:

- extend materialization and plan-runner tests around multi-role non-writer
  batches
- keep all non-writers on `resultMode: "report"`, `worktreePolicy: "none"`,
  and `mergePolicy: "none"`
- reject non-writer write proposals, changed-file output, worktree allocation,
  or merge behavior
- keep report-only verification from depending on unmerged writer output

Verification focus:

- reviewer + researcher + evaluator can run in one report-only batch
- non-writer write attempts fail before dispatch
- report-only tasks cannot depend on unmerged writer output
- writer tasks remain serialized under writerCap `1`

Outcome:

- Strengthened `buildPlanBatches` so invalid non-writer plan shapes fail before
  dispatch: non-writers must stay report-only, read-only, no-worktree, and
  no-merge.
- Added plan-runner coverage for reviewer + researcher + evaluator parallel
  report batches, non-writer write rejection, non-writer worktree/merge
  rejection, report-only dependency rejection after writer output, and
  serialized writers under writerCap `1`.
- Extended materializer coverage for a reviewer + researcher + evaluator
  report-only batch alongside a single writer.
- Left dispatch authority unchanged. `DEFAULT_SAFETY_POLICY.writerCap` remains
  `1`.

## M5: Operator Reporting For Parallel Roles

Goal: make parallel specialist outcomes readable to BK without raw internal
noise.

Focus:

- summarize role-specific outcomes in operator reports, CEO status, dashboard,
  and compact remote reports where appropriate
- show what each specialist checked and what risk it reduced
- preserve project/goal ancestry in summaries
- keep raw ids available for audit but unnecessary for routine review

Verification focus:

- reports separate reviewer/researcher/evaluator/spec/content/operations
  outcomes from writer outcomes
- compact remote reports stay short and actionable
- no raw action/status/run noise leaks into normal summaries
- failed specialist reports produce clear next action

## M6: Conflict Detection Before Writer Expansion

Goal: implement deterministic conflict detection before any writer-cap change
is considered.

Focus:

- detect overlapping target files, forbidden changes, same-repo write
  conflicts, stale base commits, dirty target repos, and unmerged writer
  dependencies
- produce an advisory safety result for hypothetical writer concurrency without
  enabling it
- feed conflict results into evidence and governance checks
- keep writerCap unchanged

Verification focus:

- overlapping writer target files are unsafe
- stale base or dirty target repo is unsafe
- disjoint target files are still blocked when other deterministic evidence is
  missing
- conflict detection cannot approve a writerCap change by itself

## M7: Merge Queue Reliability Under Load

Goal: keep merge and push gates deterministic when more parallel evidence and
merge candidates exist.

Focus:

- classify merge candidates as mergeable, already merged, stale base, failed
  verification, dirty target repo, missing commit, or blocked
- keep push as a separate explicit gate
- preserve deterministic ordering and reporting
- connect merge queue outcomes to the evidence ledger

Verification focus:

- multiple merge candidates produce deterministic ordering
- only clean, passing, base-matching candidates are mergeable
- post-merge verification failures are reported clearly
- push remains separate from merge

## M8: Cleanup And Rollback Drills

Goal: prove cleanup and rollback paths remain safe under higher parallel load.

Focus:

- improve cleanup candidate classification for completed, dirty, missing,
  abandoned, and already-cleaned worktrees
- document rollback paths before and after merge
- ensure workers and non-writers cannot roll back state directly
- connect cleanup and rollback evidence to operator reports

Verification focus:

- cleanup remains blocked before worker commit integration
- dirty or missing worktrees are classified without destructive cleanup
- rollback behavior is tested through deterministic recovery/operator paths
- no agent receives direct rollback authority

## M9: Writer-Cap Governance Gate

Goal: make writer-cap changes require complete evidence and explicit BK
approval.

Focus:

- define the exact evidence required before a writerCap change can be approved
- check dogfood evidence, conflict detection, merge behavior, cleanup behavior,
  rollback drills, and governance approval together
- block writerCap changes when any required evidence is missing
- record an auditable diff and approval trail for any proposed change

Verification focus:

- insufficient evidence blocks writerCap increase
- BK approval alone is not enough without deterministic evidence
- complete evidence plus approval can pass the governance check
- default policy remains writerCap `1` unless a governed change is explicitly
  applied

## M10: Dogfood And Exit Review

Goal: close Phase 7 only with concrete evidence from real report-only
parallelism and single-writer implementation flows.

Focus:

- dogfood report-only parallel work on at least two active project profiles
- dogfood at least one implementation flow with parallel non-writers plus one
  writer
- review merge, cleanup, recovery, and evidence-ledger behavior
- update roadmap, architecture, evidence, and operations docs only where actual
  behavior changed
- decide explicitly whether writerCap remains `1` or has enough governed
  evidence for a later change

Verification focus:

- Phase 7 exit criteria have explicit evidence links
- parallel non-writer work is routine and auditable
- role relationships remain advisory
- merge and cleanup gates remain deterministic under higher load
- rollback behavior is tested before any multi-writer enablement
- Mac-side verification passes
- Ubuntu host verification is run only when host runtime behavior is touched

## Stage Handoff Prompts

Use these prompts to hand each stage to a separate Codex session. Each prompt
assumes the session starts from the repository root.

Before working on any stage, read `AGENTS.md`,
`docs/CEO_OFFICE_ROADMAP.md#7-evidence-based-parallelism-expansion`, this
document's Assumptions, Non-Scope, current stage, and all previous stage
Outcome sections. Also check `git status --short` before editing and do not
revert unrelated user changes.

### M2 Prompt

Implement Phase 7 M2 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before coding, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` through M2, M1 Outcome,
`docs/PARALLELISM_EVIDENCE.md`, `src/lib/run-log.ts`,
`src/lib/remote-action-store.ts`, `src/lib/orchestrator-store.ts`,
`tests/parallelism-evidence.test.ts`, and nearby jsonl store tests such as
`tests/governance-event-store.test.ts` or `tests/cost-budget-audit.test.ts`.
Create the smallest structured parallelism evidence ledger needed to record
report-only parallel execution evidence without duplicating full run logs. Keep
`DEFAULT_SAFETY_POLICY.writerCap` at `1`. Add focused tests for append/list or
filter behavior, successful report-only parallel evidence, failed evidence
preservation, and no writer authority expansion. Update only directly relevant
docs if behavior changes. Verify with the narrow tests first, then
`bun run verify:mac` if the change is broad enough.

### M3 Prompt

Implement Phase 7 M3 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before coding, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` through M3, all previous Phase
7 stage Outcomes, `docs/PARALLELISM_EVIDENCE.md`,
`docs/SAFETY_AUDIT_GOVERNANCE.md` Phase 7 handoff notes,
`src/lib/contracts.ts`, `src/lib/policy.ts`, `src/lib/profile-governance.ts`,
`references/agent-profiles/*.json`, `tests/profile-governance.test.ts`, and
`tests/policy.test.ts`.
Add an advisory role topology contract for role relationships used by planning
and reporting. The topology must not grant dispatch, writer, connector, secret,
merge, push, cleanup, approval, or safety-policy authority. Tie changes to the
existing profile/capability governance baseline where appropriate. Add tests
that prove topology validates known roles, appears in operator-facing summaries,
and cannot change dispatch policy by itself. Keep writerCap `1`.

### M4 Prompt

Implement Phase 7 M4 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before coding, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` through M4, all previous Phase
7 stage Outcomes, `docs/PARALLELISM_EVIDENCE.md`, `src/lib/plan-runner.ts`,
`src/lib/orchestrator-materializer.ts`, `src/lib/worker-dispatch.ts`,
`src/lib/policy.ts`, `tests/operations.test.ts`,
`tests/orchestrator-materializer.test.ts`, `tests/worker-dispatch.test.ts`,
and `tests/parallelism-evidence.test.ts`.
Strengthen routine non-writer parallelism while keeping every non-writer
report-only, read-only, no-worktree, and no-merge. Extend materializer and
plan-runner coverage for reviewer + researcher + evaluator parallel batches,
non-writer write rejection, report-only tasks not depending on unmerged writer
output, and serialized writers under writerCap `1`. Do not add multi-writer
execution.

### M5 Prompt

Implement Phase 7 M5 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before coding, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` through M5, all previous Phase
7 stage Outcomes, `docs/PARALLELISM_EVIDENCE.md`,
`docs/OPERATING_SURFACE_CONSOLIDATION.md`, `src/lib/operator-reports.ts`,
`src/lib/ceo-status.ts`, `src/lib/dashboard.ts`,
`src/lib/telegram-reply-adapter.ts`, `tests/operator-reports.test.ts`,
`tests/ceo-status.test.ts`, `tests/dashboard.test.ts`, and
`tests/telegram-reply-adapter.test.ts`.
Improve operator-facing summaries for parallel specialist outcomes across the
existing report surfaces that are directly affected. Show role-specific
outcomes and project/goal ancestry without requiring BK to read raw action,
run, or status ids. Keep compact remote reports short. Add focused report,
CEO-status, dashboard, or Telegram tests matching the touched surfaces.

### M6 Prompt

Implement Phase 7 M6 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before coding, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` through M6, all previous Phase
7 stage Outcomes, `docs/PARALLELISM_EVIDENCE.md`,
`src/lib/orchestrator-materializer.ts`, `src/lib/merge-gate.ts`,
`src/lib/worktree.ts`, `src/lib/git.ts`, `tests/orchestrator-materializer.test.ts`,
`tests/merge-gate.test.ts`, `tests/worktree.test.ts`, and
`tests/parallelism-evidence.test.ts`.
Add deterministic conflict detection before any writer-cap expansion. Detect
overlapping target files, forbidden changes, same-repo write conflicts, stale
base commits, dirty target repo state, and unmerged writer dependencies as far
as the current codebase can support without speculative architecture. The
detector is advisory and must not increase writerCap or approve concurrency by
itself. Add focused tests for unsafe overlap, stale/dirty cases, missing
evidence, and writerCap staying `1`.

### M7 Prompt

Implement Phase 7 M7 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before coding, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` through M7, all previous Phase
7 stage Outcomes, `docs/PARALLELISM_EVIDENCE.md`, `src/lib/merge-gate.ts`,
`src/lib/run-lifecycle-store.ts`, `src/lib/run-log.ts`,
`src/lib/operator-reports.ts`, `tests/merge-gate.test.ts`,
`tests/run-lifecycle-store.test.ts`, `tests/operator-reports.test.ts`, and any
parallelism evidence store/tests added in M2.
Improve merge queue reliability under higher parallel evidence volume. Classify
merge candidates deterministically as mergeable, already merged, stale base,
failed verification, dirty target repo, missing commit, or blocked. Keep push
as a separate explicit gate. Connect outcomes to evidence/reporting only where
the current architecture has a natural hook. Add focused merge-gate tests and
avoid runtime authority expansion.

### M8 Prompt

Implement Phase 7 M8 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before coding, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` through M8, all previous Phase
7 stage Outcomes, `docs/PARALLELISM_EVIDENCE.md`,
`docs/ROLLBACK_AND_RECOVERY_DRILLS.md`, `src/lib/worktree-cleanup.ts`,
`src/lib/recovery-context.ts`, `src/lib/recovery-continuity.ts`,
`src/lib/recovery-drills.ts`, `tests/worktree-cleanup.test.ts`,
`tests/recovery-context.test.ts`, `tests/recovery-continuity.test.ts`, and
`tests/recovery-drills.test.ts`.
Strengthen cleanup and rollback drills for parallel-load conditions. Improve
classification for completed, dirty, missing, abandoned, and already-cleaned
worktrees. Document and test rollback paths through deterministic recovery or
operator action only; workers and non-writers must not receive rollback
authority. Add focused cleanup/recovery tests and update docs only for behavior
actually implemented.

### M9 Prompt

Implement Phase 7 M9 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before coding, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` through M9, all previous Phase
7 stage Outcomes, `docs/PARALLELISM_EVIDENCE.md`,
`docs/SAFETY_AUDIT_GOVERNANCE.md`, `src/lib/profile-governance.ts`,
`src/lib/governance-event-store.ts`, `src/lib/risk-policy.ts`,
`src/lib/policy.ts`, `tests/profile-governance.test.ts`,
`tests/governance-event-store.test.ts`, `tests/risk-policy.test.ts`, and any
parallelism evidence/conflict/merge/cleanup tests added in M2-M8.
Add a governance gate for writerCap changes. A writerCap increase must require
complete dogfood evidence, deterministic conflict detection evidence,
merge/cleanup/rollback evidence, and explicit BK approval with an auditable
diff. BK approval alone must not be enough. Add tests for insufficient evidence
blocking, approval-without-evidence blocking, complete-evidence passing, and
default writerCap remaining `1` unless a governed change is explicitly applied.

### M10 Prompt

Perform Phase 7 M10 from `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`.
Before writing the exit review, read `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
all of `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`, every previous Phase 7
stage Outcome, `docs/PARALLELISM_EVIDENCE.md`, `docs/ARCHITECTURE.md`,
`docs/DAEMON_OPERATIONS.md`, `docs/REMOTE_ADAPTERS.md`,
`docs/MULTI_PROJECT_OPERATIONS.md` Phase 6 exit review, and the tests/docs
changed by M2-M9.
Do not add new product scope. Review M1-M9 outcomes, collect dogfood evidence
for at least two active project profiles and one implementation flow with
parallel non-writers plus one writer, update roadmap/architecture/evidence docs
only for implemented behavior, and write the Phase 7 exit review. Run
`bun run verify:docs` and `bun run verify:mac`. Run host verification only if
host-owned runtime behavior was touched on the active automation host.
