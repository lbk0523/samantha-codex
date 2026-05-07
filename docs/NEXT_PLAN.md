# Samantha-Codex Next Plan

Last updated: 2026-05-07

## Current Baseline

The first useful remote-work loop now exists, but the MVP priority is now status reporting and work operations rather than a Telegram-first command bot:

- `/work <request>` records an orchestration request.
- `/plan` runs `codex-orchestrator` in read-only mode and stores a structured plan.
- `/plan_current` rereads the current unapproved plan without rerunning Codex.
- `/revise <feedback>` supersedes the current unapproved plan and creates a new planning request.
- `/cancel` discards the current pending request or unapproved plan before task/action creation.
- `/go` validates the plan, materializes tasks/actions, approves dependency-free actions, and advances merge/push/cleanup gates for the latest passed run.
- `actions:watch` executes approved actions, promotes dependent actions after prerequisites pass, and marks dependent actions failed when prerequisites fail.
- `actions:watch` reruns `codex-orchestrator` in synthesis mode and writes one compact `# plan-result` report after all actions for a materialized plan finish.
- `/recover` turns the latest failed materialized plan result into a new orchestration request for the next `/plan`, with failed-plan context instead of a blind retry.

The Telegram command surface has been compressed and should remain an adapter for notification, approval, short feedback, and status checks. The supported routine commands are:

- `/start`
- `/help`
- `/now`
- `/work <request>`
- `/plan [project_id] [scope_id]`
- `/plan_current`
- `/revise <feedback>`
- `/cancel [reason]`
- `/go`
- `/recover`
- `/check`
- `/problems`

Older proposal/draft/task/action/run id commands are deprecated in Telegram and return replacement guidance. Local CLI and direct inbox commands remain available for debugging, recovery, and precise state inspection.

The deterministic CEO office remains responsible for safety, state, dispatch, verification, merge, push, cleanup, audit, and status reporting. The Orchestrator Agent is a bounded LLM call that proposes plans and synthesizes results; it does not stay alive to remember state and it does not bypass deterministic gates.

## Current Operating Status

- `.env` has the local Telegram bot token and chat id values.
- `doctor` reports no failures or warnings.
- pending inbox is `0`.
- unsent remote outbox reports are `0`.
- `/now` currently reports no immediate remote action and points to `/check`.
- Runtime state under `state/`, `runs/`, `outbox/`, and `archive/` remains local and ignored by Git.

## Keep Or Replace

Keep:

- Telegram poll/reply adapters and inbox/outbox loop
- daemon lock, heartbeat, doctor, status, and dashboard observability
- task ledger, run index, run logs, live logs, and lifecycle ledger
- worktree allocation, worker dispatch, setup commands, result evaluation, and Samantha-owned commits
- remote action gate and background `actions:watch`
- dependency-aware action promotion
- Orchestrator Agent planning and synthesis
- merge, push, cleanup, retry, and finalize gates
- plan runner batching logic for local/non-Telegram workflows

Demoted from Telegram:

- proposal/draft/task/action/run id entry
- `/next_action` as a routine Telegram command
- `/action_current` as the post-approval control point
- `/status` and `/doctor` as Telegram names; use `/check` and `/problems`
- hyphenated command aliases

Conclusion: the Control Plane still stands. The current product direction is to keep Telegram as a decision UI, not as an exposed internal command catalog.

Add:

- first-class status reporting and work operations model
- BK decision queue
- CLI and dashboard status views as primary review surfaces
- Telegram as notification and approval adapter

## Target Workflow

```text
BK
  -> checks CLI 또는 dashboard status report, or receives Telegram notification
Deterministic CEO Office
  -> reports active work, completed work, blockers, risks, BK decisions, and next actions
BK
  -> approves, redirects, or submits a small request
Bounded Orchestrator Agent Call
  -> proposes scope, risks, tasks, agents, dependencies, verification, or minimal BK questions
Deterministic CEO Office
  -> materializes approved plan into tasks/actions
  -> runs approved actions through actions:watch
  -> promotes dependencies safely
  -> verifies, records, and gates integration
Bounded Orchestrator Agent Call
  -> synthesizes final result report for BK
BK
  -> approves next gate, requests recovery, or reviews the next status report
```

## Next Objective

Improve the practical trustworthiness of Samantha as a status reporting and work operations system. N1-N3 focus on report quality, decision queues, and recovery without expanding Telegram commands.

The staged roadmap and the Stage 1 implementation plan are tracked in [CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md).

### Slice N1: Status Report Quality

Goal: make the core status report answer "what happened, what is active, what is blocked, what needs BK, and what is the next safe action?"

Build:

- report summary ordered by outcome, active work, blockers, BK decisions, risks, next action
- shorter worker/action detail by default, with raw ids hidden unless needed for local debugging
- clear distinction between implementation success, report-only success, verification failure, and recovery-needed state

Verify:

- report-only worker outputs are visible in CLI 또는 dashboard and can be compacted for Telegram
- `/now` after a completed plan recommends `/go`, `/recover`, `/check`, or `/problems`
- old id-based inspection commands are not recommended

### Slice N2: BK Decision Queue

