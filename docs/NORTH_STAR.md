# North Star

Last updated: 2026-05-11

This document defines what it means for Samantha's Deterministic CEO Office to
reach the north star.

Status: achieved for the current Codex-only control-plane scope.

This declaration does not expand Samantha's authority. It records that the
Phase 1-9 control-plane work now satisfies the north-star product criteria
below, while preserving the same deterministic safety gates and explicit
non-goals.

## Target Product

Samantha is BK's personal development operations control plane.

BK should be able to run real product work through Samantha without personally
tracking every worker, task id, run id, branch, or recovery path.

The durable operating authority is deterministic TypeScript code. LLMs are
bounded agents that help with planning, synthesis, review, evaluation, research,
content, operations, and coding, but they do not become the permanent CEO.

## Operating Model

BK:

- sets direction
- approves risky or ambiguous decisions
- receives periodic reports
- redirects priorities when needed

Deterministic CEO Office:

- owns durable state
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
- Periodic CEO reports clearly explain finished work, active work, blockers,
  risks, required BK decisions, and recommended next actions.
- Mobile usage is practical because Telegram or another adapter is limited to
  compact reports, approvals, and status checks.
- Dashboard and CLI support long review and recovery without requiring BK to
  inspect raw state files.
- Risky, ambiguous, or irreversible actions require explicit approval.
- Planning and synthesis can use LLM judgment, but validated deterministic code
  owns state mutation.
- Worker execution is isolated, auditable, and recoverable.
- Multi-agent parallelism expands only after evidence supports it.
- Host automation can run continuously and reports its own failures.
- State can be backed up, restored, and audited.

## Phase 10 Exit Review

