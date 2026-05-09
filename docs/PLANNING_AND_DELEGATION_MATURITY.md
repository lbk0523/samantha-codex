# Planning And Delegation Maturity

Last updated: 2026-05-09

Status: implemented.

This document contains the execution stages for roadmap Phase 4:
[Planning And Delegation Maturity](CEO_OFFICE_ROADMAP.md#4-planning-and-delegation-maturity).

This phase assumes Phase 3 is implemented: the CLI, dashboard, and Telegram
surfaces now share one operating view, and the current orchestrator flow can
create, revise, materialize, recover, and synthesize bounded plans through
deterministic gates.

## Assumptions

- The deterministic CEO Office remains the owner of durable state, task/action
  creation, approval, dispatch, merge, push, cleanup, recovery, and audit.
- LLM orchestrator calls remain bounded proposal generators.
- The current writer cap remains `1`; Phase 4 may improve non-writer
  delegation quality but does not enable multi-writer execution.
- Existing plan, synthesis, and question-draft payloads should remain compatible
  unless a schema migration is explicitly implemented with tests.
- Mac-side work may edit, test, and document normal repo code. Ubuntu host
  runtime verification remains host-owned.

## Non-Scope

- No direct worker dispatch from Telegram, dashboard, or LLM output.
- No arbitrary shell commands, repo paths, or internal ids in normal Telegram
  workflows.
- No LLM-owned durable state mutation.
- No automatic retry after failed plans or failed workers.
- No writer concurrency increase.
- No Phase 5 governance, immutable audit, or rollback expansion unless needed
  to keep Phase 4 behavior safe.

## P1: Planning Baseline And Fixtures

Goal: define what "better planning" means before changing planner behavior.

Focus:

- current orchestrator prompt, payload validation, materialization, synthesis,
  and question-draft behavior
- representative request fixtures for implementation, planning/report,
  review/spec/evaluation, recovery, and ambiguous work
- negative fixtures for unsafe delegation, overbroad target files, missing
  verification, stale worker worktree roots, and parallel writers
- Korean and English request examples where wording changes classification

Verification focus:

- baseline fixture tests describe current accepted and rejected plans
- unsafe or ambiguous payloads are rejected before state mutation
- docs identify which gaps belong to later Phase 4 stages

## P2: Request Classification Maturity

Goal: classify incoming work more deliberately before the orchestrator proposes
tasks.

Focus:

- distinguish implementation, planning/report, review, spec, evaluation,
  recovery, and ambiguity-heavy requests
- keep project and remote-scope selection explainable in reports
- prefer questions or report-only work when implementation would be unsafe
- improve Korean and English intent handling without making the classifier a
  hidden dispatcher

Verification focus:

- deterministic classifier tests for mixed Korean and English phrases
- explicit fallback behavior when project or scope is unknown
- reports show the selected classification and safe next command

## P3: Plan Alternatives And Tradeoffs

Goal: make plans show the chosen approach, rejected alternatives, and tradeoffs
without letting alternatives materialize accidentally.

Focus:

- a compact advisory shape for alternatives and tradeoffs
- prompt guidance that asks for the simplest safe approach first
- materialization that uses only the selected task set
- compact Telegram wording and fuller CLI/dashboard wording

Verification focus:

- parser and reporter tests for alternatives
- `/go` materializes only the selected plan path
- plans with open questions still contain no task proposals or batches

## P4: Task Decomposition And Dependency Clarity

Goal: produce worker tasks that are narrow, role-aware, and safe to run through
the existing action gates.

Focus:

- one writer task should include its own verification instead of creating a
  dependent verify-only task for unmerged changes
- non-writer report tasks may run before or beside one writer when they reduce
  concrete risk
- `targetFiles`, `forbiddenChanges`, setup, verify commands, and instructions
  must be specific enough for the dispatch gate
- dependency and batch semantics should be visible in reports without raw
  internal noise

Verification focus:

- materializer rejects unknown dependencies, dependency cycles, and parallel
  writers
- non-writer write proposals are rejected
- dependent actions promote only after prerequisites pass
- parallel report-only outcomes remain readable

## P5: Prerequisite And Blocker Handling

Goal: separate true work tasks from prerequisites, blockers, and BK decisions.

Focus:

- classify missing context as questions instead of speculative tasks
- surface local prerequisites such as missing repo root, missing profile,
  missing verify command, or host-only runtime requirement
- keep recovery from blindly retrying failed work
- show one deterministic next action when a plan cannot safely proceed

Verification focus:

- `/go` blocks unsafe plans before writing tasks or actions
- `/now`, CLI reports, and Telegram reports show the same safe next action
- host-only prerequisites are not represented as Mac-side runtime commands

## P6: Role Profile Expansion

Goal: make specialist roles useful while keeping all non-writers report-only.

Focus:

- sharpen existing `codex-spec`, `codex-reviewer`, and `codex-evaluator`
  prompts and profile contracts
- add researcher, content, or operations profiles only after their contract,
  result mode, and safety behavior are explicit
- keep `codex-worker` as the only production writer role
- ensure external skills cannot override Samantha safety policy

Verification focus:

- profile validation rejects unknown or unsafe writer behavior
- new specialist roles, if added, use `resultMode: "report"`,
  `worktreePolicy: "none"`, and `mergePolicy: "none"`
- role-specific tasks produce useful report artifacts without changed files

## P7: Bounded Synthesis And Recovery Quality

Goal: make completed-plan synthesis accurate, compact, and recovery-ready.

Focus:

- summarize only Samantha-provided evidence
- distinguish pass, mixed, failed, blocked, and still-needs-BK outcomes
- preserve changed files, report artifacts, failed verify details, and run-log
  paths as evidence
- recommend exactly one next safe Telegram command
- keep recovery requests on canonical project profile roots

Verification focus:

- synthesis payload validation covers outcome, risks, and next actions
- fallback deterministic plan-result reports remain useful when synthesis fails
- successful linked recovery suppresses stale failed-plan noise
- failed recovery keeps the original problem visible

## P8: Ambiguity Question Drafting Maturity

Goal: turn ambiguity into a high-signal BK decision instead of unsafe work.

Focus:

- decide when plain plan questions are sufficient and when
  `orchestrator:question-draft` is useful
- keep drafted questions concise, option-limited, risk-aware, and subject-linked
- ensure question drafts never resolve themselves or advance execution
- make answer/revise/cancel paths clear from Telegram and CLI reports

Verification focus:

- question-draft payload validation
- decision queue conversion and CEO next-action behavior
- no materialization while blocker clarification is pending

## P9: Dogfood And Exit Gates

Goal: prove the mature planning path on real Samantha work before moving to
Phase 5.

Focus:

- dogfood ambiguous work, recovery work, report-only specialist work, and one
  writer implementation plan
- document examples where alternatives, tradeoffs, prerequisites, and role
  choices changed the plan outcome
- update architecture, adapter, and parallelism evidence docs only where actual
  behavior changed
- capture Phase 5 safety, audit, and governance follow-ups without implementing
  them in Phase 4

Verification focus:

- Mac-side verification:

```bash
bun typecheck
bun run test:portable
bun run verify:docs
bun run verify:mac
```

- Ubuntu host verification, when host runtime behavior is touched:

```bash
bun run test:host
bun run test:all
bun run verify:host
```

Do not run Samantha daemon, watch, poll, reply, worker dispatch, or dashboard
runtime processes from Mac.

P9 outcome: completed for the deterministic planning path. This stage did not
add new runtime behavior; it reviewed the mature Phase 4 behavior already
covered by focused tests and existing architecture, remote-adapter, and
parallelism evidence docs.

Dogfood evidence:

| Case | Evidence | Exit-gate outcome |
| --- | --- | --- |
| Ambiguous work | `tests/project-profile.test.ts` classifies unclear Korean/English requests as `ambiguity_heavy` with `questions_first`; `tests/orchestrator-planning-baseline.test.ts` keeps ambiguous plans question-only; `tests/operator-reports.test.ts` shows `/revise <feedback>` instead of `/go`. | Met: ambiguous work produces BK clarification instead of unsafe task materialization. |
| Recovery work | `tests/recovery-context.test.ts`, `tests/recovery-continuity.test.ts`, `tests/operations.test.ts`, and `tests/orchestrator-materializer.test.ts` cover `/recover -> /plan -> /go`, failed-plan evidence, canonical project roots, and rejection of old worker worktree roots. | Met: recovery is evidence-driven and does not blindly retry failed workers. |
| Report-only specialist work | `tests/orchestrator-materializer.test.ts`, `tests/worker-dispatch.test.ts`, and `tests/codex-dispatch.test.ts` cover role-aware `codex-spec`, `codex-reviewer`, `codex-evaluator`, `codex-researcher`, `codex-content`, and `codex-operations` report-only contracts. | Met: non-writers remain read-only, produce reports, and fail if they edit files. |
| One-writer implementation plan | `tests/orchestrator-materializer.test.ts`, `tests/operations.test.ts`, `tests/policy.test.ts`, and `tests/parallelism-evidence.test.ts` cover selected-plan-only materialization, advisory alternatives, writer cap `1`, and readable report-only specialist plus writer outcomes. | Met: implementation plans can use report-only risk reducers, but only one writer materializes at a time. |

Behavior documentation reviewed:

- [ARCHITECTURE.md](ARCHITECTURE.md) records that bounded LLM calls are proposal
  generators and that Samantha keeps durable state, execution, and safety gates.
- [REMOTE_ADAPTERS.md](REMOTE_ADAPTERS.md) records the `/work -> /plan -> /go`
  path, `/recover`, plan blockers, and selected-plan-only materialization.
- [PARALLELISM_EVIDENCE.md](PARALLELISM_EVIDENCE.md) records that P9 does not
  increase `writerCap`; report-only non-writer confidence remains separate from
  any future multi-writer decision.

## P10: Clarification Gate Closure

Goal: close the remaining P8 ambiguity-question gaps so pending blocker
clarification decisions cannot be bypassed by plan materialization and are
clearly answerable from the operating surface.

Reason for this stage:

- Review found that pending `blocker_clarification` decisions are not a hard
  `/go` materialization gate unless the latest decision for the current
  `orchestrator_plan` subject is itself the blocker clarification.
- Review found that `/now` does not load decision queue state, so non-approval
  blocker clarification decisions can be visible in `ceo:status` while `/now`
  still reports plan/action state instead of answer/revise/cancel guidance.

Focus:

- Treat pending `blocker_clarification` decisions as a deterministic
  materialization blocker before creating tasks, actions, or marking a plan
  materialized.
- Make `/now` decision-aware enough to show pending blocker clarification
  answer/revise/cancel guidance before plan/action progress guidance.
- Keep Telegram as a thin adapter: no decision ids or shell commands in routine
  remote workflows, and no direct worker dispatch from Telegram.
- Keep the deterministic CEO Office as the owner of durable state and safety
  gates.
- Keep writer cap `1`; do not enable multi-writer execution.

Verification focus:

- `/go` creates no tasks, actions, or materialized plan while any current
  `blocker_clarification` is pending, including clarification decisions linked
  to `run`, `task`, or `remote_action` subjects.
- `/now`, compact CEO notification, CLI CEO status, and dashboard/operating
  surface all show one consistent safe next action for pending blocker
  clarification.
- Plan approval decisions still use the narrow existing `/approve` path only
  when exactly one current plan approval decision is pending.
- Resolved or archived blocker clarification decisions do not block later safe
  materialization.
- Existing P1-P9 behavior remains unchanged: selected-plan-only materialization,
  report-only non-writers, recovery continuity, bounded synthesis, and writer
  cap `1`.

Mac-side verification:

```bash
bun test tests/operations.test.ts tests/operator-reports.test.ts tests/ceo-status.test.ts
bun run verify:mac
```

P10 outcome: completed by `fc9b49b Close clarification materialization gate`.
Pending blocker clarification decisions now block plan materialization, `/now`
loads decision queue state, and the operating surface prioritizes blocker
clarification before approved-plan progress. Review after implementation found
one remaining workflow gap: Telegram can display answer guidance for blocker
clarification, but there is not yet a dedicated Telegram command that resolves
that decision without revising the plan.

## P11: Telegram Answer Command

Goal: add a narrow Telegram answer path for blocker clarification decisions so
BK can keep the current plan while recording the clarifying judgment that
unblocks later deterministic gates.

Reason for this stage:

- P10 correctly blocks `/go` while blocker clarification is pending.
- P10 reports currently suggest `/revise <answer>` for clarification answers,
  but `/revise` means "supersede the current plan and create a revised planning
  request." That is the wrong semantic for "keep this plan, record BK's answer,
  and let Samantha recalculate the next safe action."
- The missing operation is decision resolution, not plan revision.

Command semantics:

- Add `/answer <text>` as a Telegram command for exactly one current pending
  `blocker_clarification` decision.
- `/answer` resolves only that blocker clarification decision with
  `resolution: "answered"` and stores `<text>` as the decision note.
- `/answer` must not approve a plan, materialize tasks/actions, dispatch
  workers, merge, push, clean up, or mutate the plan payload.
- `/answer` preserves the current plan. After it records the answer, BK should
  use `/now` or `/go` to let the deterministic CEO Office recompute the next
  safe action.
- `/revise <feedback>` remains the command for changing/superseding the
  current plan.
- `/approve` remains only for current plan approval decisions.
- If there is no current pending blocker clarification, `/answer` should return
  a safe no-op/redirect report instead of resolving unrelated decisions.
- If more than one current pending blocker clarification exists, `/answer`
  should not guess; it should redirect BK to `/now`, CLI, or dashboard.

Focus:

- Remote command parsing for `/answer <text>` without accepting decision ids.
- Inbox handling that resolves exactly one current pending blocker
  clarification and writes an id-free report.
- `/now`, compact CEO notifications, operating surface, and decision-required
  reports should say `답변: /answer <답변>` for blocker clarification.
- Existing `/revise` reports should remain plan-revision oriented.
- The hard materialization gate from P10 must remain in force until the
  blocker clarification is resolved.

Verification focus:

- `/answer <text>` with exactly one current pending blocker clarification
  resolves that decision as `answered`, stores the note, leaves the plan
  unchanged, and creates no tasks/actions.
- After `/answer`, an already-approved safe plan can materialize through a
  separate `/go`.
- `/answer` does not approve plan approval decisions and does not affect
  ordinary `orchestrator_questions` decisions.
- `/answer` with zero or multiple current pending blocker clarifications does
  not mutate state and reports the safe next inspection/action.
- `/revise <feedback>` still supersedes the current unapproved plan and creates
  a revised planning request.
- `/approve` still approves only the single current plan approval decision.
- Telegram reports remain id-free for routine operation.

Mac-side verification:

```bash
bun test tests/remote-command.test.ts tests/operations.test.ts tests/operator-reports.test.ts tests/operating-surface.test.ts tests/remote-approval.test.ts
bun run verify:mac
```

P11 outcome: completed. Telegram `/answer <text>` now resolves exactly one
current pending `blocker_clarification` decision as `answered`, stores the
answer note, preserves the current plan, and creates no tasks or actions.
`/go` remains blocked until the clarification is resolved, and `/approve` still
applies only to the single current plan approval decision.

Phase 5 follow-ups, explicitly outside Phase 4:

- stronger safety-policy contracts and dangerous-transition tests
- explicit risk classification across requests, plans, actions, merges, pushes,
  cleanup, and recovery
- richer audit trails and immutable event views for decisions, actions, runs,
  merges, pushes, cleanup, and recovery
- operator review reports that reconstruct a completed work item from request
  to final state
- documented rollback and recovery drills for larger or riskier work
- any writer-cap increase, multi-writer execution, or general agent-team
  construction

## Exit Criteria

- Met: Samantha can create useful plans for ambiguous work without immediately
  dispatching unsafe tasks.
- Met: plan materialization remains deterministic and validated.
- Met: worker prompts are role-aware and narrow.
- Met: failed or incomplete plans produce actionable recovery paths.
- Met: BK can see assumptions, tradeoffs, prerequisites, selected role
  strategy, and one next safe action from the operating surface.
