# Samantha User Workflow Contract

Last updated: 2026-05-11

Status: canonical user workflow contract.

## Purpose

This document defines Samantha from BK's point of view.

The contract is not "which Telegram commands exist." The contract is:

```text
user-visible state -> BK decision -> Samantha action -> next state
```

Every routine report should make BK able to answer one question quickly:

```text
What should I do now?
```

If a report cannot answer that, the workflow is underspecified even if the
underlying command works.

## Current Workflow Problems

1. Status reports expose queue facts before the operator decision.
   `pending_requests=3` or `pressure=defer` is useful evidence, but BK needs the
   primary action first: approve the waiting decision, recover the failed plan,
   wait for the runner, or drop stale intake.
2. `/work` can be deferred by pressure, but the user journey does not clearly
   separate "request was saved" from "planning is not allowed yet." That makes
   BK wonder whether to resubmit, inspect, or clean the queue.
3. `/check` and `/problems` have different jobs, but the workflow does not make
   the handoff obvious. `/check` is compact state and pressure guidance.
   `/problems` is diagnostics when the adapter, host, daemon, queue, or reply
   path itself may be broken.
4. Telegram, CLI, and dashboard roles are documented as principles but not as a
   state contract. Telegram should carry the compact next action; CLI and
   dashboard should carry long review, local recovery, and operational repair.
5. Some next-action messages still mix inspection commands, execution commands,
   and fallback commands. The primary action must be one safe step, with deeper
   review as fallback rather than a competing path.

## Surface Contract

| Surface | Primary job | Must not become |
| --- | --- | --- |
| Telegram | Compact state, short intake, plan review pointer, approval, answer, revise, cancel, recovery request, pressure cleanup | Shell, arbitrary repo path input, internal id navigation, long debugging surface |
| CLI | Long review, exact diagnostics, local recovery, integration gates, backup/restore validation | Mobile notification stream |
| Dashboard | Read-only scan of queues, blockers, runs, lifecycle, and next action | Write or approval surface |

Routine rule:

- If BK is mobile or wants the next safe action, use `/now`.
- If BK needs compact evidence for why work is blocked, use `/check`.
- If BK needs to repair the runtime path, use `/problems` or CLI.
- If BK needs long review, use CLI or dashboard.

## Report Shape

Every user-facing workflow report should carry these meanings, even if the
literal headings differ by surface:

| Field | Meaning |
| --- | --- |
| State | What Samantha believes is true now. |
| BK question | The decision BK must make, if any. |
| Primary next action | One safest next step. |
| Telegram | The compact command when remote progress is safe. |
| CLI/dashboard fallback | The deeper review or repair surface. |
| Exit condition | What must become true before this state is done. |

For Telegram, the primary action should be one command whenever possible.
When Samantha cannot choose safely, it should list project-specific commands
instead of internal ids.

## Canonical Workflow

### 1. Start New Work

| Item | Contract |
| --- | --- |
| User-visible state | `# work`, "saved request", status `pending_plan`, and "no task/action was created." If admission was not accepted, show `Admission` and pressure reason. |
| BK question | "Is this request ready to plan now, or is the queue telling me to resolve something first?" |
| Primary next action | If accepted, create the plan. If deferred or blocked, resolve the pressure cause first. |
| Telegram | `/work <request>` then `/plan`; if pressure appears, `/check` first. |
| CLI/dashboard fallback | `bun run samantha ceo:status`, `bun run samantha orchestrator:current`, dashboard queue view. |
| Exit condition | A current orchestrator plan exists, or the request is canceled/dropped, or pressure is resolved enough to plan. |

Important distinction:

- Saved request means Samantha recorded the intake.
- Deferred admission means Samantha should not plan or dispatch it yet.
- A duplicate report saying "새 요청은 만들지 않았습니다" means BK should use the
  existing request instead of resubmitting.

### 2. Review Plan

| Item | Contract |
| --- | --- |
| User-visible state | `# plan` or `# now` says a plan exists, shows summary, selected path, risks, questions, and whether `/go` is safe. |
| BK question | "Is this the work I want Samantha to perform under these constraints?" |
| Primary next action | Re-read if needed, then approve, revise, answer, or cancel. |
| Telegram | `/plan_current`, `/go`, `/revise <feedback>`, `/answer <answer>`, `/cancel`. |
| CLI/dashboard fallback | `bun run samantha orchestrator:current`, dashboard current plan and queue state. |
| Exit condition | Plan is materialized, superseded, answered, or canceled. |

Plan review is not a brainstorming loop. If the plan is basically right,
approve it. If the plan is wrong in a way that affects scope, risk, or output,
revise it. If the work is no longer needed, cancel it.

### 3. Approve, Revise, Or Cancel

| Item | Contract |
| --- | --- |
| User-visible state | Samantha says whether it changed state: approved/materialized, revised into a new request, canceled, or blocked. |
| BK question | "Should this exact plan enter execution, should it change, or should it stop?" |
| Primary next action | Use one of the three exits. Do not add new work to avoid deciding. |
| Telegram | `/go`, `/revise <feedback>`, `/cancel`; `/approve` only when Samantha explicitly presents a single approval decision. |
| CLI/dashboard fallback | CLI decision reports for exact audit trail; dashboard for long plan comparison. |
| Exit condition | No current unapproved plan remains, or a revised pending request exists. |