| North-star criterion | Status | Evidence |
| --- | --- | --- |
| BK can inspect the state of work from one operating surface. | Met. CLI, dashboard, compact remote notifications, and `/now` share deterministic CEO status and next-action wording without requiring routine raw state-file inspection. | [docs/OPERATING_SURFACE_CONSOLIDATION.md](OPERATING_SURFACE_CONSOLIDATION.md), [docs/MULTI_PROJECT_OPERATIONS.md](MULTI_PROJECT_OPERATIONS.md#phase-6-exit-review), [tests/operating-surface.test.ts](../tests/operating-surface.test.ts), [tests/dashboard.test.ts](../tests/dashboard.test.ts), [tests/ceo-status.test.ts](../tests/ceo-status.test.ts) |
| Periodic CEO reports clearly explain finished work, active work, blockers, risks, required BK decisions, and recommended next actions. | Met. CEO status, notification reports, project ranking, historical failure handling, recovery blockers, and notification throttling are deterministic and tested. | [docs/MVP_HARDENING.md](MVP_HARDENING.md), [docs/OPERATING_SURFACE_CONSOLIDATION.md](OPERATING_SURFACE_CONSOLIDATION.md), [docs/CONTINUOUS_24_7_OPERATIONS.md](CONTINUOUS_24_7_OPERATIONS.md#phase-9-exit-review), [tests/ceo-status.test.ts](../tests/ceo-status.test.ts), [tests/operator-reports.test.ts](../tests/operator-reports.test.ts) |
| Mobile usage is practical because Telegram or another adapter is limited to compact reports, approvals, and status checks. | Met. Telegram is a compact adapter for `/work`, `/plan`, `/approve`, short feedback, `/now`, `/check`, and `/problems`; it rejects shell commands, arbitrary repo paths, and internal-id workflows. | [docs/REMOTE_ADAPTERS.md](REMOTE_ADAPTERS.md), [docs/ARCHITECTURE.md](ARCHITECTURE.md#current-status), [tests/remote-command.test.ts](../tests/remote-command.test.ts), [tests/remote-approval.test.ts](../tests/remote-approval.test.ts), [tests/telegram-reply-adapter.test.ts](../tests/telegram-reply-adapter.test.ts) |
| Dashboard and CLI support long review and recovery without requiring BK to inspect raw state files. | Met. Dashboard surfaces read-only operating state, while CLI review/recovery commands reconstruct work, approvals, runs, lifecycle, and next safe actions. | [docs/OPERATING_SURFACE_CONSOLIDATION.md](OPERATING_SURFACE_CONSOLIDATION.md), [docs/SAFETY_AUDIT_GOVERNANCE.md](SAFETY_AUDIT_GOVERNANCE.md#phase-5-exit-review), [tests/dashboard.test.ts](../tests/dashboard.test.ts), [tests/operator-review-report.test.ts](../tests/operator-review-report.test.ts), [tests/recovery-drills.test.ts](../tests/recovery-drills.test.ts) |
| Risky, ambiguous, or irreversible actions require explicit approval. | Met. Risk policy, plan approval, governed profile/capability/memory/routine/budget decisions, merge, push, cleanup, and stale remote approval gates fail closed before unsafe execution. | [docs/SAFETY_AUDIT_GOVERNANCE.md](SAFETY_AUDIT_GOVERNANCE.md#phase-5-exit-review), [tests/risk-policy.test.ts](../tests/risk-policy.test.ts), [tests/governance-decision-cli.test.ts](../tests/governance-decision-cli.test.ts), [tests/merge-gate.test.ts](../tests/merge-gate.test.ts), [tests/worktree-cleanup.test.ts](../tests/worktree-cleanup.test.ts) |
| Planning and synthesis can use LLM judgment, but validated deterministic code owns state mutation. | Met. Bounded orchestrator outputs are proposal payloads; deterministic validation owns plan storage, BK decisions, materialization, task/action creation, synthesis reports, and recovery intake. | [docs/PLANNING_AND_DELEGATION_MATURITY.md](PLANNING_AND_DELEGATION_MATURITY.md), [docs/ARCHITECTURE.md](ARCHITECTURE.md#bounded-llm-call-contract), [tests/orchestrator-agent.test.ts](../tests/orchestrator-agent.test.ts), [tests/orchestrator-materializer.test.ts](../tests/orchestrator-materializer.test.ts), [tests/orchestrator-planning-baseline.test.ts](../tests/orchestrator-planning-baseline.test.ts) |
| Worker execution is isolated, auditable, and recoverable. | Met. Writers run through Samantha-owned worktrees, run logs, verification, commit creation, merge/push gates, cleanup lifecycle, and recovery drills. | [docs/SAFETY_AUDIT_GOVERNANCE.md](SAFETY_AUDIT_GOVERNANCE.md#phase-5-exit-review), [docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md](EVIDENCE_BASED_PARALLELISM_EXPANSION.md#phase-7-exit-review), [tests/worker-dispatch.test.ts](../tests/worker-dispatch.test.ts), [tests/run-lifecycle-store.test.ts](../tests/run-lifecycle-store.test.ts), [tests/recovery-continuity.test.ts](../tests/recovery-continuity.test.ts) |
| Multi-agent parallelism expands only after evidence supports it. | Met. Report-only parallelism is routine and auditable; writer-cap increases require dogfood, deterministic conflict, merge, cleanup, rollback, and explicit BK approval evidence. `DEFAULT_SAFETY_POLICY.writerCap` remains `1`. | [docs/PARALLELISM_EVIDENCE.md](PARALLELISM_EVIDENCE.md), [docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md](EVIDENCE_BASED_PARALLELISM_EXPANSION.md#phase-7-exit-review), [tests/parallelism-evidence.test.ts](../tests/parallelism-evidence.test.ts), [tests/parallelism-conflict-detector.test.ts](../tests/parallelism-conflict-detector.test.ts), [tests/profile-governance.test.ts](../tests/profile-governance.test.ts) |
| Host automation can run continuously and reports its own failures. | Met for the current host-owned runtime contract. Host ownership, daemon health, service templates, queue pressure, routine intake, notification throttling, and `/problems` diagnostics are deterministic. | [docs/CONTINUOUS_24_7_OPERATIONS.md](CONTINUOUS_24_7_OPERATIONS.md#phase-9-exit-review), [docs/DAEMON_OPERATIONS.md](DAEMON_OPERATIONS.md), [tests/ops-diagnostics.test.ts](../tests/ops-diagnostics.test.ts), [tests/continuous-operations-exit.test.ts](../tests/continuous-operations-exit.test.ts), [tests/daemon.test.ts](../tests/daemon.test.ts) |
| State can be backed up, restored, and audited. | Met. Backup manifests, restore validation, governance events, ancestry checks, lifecycle checks, routine trigger validation, and host migration blocking are covered by deterministic checks. | [docs/CONTINUOUS_24_7_OPERATIONS.md](CONTINUOUS_24_7_OPERATIONS.md#phase-9-exit-review), [docs/DAEMON_OPERATIONS.md](DAEMON_OPERATIONS.md#backup-restore-and-host-migration-drills), [tests/backup-restore.test.ts](../tests/backup-restore.test.ts), [tests/governance-event-store.test.ts](../tests/governance-event-store.test.ts), [tests/ancestry.test.ts](../tests/ancestry.test.ts) |

## Non-Goals

The north star is not:

- a Telegram-first command bot
- a permanently running LLM conversation
- arbitrary remote shell access
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

## Readiness Questions

Before declaring the north star achieved, Samantha should be able to answer:

- What is BK waiting on?
- What is Samantha waiting on?
- What work completed since the last report?
- What failed, and what is the recovery path?
- What decision is needed before progress can continue?
- What did each agent do, and under what scope?
- What state changed, who approved it, and where is the audit record?
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

Samantha's Codex-only Deterministic CEO Office has reached the north star for
the current control-plane scope: BK can run real product work through one
orchestrator surface while deterministic TypeScript code owns durable state,
approval gates, dispatch gates, reporting, recovery, audit, continuous
operation checks, and backup/restore validation.

Future work should be treated as deliberate expansion beyond this declared
north-star baseline, not as a reason to keep adding features before using the
system.
