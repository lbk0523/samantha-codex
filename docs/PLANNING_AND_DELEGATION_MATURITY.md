# Planning And Delegation Maturity

Last updated: 2026-05-08

Status: active.

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

## Exit Criteria

- Samantha can create useful plans for ambiguous work without immediately
  dispatching unsafe tasks.
- Plan materialization remains deterministic and validated.
- Worker prompts are role-aware and narrow.
- Failed or incomplete plans produce actionable recovery paths.
- BK can see assumptions, tradeoffs, prerequisites, selected role strategy, and
  one next safe action from the operating surface.