The default approval path for normal orchestrator work is `/go` because it
validates and materializes the current safe plan. `/approve` is narrower: it
resolves exactly one current approval decision when Samantha explicitly asks
for that decision.

### 4. Wait For Execution

| Item | Contract |
| --- | --- |
| User-visible state | `# go` says task/action records were created, or `/now` says action is approved, waiting, or running. |
| BK question | "Is Samantha waiting on me, the runner, a dependency, or nothing?" |
| Primary next action | If running or waiting, monitor. If runner is not processing approved work, repair the active host. |
| Telegram | `/now`, then `/check` if status is unclear. |
| CLI/dashboard fallback | `bun run samantha actions:watch` on the active host, `bun run samantha actions:run-pending --limit=1`, dashboard live queue/run view. |
| Exit condition | All actions for the plan complete, fail, or produce a plan result report. |

Telegram does not start arbitrary workers. It approves safe state transitions.
The active automation host runs approved actions.

### 5. Handle Failure And Recovery

| Item | Contract |
| --- | --- |
| User-visible state | `# plan-result` or `/now` says failed, blocked, or verification failed, with the failing worker/result summary. |
| BK question | "Do I need a recovery plan, or is this a local runtime/host problem?" |
| Primary next action | For failed materialized plans, create a recovery request. For host/adapter failures, diagnose first. |
| Telegram | `/recover`, then `/plan`, then `/go`; `/problems` when runtime path is suspect. |
| CLI/dashboard fallback | `bun run samantha runs:show <run-id>`, `bun run samantha review:show <id>`, recovery drill reports, dashboard failure view. |
| Exit condition | Recovery plan passes, original issue is declared fixed, or BK cancels/archives the work after review. |

Do not blindly retry. Recovery requests must carry failure evidence and must use
canonical project roots, not old worker worktrees as the new source of truth.

CEO notifications are wake-up summaries, not diagnostics. When a current
blocker exists and no BK decision is pending, the notification should point to
`/check` first for the human summary and `/problems` only as the detailed
diagnostic fallback. It must identify the blocker by kind/status and reason; a
line that only says an internal id or `해당 항목` is not actionable.

Stale failed plan attempts are not current blockers once a later plan for the
same request has progressed. They remain audit history, but they must not keep
queue pressure or CEO status stuck in `needs_recovery`.

### 6. Resolve Queue Pressure

| Item | Contract |
| --- | --- |
| User-visible state | `/work`, `/check`, or `/problems` shows `Admission`, `Queue pressure`, pressure class, reason, and "Pressure 해결" guidance. |
| BK question | "What is blocking new intake: my decision, failed work, active execution, too many pending requests, host trouble, or budget policy?" |
| Primary next action | Clear the highest-priority pressure cause before adding more work. |
| Telegram | `/now`, `/check`, `/problems`, `/plan <project>`, `/drop stale project:<project>`, `/drop recovery project:<project>`, `/recover`, `/go`, `/answer <answer>`, `/revise <feedback>`, `/cancel`. |
| CLI/dashboard fallback | `bun run samantha ceo:status`, `bun run samantha doctor`, dashboard project queue and action views. |
| Exit condition | Queue admission returns `accept`, or BK intentionally cancels/drops the blocked intake. |

Pressure priority:

1. Unsafe host: repair with `/problems` or CLI before any work.
2. BK decision pending: answer, approve, revise, or cancel it.
3. Recovery needed: create or finish recovery; drop stale recovery only if it is
   truly obsolete.
4. Active action running: wait, or repair the active host runner if nothing is
   moving.
5. Too many pending requests: plan one current request or drop stale duplicates.
6. Lifecycle gap after a passed run: advance merge/push/cleanup through `/go`
   or local integration commands.
7. Budget gate: resolve the budget decision or cost-audit gap before intake.

The wrong response to pressure is to submit another `/work` request. That hides
the real blocker and increases the queue.

## Minimal Change Plan

Applied now:

1. Add this document as the canonical user workflow contract.
2. Point the playbook to this document as the first user-journey reference.
3. Point architecture and remote adapter docs to this document without adding
   Telegram commands.
4. Make remote `/now` explicit when no safe Telegram planning command exists.
5. Make remote `/check` a compact human summary instead of a long diagnostics
   dump.
6. Make CEO recovery notifications show the blocker kind/status and reason, and
   route current blocker review through `/check` before detailed `/problems`.
7. Treat failed plan attempts superseded by later plan progress as historical
   audit records, not current recovery blockers.

Future narrow code alignment, only if dogfood shows mismatch:

1. Normalize `now`, `work`, `plan`, `plan-result`, `check`, and `problems`
   reports around the report-shape fields above.
2. Keep queue pressure guidance action-first: decision, recovery, wait, drop,
   diagnose, or budget resolution.
3. Avoid new Telegram commands; improve wording and fallback routing instead.
