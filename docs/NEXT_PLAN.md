# Samantha-Codex Next Plan

Last updated: 2026-05-05

## Current Baseline

The Control Plane plus first Orchestrator Agent slice exists and has passed local, simulated Telegram, and OMHT recovery-planning dogfood checks:

- run index and task ledger
- operator CLI
- merge candidate checks
- explicit `merge:apply`, `merge:push`, and completed worktree cleanup gates
- run lifecycle ledger for merge/push/cleanup state
- plan runner
- local `inbox:watch` daemon with heartbeat and lock protection
- narrow Telegram polling into the inbox
- Telegram outbox replies
- proposal intake/review and accepted-proposal task drafts
- project profiles and local-only task approval/dispatch
- Telegram-approved dispatch action gate
- task draft readiness summaries and patch templates
- read-only static operations dashboard
- Codex Orchestrator Agent planning and synthesis
- persistent orchestration request and plan state
- `/work -> /plan -> /go` plan materialization
- `/plan_current`, `/revise`, `/cancel`, and `/recover`
- dependency-aware action promotion
- automatic tmux observer cleanup after worker completion

Current operating status:

- `.env` has the local Telegram bot token and chat id values.
- `doctor` reports no failures or warnings.
- pending inbox is `0`.
- unsent remote outbox reports are `0`.
- `/now` and `/next_action` currently report the latest failed materialized plan and recommend `/recover`.
- The latest recovery dogfood failed before the control-plane guardrails were added; a copied-state dogfood now shows `/recover -> /plan -> /go` producing canonical OMHT repo actions.

Runtime state under `state/`, `runs/`, `outbox/`, and `archive/` remains local and ignored by Git.

## Current Objective

Finish the first trustworthy Telegram remote-work loop by dogfooding real Telegram `/recover -> /plan -> /go` on the current runtime state, then commit and push the control-plane/orchestrator changes once that live loop is acceptable.

## Keep Or Replace

Keep these components:

- Telegram poll/reply adapters and inbox/outbox loop
- daemon lock, heartbeat, doctor, status, and dashboard observability
- task ledger, run index, run logs, live logs, and lifecycle ledger
- worktree allocation, worker dispatch, setup commands, result evaluation, and Samantha-owned commits
- remote action gate and background `actions:watch`
- merge, push, cleanup, retry, and finalize gates
- plan runner batching logic for non-writer parallelism and writer serialization

Demoted components:

- project-profile-template `/plan` as the main planning mechanism
- one draft -> one task -> one `dispatch_task` as the only normal execution shape
- Telegram guidance that treats `/action_current` as the main post-approval control point

Conclusion: this was not a full rewrite. The Control Plane remains; the Orchestrator Agent now sits above it for the primary Telegram workflow.

## Target Workflow

```text
BK
  -> /work <request>
Samantha Orchestrator Agent
  -> interprets request
  -> asks clarification only when needed
  -> proposes scope, risks, tasks, agents, dependencies, and verification
BK
  -> /go or revision feedback
Samantha Control Plane
  -> materializes approved plan into tasks/actions
  -> runs reviewer/evaluator/spec agents in parallel when useful
  -> runs at most one writer at a time
  -> verifies, records, and gates integration
Samantha Orchestrator Agent
  -> synthesizes final result report for BK
```

## Next Implementation Plan

### Phase O1: Orchestration State Model

Add append-only state for orchestration-level records:

- `state/orchestrator-requests.jsonl`
- `state/orchestrator-plans.jsonl`
- `state/orchestrator-runs.jsonl`

Minimum records:

- request id, source, sender, raw text, created time
- plan id, request id, status, assumptions, scope, non-scope, risks, questions, task proposals, execution batches
- run id, plan id, materialized task ids, action ids, worker run ids, final synthesis status

Status:

- implemented as `state/orchestration-requests.jsonl` and `state/orchestrator-plans.jsonl`
- `/work <request>` records an orchestration request, not a task draft
- `/now` and `/next_action` show planning, approval, action, recovery, and diagnostic next steps

### Phase O2: Orchestrator Agent Profile And Prompt

Add a `codex-orchestrator` profile and a strict prompt contract.

The Orchestrator Agent may inspect the repo and state, but it must not edit files, dispatch workers, merge, push, or run arbitrary project-changing commands. It returns structured JSON plus a concise Telegram-readable plan.

Required output:

- request summary
- assumptions
- clarifying questions, if needed
- recommended project/repo
- task decomposition
- proposed agents
- dependencies and parallelizable batches
- target files and forbidden changes per writer task
- verification commands
- risk level
- user-facing plan message

