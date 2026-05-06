# Samantha-Codex Next Plan

Last updated: 2026-05-06

## Current Baseline

The first useful Telegram remote-work loop now exists:

- `/work <request>` records an orchestration request.
- `/plan` runs `codex-orchestrator` in read-only mode and stores a structured plan.
- `/plan_current` rereads the current unapproved plan without rerunning Codex.
- `/revise <feedback>` supersedes the current unapproved plan and creates a new planning request.
- `/cancel` discards the current pending request or unapproved plan before task/action creation.
- `/go` validates the plan, materializes tasks/actions, approves dependency-free actions, and advances merge/push/cleanup gates for the latest passed run.
- `actions:watch` executes approved actions, promotes dependent actions after prerequisites pass, and marks dependent actions failed when prerequisites fail.
- `actions:watch` reruns `codex-orchestrator` in synthesis mode and writes one compact `# plan-result` report after all actions for a materialized plan finish.
- `/recover` turns the latest failed materialized plan result into a new orchestration request for the next `/plan`, with failed-plan context instead of a blind retry.

The Telegram command surface has been compressed. The supported routine commands are:

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

The Control Plane remains responsible for safety, state, dispatch, verification, merge, push, cleanup, and audit. The Orchestrator Agent proposes plans and synthesizes results; it does not bypass Control Plane gates.

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

## Target Workflow

```text
BK
  -> /work <request>
Samantha Orchestrator Agent
  -> interprets request
  -> asks clarification only when needed
  -> proposes scope, risks, tasks, agents, dependencies, and verification
BK
  -> /go or /revise <feedback>
Samantha Control Plane
  -> materializes approved plan into tasks/actions
  -> runs approved actions through actions:watch
  -> promotes dependencies safely
  -> verifies, records, and gates integration
Samantha Orchestrator Agent
  -> synthesizes final result report for BK
BK
  -> /go for merge/push/cleanup gates, /recover for failed plan result, or /check
```

## Next Objective

Improve the practical trustworthiness of the compressed Telegram workflow. N1-N3 now focus the result and recovery loop after a plan has been executed, without adding more Telegram commands.

### Slice N1: Result Report Quality

Goal: make plan-result messages short enough to read on Telegram while still answering "what happened, what changed, what do I do next?"

Build:

- plan-result summary ordered by outcome, changed files/artifacts, risks, next action
- shorter worker/action detail by default
- clear distinction between implementation success, report-only success, verification failure, and recovery-needed state
- no raw ids unless needed for local debugging

Verify:

- report-only worker outputs are visible in Telegram without opening local files
- `/now` after a completed plan recommends `/go`, `/recover`, `/check`, or `/problems`
- old id-based inspection commands are not recommended

### Slice N2: Recovery Execution

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

### Slice N3: Real Telegram Dogfood

Goal: prove the compressed command surface works from Telegram without local command knowledge.

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
- `/help` lists only the compressed command surface.
- `/check` and `/problems` are sufficient for routine remote operation.
- dashboard remains read-only observability.

## Guardrails

- The Orchestrator Agent cannot bypass Control Plane safety checks.
- The Orchestrator Agent cannot directly dispatch workers.
- The Orchestrator Agent cannot merge, push, cleanup, or mutate state except through validated orchestration commands.
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

The next slice should be live Telegram dogfood and only fix concrete gaps found in those flows.