Goal: separate "work is running" from "BK must decide" so reports do not bury approval or clarification needs.

Build:

- structured decision item fields for question, reason, target work, risk, and allowed responses
- status report section for pending BK decisions
- Telegram-ready compact decision notification
- deterministic rule that risky actions wait for approval instead of relying on LLM judgment

Verify:

- blocked tasks can create a decision item without dispatching new work
- reports show decisions before optional details
- approving or redirecting a decision updates durable state

### Slice N3: Recovery Execution

Goal: make `/recover -> /plan -> /go` reliable for failed materialized plans.

Build:

- recovery prompt context that includes failed plan summary, failed action reasons, relevant changed files, run-log references, and artifact previews
- stronger guardrail that recovery tasks use canonical project repo roots, never old worker worktrees
- recovery task validation that prevents stale failed tasks from polluting `/now`
- result reporting that makes clear whether the recovery fixed the original problem

Verify:

- failed plan result leads to `/recover`
- `/recover` creates a pending orchestration request without dispatching
- `/plan` proposes a canonical repo-root recovery plan
- `/go` materializes safe actions and reports back

### Slice N4: Adapter Dogfood

Goal: prove Telegram can carry the compact report and approval flow without becoming the primary workspace.

Dogfood flows:

```text
/work <small Samantha request> -> /plan -> /go -> /now -> /check
wrong plan -> /revise <feedback> -> /plan -> /go
failed plan result -> /recover -> /plan -> /go -> /now
deprecated command -> replacement guidance
```

Acceptance:

- BK does not need task ids, action ids, run ids, proposal ids, draft ids, repo paths, or target file paths.
- Telegram reports show one obvious next command.
- CLI or dashboard remains the better surface for long review.
- `/help` lists only the compressed command surface.
- `/check` and `/problems` are sufficient for routine remote operation.
- dashboard remains read-only observability.

## Guardrails

- The Orchestrator Agent cannot bypass CEO office safety checks.
- The Orchestrator Agent cannot directly dispatch workers.
- The Orchestrator Agent cannot merge, push, cleanup, or mutate state except through validated orchestration commands.
- LLM calls must not be required to stay alive to remember state.
- Project profiles remain useful as hints and defaults, not as the primary planning intelligence.
- Telegram must not accept arbitrary shell commands, arbitrary repo paths, arbitrary merge/push/cleanup paths, or id-based internal workflow commands.
- Existing direct task/draft/action commands may remain available locally for debugging, but they should not re-expand the Telegram surface.

## Implemented Slices

1. `/work` records orchestration requests.
2. `/plan` runs `codex-orchestrator` and stores structured plans.
3. `/plan_current` rereads the current unapproved plan without creating a duplicate plan.
4. `/revise <feedback>` supersedes the current unapproved plan and creates a new pending orchestration request with the feedback.
5. `/cancel` discards the current pending request or unapproved plan before task/action creation.
6. `/go` validates ready plans and materializes safe task/action records.
7. unsafe plans and plans with questions are blocked before task/action creation.
8. dependency-free actions are approved and dependent actions wait for prerequisites.
9. dependent actions are marked failed when prerequisite actions fail.
10. `actions:watch` writes action result reports.
11. `actions:watch` writes a plan-level result report after all materialized plan actions finish.
12. plan-level result reporting reruns `codex-orchestrator` in synthesis mode with deterministic fallback.
13. `/recover` turns the latest failed materialized plan result into a new pending orchestration request.
14. Telegram command surface is compressed and old id-based commands return deprecated guidance.
15. plan-result reports now show outcome, worker notes, changed/artifact paths, remaining risk, and one next safe Telegram command without routine raw ids.
16. recovery requests now carry failed plan summary, failed action reasons, changed files, run-log references, artifact previews, and explicit "do not retry blindly" instructions.
17. recovery planning/materialization guardrails prefer canonical project profile repo roots and reject worker-worktree repo roots.

The next slice should improve core status reports and the BK decision queue. Telegram dogfood should only verify the adapter after the core report is useful.

## Next Slice: Role-Aware Canary

Before expanding into a full multi-agent platform, dogfood one narrow role-aware plan:

```text
/work <small Samantha request>
  -> /plan
     batch 1: codex-reviewer or codex-evaluator report-only preflight
     batch 2: codex-worker write task
  -> /go
  -> /now
```

Acceptance:

- the Orchestrator Agent chooses roles deliberately instead of defaulting every task to `codex-worker`
- non-writer role tasks use `resultMode: "report"` and do not edit files
- the writer task still runs under writer cap `1`
- dependent writer tasks do not assume they can read unmerged files from prior worker worktrees
- Telegram reports explain role outcomes without requiring raw task/action/run ids

Do not expand this slice into multi-writer parallelism, shared worktree context, or general team-construction automation.

## Deferred Scope: New Project Dogfood

Fully bootstrapping a new project from Telegram remains out of scope until Samantha has an explicit onboarding gate. Current remote materialization intentionally requires known project profiles and canonical repo roots, so Telegram should not accept arbitrary repo paths, shell bootstrap commands, or unprofiled project creation.