Status:

- implemented via `references/agent-profiles/codex-orchestrator.json` and `src/lib/orchestrator-agent.ts`
- malformed payloads are rejected
- generated plans are validated before materialization
- prompt now requires canonical project repo roots and forbids `.samantha-worktrees` as task `repoRoot`

### Phase O3: Telegram Plan Flow

Change the primary Telegram path:

```text
/work <request> -> /plan -> /go
```

New behavior:

- `/work` stores the request and returns `/plan`.
- `/plan` runs or resumes the Orchestrator Agent and returns its plan message.
- `/plan_current` shows the current unapproved plan again without rerunning the Orchestrator Agent.
- If the plan has questions, `/go` is blocked until BK answers or revises the request.
- If the plan is ready, `/go` approves the orchestration plan, not a single task draft.
- If the plan is wrong, `/revise <feedback>` supersedes it and returns to planning without exposing task ids or repo paths.
- If the plan or request is obsolete, `/cancel` discards it before any task/action is created.

Status:

- implemented for `/work`, `/plan`, `/plan_current`, `/go`, `/revise`, `/cancel`, and `/recover`
- plan text is generated by the Orchestrator Agent
- BK can approve without typing repo paths or target files

### Phase O4: Plan Materialization

Convert an approved orchestrator plan into existing Control Plane artifacts:

- task specs in `state/tasks.jsonl`
- dispatch actions in `state/remote-actions.jsonl`
- optional plan-run record that groups actions

Reuse current safety gates. The Orchestrator Agent proposes; the Control Plane validates.

Status:

- implemented through `src/lib/orchestrator-materializer.ts`
- one plan can materialize multiple task/action records
- dependency-free actions are approved and dependent actions wait
- invalid target/forbidden/verify fields and unsafe repo roots block before task/action creation

### Phase O5: Worker Team Execution And Final Synthesis

Extend `actions:watch` or add a plan runner action type that tracks plan-level completion.

After workers finish, run the Orchestrator Agent again in synthesis mode:

- summarize worker outputs
- identify failures and recovery options
- recommend next BK action
- report changed files, run logs, verification, and merge candidates

Status:

- implemented in `actions:watch`/`actions:run-pending`
- Telegram receives action result reports and one plan-level `# plan-result`
- failed materialized plans lead to `/recover`
- dependent tasks are marked failed when their prerequisite action fails, so stale pending tasks do not pollute next-action guidance

### Phase O6: Remaining Live Dogfood

The current code has passed automated tests and copied-state recovery dogfood. Before calling the Telegram remote-work loop complete, run the real runtime-state Telegram flow:

```text
/recover -> /plan -> /go -> /action_current -> plan result
```

Acceptance:

- `/plan` proposes canonical project repo roots, not worker worktree roots.
- `/go` materializes actions without exposing repo paths or target files to BK.
- `actions:watch` executes and sends action/result reports.
- no stale pending task remains after dependency failure.
- no tmux observer window remains after workers finish.

## Guardrails

- The Orchestrator Agent cannot bypass Control Plane safety checks.
- The Orchestrator Agent cannot directly dispatch workers.
- The Orchestrator Agent cannot merge, push, cleanup, or mutate state except through validated orchestration commands.
- Project profiles remain useful as hints and defaults, not as the primary planning intelligence.
- Existing direct task/draft commands stay available as advanced/manual fallback paths.

## Implemented Slices

The first two slices are now in place:

1. `/work` records orchestration requests.
2. `/plan` runs `codex-orchestrator` and stores structured plans.
3. `/go` validates ready plans and materializes safe task/action records.
4. unsafe plans and plans with questions are blocked before task/action creation.
5. `actions:watch` writes a plan-level result report after all materialized plan actions finish.
6. dependent actions wait for prerequisite action success before they are approved for execution.
7. plan-level result reporting reruns `codex-orchestrator` in synthesis mode with deterministic fallback.
8. `/recover` turns the latest failed materialized plan result into a new pending orchestration request.
9. `/revise <feedback>` supersedes the current unapproved plan and creates a new pending orchestration request with the feedback.
10. `/cancel` discards the current pending request or unapproved plan before task/action creation.
11. `/plan_current` rereads the current unapproved plan without creating a duplicate plan.

The next slice should focus on improving remote completion reporting and recovery execution after `/recover -> /plan -> /go`, not more Telegram command compression.
