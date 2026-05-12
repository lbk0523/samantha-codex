# North Star

Last updated: 2026-05-12

This document defines what it means for Samantha's Deterministic CEO Office to
reach the north star.

Status: control-plane baseline achieved; CEO conversation product experience
reopened after autopilot dogfood.

This declaration does not expand Samantha's authority. It records that the
Phase 1-9 control-plane work satisfies the safety and state-management baseline
below, while preserving the same deterministic safety gates and explicit
non-goals. Autopilot dogfood showed that the command-driven flow is not good
enough as a product experience. The next product direction is a natural
turn-by-turn CEO conversation layer backed by deterministic state and policy.

## Target Product

Samantha is BK's personal development operations control plane and CEO
conversation partner.

BK should be able to run real product work through Samantha by talking in
natural language at roughly the breadth and flexibility of the current Codex
CLI conversation.

BK should not have to track every worker, task id, run id, branch, recovery
path, or internal workflow command. Samantha should own safe progress until the
next useful CEO conversation turn, result, approval boundary, or local repair
boundary.

The durable operating authority is deterministic TypeScript code. The natural
CEO layer may discuss, reason, remember context, and propose work, but it does
not directly grant runtime authority.

## Operating Model

BK:

- sets direction
- approves risky or ambiguous decisions
- receives periodic reports
- redirects priorities when needed

Samantha CEO Conversation Layer:

- supports broad natural owner/CEO discussion
- understands goals, constraints, priorities, risk, and feedback
- retrieves short-term context and long-term memory
- translates conversation into structured proposals or safe transition requests
- responds in CEO/assistant language instead of exposing internal command
  choreography

Deterministic TypeScript Kernel:

- owns durable state
- owns safe progress, approval boundaries, and execution authority
- schedules reports
- manages queues
- validates plans
- gates dispatch, merge, push, cleanup, and recovery
- records audit history
- asks BK only when a decision is required

Bounded LLM Agents:

- handle scoped planning, synthesis, review, research, content, operations, and
  code tasks
- operate under explicit prompts and file scopes
- return structured results
- do not bypass deterministic safety gates

## Product Criteria

Samantha reaches the north star when all of the following are true:

- BK can inspect the state of work from one operating surface.
- BK can converse with Samantha naturally at Codex CLI-level breadth and
  flexibility.
- Periodic CEO reports clearly explain finished work, active work, blockers,
  risks, required BK decisions, and recommended next actions.
- Compact adapters such as Telegram are practical because they handle
  notifications, approvals, and short feedback without defining the core
  product workflow.
- Dashboard and CLI support long review and recovery without requiring BK to
  inspect raw state files.
- Routine safe progress does not require BK to drive command choreography.
- Conversation memory preserves decisions, product direction, progress, and
  rejected approaches across turns without granting execution authority.
- Risky, ambiguous, or irreversible actions require explicit approval.
- Delegated autonomy expands only through evidence-backed authority grants that
  BK explicitly approves.
- Planning and synthesis can use LLM judgment, but validated deterministic code
  owns state mutation.
- Worker execution is isolated, auditable, and recoverable.
- Multi-agent parallelism expands only after evidence supports it.
- Host automation can run continuously and reports its own failures.
- State can be backed up, restored, and audited.

## Phase 10 Exit Review And CEO Conversation Correction

The original Phase 10 declaration remains valid as a control-plane safety
baseline. The product experience is reopened because dogfood showed that a safe
command bot still wastes BK's time when Samantha should behave like a natural
turn-by-turn CEO/assistant.

| North-star criterion | Status | Evidence |
| --- | --- | --- |
| BK can inspect the state of work from one operating surface. | Met. CLI, dashboard, compact remote notifications, and `/now` share deterministic CEO status and next-action wording without requiring routine raw state-file inspection. | [docs/ARCHITECTURE.md](ARCHITECTURE.md), [tests/operating-surface.test.ts](../tests/operating-surface.test.ts), [tests/dashboard.test.ts](../tests/dashboard.test.ts), [tests/ceo-status.test.ts](../tests/ceo-status.test.ts) |
| BK can converse with Samantha naturally at Codex CLI-level breadth and flexibility. | Reopened. This is now the Phase 1 product correction. Existing commands are implementation surfaces, not the target CEO conversation experience. | [docs/CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md#next-direction), [CEO_Conversation_MEMORY.md](../CEO_Conversation_MEMORY.md) |
| Periodic CEO reports clearly explain finished work, active work, blockers, risks, required BK decisions, and recommended next actions. | Met. CEO status, notification reports, project ranking, historical failure handling, recovery blockers, and notification throttling are deterministic and tested. | [docs/ARCHITECTURE.md](ARCHITECTURE.md), [docs/DAEMON_OPERATIONS.md](DAEMON_OPERATIONS.md), [tests/ceo-status.test.ts](../tests/ceo-status.test.ts), [tests/operator-reports.test.ts](../tests/operator-reports.test.ts) |
| Compact adapters such as Telegram are practical because they handle notifications, approvals, and short feedback without defining the core product workflow. | Partially met. The adapter is safe and compact, but dogfood showed command choreography must be moved behind a natural CEO turn layer. | [docs/REMOTE_ADAPTERS.md](REMOTE_ADAPTERS.md), [docs/ARCHITECTURE.md](ARCHITECTURE.md#ceo-turn-loop-and-delegated-authority), [tests/remote-command.test.ts](../tests/remote-command.test.ts), [tests/remote-approval.test.ts](../tests/remote-approval.test.ts), [tests/telegram-reply-adapter.test.ts](../tests/telegram-reply-adapter.test.ts) |
| Dashboard and CLI support long review and recovery without requiring BK to inspect raw state files. | Met. Dashboard surfaces read-only operating state, while CLI review/recovery commands reconstruct work, approvals, runs, lifecycle, and next safe actions. | [docs/ROLLBACK_AND_RECOVERY_DRILLS.md](ROLLBACK_AND_RECOVERY_DRILLS.md), [tests/dashboard.test.ts](../tests/dashboard.test.ts), [tests/operator-review-report.test.ts](../tests/operator-review-report.test.ts), [tests/recovery-drills.test.ts](../tests/recovery-drills.test.ts) |
| Routine safe progress does not require BK to drive command choreography. | Gap identified. Natural CEO turns should translate BK intent into safe internal transitions instead of asking BK to select `/plan`, `/go`, `/approve`, `/now`, or `/check`. | [docs/ARCHITECTURE.md](ARCHITECTURE.md#ceo-turn-loop-and-delegated-authority), [docs/CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md#next-direction) |
| Conversation memory preserves decisions, product direction, progress, and rejected approaches across turns without granting execution authority. | Started. `CEO_Conversation_MEMORY.md` records the current durable direction; governed structured memory remains a Phase 2 target. | [CEO_Conversation_MEMORY.md](../CEO_Conversation_MEMORY.md), [docs/CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md#next-direction), [tests/memory-store.test.ts](../tests/memory-store.test.ts), [tests/context-search.test.ts](../tests/context-search.test.ts) |
| Risky, ambiguous, or irreversible actions require explicit approval. | Met. Risk policy, plan approval, governed profile/capability/memory/routine/budget decisions, merge, push, cleanup, and stale remote approval gates fail closed before unsafe execution. | [docs/ARCHITECTURE.md](ARCHITECTURE.md#first-safety-gates), [docs/ROLLBACK_AND_RECOVERY_DRILLS.md](ROLLBACK_AND_RECOVERY_DRILLS.md), [tests/risk-policy.test.ts](../tests/risk-policy.test.ts), [tests/governance-decision-cli.test.ts](../tests/governance-decision-cli.test.ts), [tests/merge-gate.test.ts](../tests/merge-gate.test.ts), [tests/worktree-cleanup.test.ts](../tests/worktree-cleanup.test.ts) |
| Delegated autonomy expands only through evidence-backed authority grants that BK explicitly approves. | Design baseline set. Memory can suggest autonomy; only deterministic policy can grant autonomy. CEO turn and memory work must preserve this boundary. | [docs/ARCHITECTURE.md](ARCHITECTURE.md#ceo-turn-loop-and-delegated-authority), [docs/CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md#future-gates) |
| Planning and synthesis can use LLM judgment, but validated deterministic code owns state mutation. | Met. Bounded orchestrator outputs are proposal payloads; deterministic validation owns plan storage, BK decisions, materialization, task/action creation, synthesis reports, and recovery intake. | [docs/ARCHITECTURE.md](ARCHITECTURE.md#bounded-llm-call-contract), [tests/orchestrator-agent.test.ts](../tests/orchestrator-agent.test.ts), [tests/orchestrator-materializer.test.ts](../tests/orchestrator-materializer.test.ts), [tests/orchestrator-planning-baseline.test.ts](../tests/orchestrator-planning-baseline.test.ts) |
| Worker execution is isolated, auditable, and recoverable. | Met. Writers run through Samantha-owned worktrees, run logs, verification, commit creation, merge/push gates, cleanup lifecycle, and recovery drills. | [docs/ARCHITECTURE.md](ARCHITECTURE.md#worker-result-gate), [docs/ROLLBACK_AND_RECOVERY_DRILLS.md](ROLLBACK_AND_RECOVERY_DRILLS.md), [tests/worker-dispatch.test.ts](../tests/worker-dispatch.test.ts), [tests/run-lifecycle-store.test.ts](../tests/run-lifecycle-store.test.ts), [tests/recovery-continuity.test.ts](../tests/recovery-continuity.test.ts) |
| Multi-agent parallelism expands only after evidence supports it. | Met. Report-only parallelism is routine and auditable; writer-cap increases require dogfood, deterministic conflict, merge, cleanup, rollback, and explicit BK approval evidence. `DEFAULT_SAFETY_POLICY.writerCap` remains `1`. | [docs/PARALLELISM_EVIDENCE.md](PARALLELISM_EVIDENCE.md), [tests/parallelism-evidence.test.ts](../tests/parallelism-evidence.test.ts), [tests/parallelism-conflict-detector.test.ts](../tests/parallelism-conflict-detector.test.ts), [tests/profile-governance.test.ts](../tests/profile-governance.test.ts) |
| Host automation can run continuously and reports its own failures. | Met for the current host-owned runtime contract. Host ownership, daemon health, service templates, queue pressure, routine intake, notification throttling, and `/problems` diagnostics are deterministic. | [docs/DAEMON_OPERATIONS.md](DAEMON_OPERATIONS.md), [tests/ops-diagnostics.test.ts](../tests/ops-diagnostics.test.ts), [tests/continuous-operations-exit.test.ts](../tests/continuous-operations-exit.test.ts), [tests/daemon.test.ts](../tests/daemon.test.ts) |
| State can be backed up, restored, and audited. | Met. Backup manifests, restore validation, governance events, ancestry checks, lifecycle checks, routine trigger validation, and host migration blocking are covered by deterministic checks. | [docs/DAEMON_OPERATIONS.md](DAEMON_OPERATIONS.md#backup-restore-and-host-migration-drills), [tests/backup-restore.test.ts](../tests/backup-restore.test.ts), [tests/governance-event-store.test.ts](../tests/governance-event-store.test.ts), [tests/ancestry.test.ts](../tests/ancestry.test.ts) |

## Non-Goals

The north star is not:

- a Telegram-first command bot
- an ungoverned always-on LLM with execution authority
- arbitrary remote shell access
- memory-driven authority expansion without explicit policy
- autonomous merging or pushing without deterministic gates
- multi-writer execution without dogfood evidence and explicit approval

## Authority Review

- Writer authority remains capped at one production writer. Phase 10 does not
  apply a writer-cap increase or approve multi-writer execution.
- Remote authority remains compact and non-shell. Telegram and remote adapters
  still cannot accept arbitrary shell commands, repo paths, internal ids, merge,
  push, cleanup, connector, secret, routine, or budget authority grants.
- Routine authority remains intake-only. Routine triggers can create governed
  orchestration requests after admission gates, but cannot dispatch, approve,
  merge, push, cleanup, recover, or bypass project gates.
- Budget authority remains deterministic and local. Approved policies can defer
  or block through queue admission, but provider billing integration and hidden
  LLM budget judgment remain out of scope.
- Backup, restore, and migration checks remain read-only validation and handoff
  drills. They do not start services, activate restored state, rewrite history,
  merge, push, cleanup, recover, or operate active-active hosts.
- Memory, SOPs, and skills remain context and methodology only. They cannot
  override safety, approval, project, dispatch, worktree, merge, push, cleanup,
  recovery, budget, routine, connector, or secret gates.
- Memory can record preferences, operations, and BK judgment history. It may
  support a proposed authority grant, but the grant itself must be a
  deterministic policy record with BK approval, scope, limits, evidence, audit,
  and revocation path.

## Readiness Questions

Before declaring the product north star complete, Samantha should be able to
answer:

- What is BK waiting on?
- What is Samantha waiting on?
- What work completed since the last report?
- What failed, and what is the recovery path?
- What decision is needed before progress can continue?
- Can Samantha continue safely without asking BK to choose another internal
  workflow command?
- What conversation memory should Samantha retrieve, cite, or update?
- What did each agent do, and under what scope?
- What state changed, who approved it, and where is the audit record?
- What authority policy, if any, allowed Samantha to proceed autonomously?
- What is the next safe action?

## Verification Run

Phase 10 was declared from the Mac client side. No host-owned daemon, watch,
poll, reply, service-template, dashboard runtime, worker dispatch, merge, push,
cleanup, recovery, or runtime state behavior changed in this declaration.
Active-host verification remains required only when host-owned runtime behavior
changes on the active automation host.

Current verification:

- `bun run verify:mac` passed on 2026-05-11, including TypeScript typecheck,
  portable tests, and docs verification.
- Portable test result: 403 passed, 0 failed across 58 files.

## Declaration

Samantha's Codex-only Deterministic CEO Office has reached the safety and state
management baseline for the current control-plane scope: deterministic
TypeScript code owns durable state, approval gates, dispatch gates, reporting,
recovery, audit, continuous operation checks, and backup/restore validation.

The product north star is not complete until the CEO turn loop proves that BK
can run product work through natural conversation without manually driving
command choreography. Future work should start with that correction before
broadening scope.
