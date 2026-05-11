# Architecture

## Target Shape

```text
BK
  <-> CLI / dashboard / Telegram approval adapter / future UI
Deterministic CEO Office
  - stores requests, plans, goals, tasks, actions, and audit logs
  - tracks status, blockers, risks, next actions, and BK decision needs
  - enforces safety policy before any dispatch
  - governs agent profiles, capabilities, skills, connectors, routines, and
    budgets before they can expand execution authority
  - calls bounded LLM agents for planning, synthesis, review, or question drafting
  - allocates worktrees and dispatches approved Codex CLI agents
  - evaluates worker outputs and verification commands
  - merges/pushes only after gates pass
Bounded Codex Agents
  - codex-orchestrator planner/synthesizer
  - codex-spec       non-writer
  - codex-researcher non-writer
  - codex-content    non-writer
  - codex-operations non-writer
  - codex-worker     writer
  - codex-reviewer   non-writer
  - codex-evaluator  non-writer
Git worktrees / audit logs / dashboard
```

## Near-Term Scope

The first useful system is not a general multi-agent platform and not a Telegram-first command bot. It is a safe personal status reporting and work operations layer:

1. Samantha stores structured work state.
2. Samantha tracks status, blockers, risks, next actions, and BK decision needs.
3. Samantha generates clear periodic or on-demand reports.
4. A bounded Orchestrator Agent call can turn a request into an explicit plan and ask BK for approval when needed.
5. The CEO office materializes an approved plan into one or more safe tasks.
6. The CEO office may run non-writer agents in parallel.
7. The CEO office runs at most one production writer until safety gates are proven.
8. The CEO office verifies, merges, pushes, and reports.

## Current Status

Samantha has reached the north-star baseline for the current Codex-only
control-plane scope. The declaration is recorded in
[NORTH_STAR.md](NORTH_STAR.md#phase-10-exit-review). The declaration is an
audit conclusion, not an authority expansion: deterministic TypeScript remains
the durable operating authority, `writerCap` remains `1`, and remote adapters,
routines, budgets, memory, SOPs, skills, backup, restore, and migration remain
behind the same explicit gates described below.

The current implementation has a useful bounded Orchestrator Agent workflow on top of the deterministic CEO office. Telegram `/work` stores an orchestration request, `/plan` runs `codex-orchestrator` through the local Codex CLI in read-only mode, `/plan_current` rereads the current unapproved plan without rerunning Codex, `/approve` approves the single current plan approval decision, `/answer <text>` records an answer for exactly one current blocker clarification without changing the plan, `/revise <feedback>` supersedes the current unapproved plan and creates a revised planning request, `/cancel` discards the current pending request or unapproved plan, and `/go` validates the plan before creating task/action records.

The Control Plane materializes approved plans into tasks and dispatch actions, promotes dependent actions only after prerequisites pass, runs approved actions through `actions:watch`, and reruns `codex-orchestrator` to write one `# plan-result` report once all actions for a materialized plan finish. If that plan result failed, `/recover` creates a new recovery orchestration request for the next `/plan` without retrying or dispatching by itself. Recovery requests carry failed-plan evidence, run-log context, failed verify details, and explicit instructions to use project profile canonical repo roots rather than old worker worktrees.

When a recovery request produces a passing materialized plan, result reports say the original problem was fixed. If the recovery plan also fails, reports say the original problem remains unresolved and recovery is still needed. Linked successful recoveries also prevent stale failed source plans, actions, and tasks from continuing to drive CEO status or next-action reporting.

Telegram is intentionally small and is an adapter for notification, approval, short feedback, and status checks. The routine surface is `/work`, `/plan`, `/plan_current`, `/approve`, `/answer`, `/revise`, `/cancel`, `/go`, `/recover`, `/now`, `/check`, and `/problems`. Older proposal/draft/task/action/run id commands are no longer normal Telegram operations; they return deprecated-command guidance and point back to the orchestrator flow. Local CLI, dashboard, and inbox commands remain available for deeper operation, debugging, and recovery.

Telegram notifications are compact outbox reports. On the active automation host, `ceo:notify` runs periodically, writes a remote outbox CEO summary, and records generation in `state/ceo-reports.jsonl`; `telegram:reply` delivers it through the existing Telegram reply adapter and records delivery in `state/telegram-replies.json`. Telegram can approve only the single current plan-approval decision through `/approve`; ambiguous or multiple pending decisions redirect BK back to `/now`, CLI, or dashboard. Telegram never accepts shell commands, repo paths, or task/action/run/decision ids as workflow inputs.

The Phase 6 multi-project operations path is implemented. Samantha now treats
project profiles as deterministic identity records, carries project -> goal ->
work-item ancestry through planning and materialization, shows project queues
and cross-project ranking, and blocks ambiguous remote commands before they can
advance the wrong project. New roles, profile changes, allowed skills,
connector or secret access, routines, and budget enforcement should still be
introduced only behind deterministic approvals and audit trails.

The Phase 9 host ownership diagnostic is read-only. `doctor` and `/problems`
classify the current machine as `active`, `client`, `stale`, or `unknown` from
host-local `state/host-ownership.json` and the current host id. Only `active`
means the machine is allowed to run automation, and the diagnostic does not
start, stop, migrate, dispatch, merge, push, cleanup, recover, or grant new
authority.

The Phase 9 continuous-operations gates are implemented as deterministic
intake, pressure, budget, notification, backup, restore, and migration
contracts. Queue pressure can accept, defer, block, or ask BK before new
request, routine, or action intake advances. Routine triggers are governed
intake records with stable fingerprints; accepted observations create only
orchestration requests, and duplicate live fingerprints coalesce against
active requests, plans, tasks, actions, or unresolved decisions. Budget
enforcement uses local policy and cost audit records, distinguishes measured,
estimated, and unknown cost, and requires explicit BK governance evidence
before an active policy can defer or block work. CEO notification throttling
coalesces repeated low-risk notifications into digest audit records while
urgent BK decisions, failures, unsafe host state, recovery blockers, and
budget or queue blocks still deliver. Backup manifests, restore validation,
and host migration validation are read-only checks; they do not activate a
restored host, start or stop services, dispatch, approve, merge, push, cleanup,
recover, or rewrite history.

The current architecture canary is role-aware but intentionally small: the Orchestrator Agent may choose report-only `codex-reviewer`, `codex-evaluator`, `codex-spec`, `codex-researcher`, `codex-content`, or `codex-operations` tasks before or alongside one `codex-worker` write task. The Control Plane keeps non-writers read-only, rejects non-writer write proposals, and keeps writer concurrency capped at one. Parallelism evidence is recorded in a compact ledger, role topology is advisory metadata only, merge and cleanup queues are classified deterministically, and writer-cap changes require complete dogfood, conflict, merge, cleanup, rollback, and BK approval evidence. Phase 7 closed without a writer-cap increase. This is not general multi-agent team construction.

The existing deterministic CEO office should remain responsible for safety, state, and execution; it should not be discarded.

Future expansion should stay governance-first:

- Phase 5 hardened approval and audit for agent/profile/capability changes
  before adding broader authority.
- Phase 6 added project and goal ancestry before Samantha aggregates work
  across multiple projects.
- Phase 7 added an advisory role graph and stronger non-writer parallelism, but
  role relationships do not grant execution authority by themselves and
  `writerCap` remains `1`.
- Phase 8 added source-backed memory for planning: project briefs, derived
  decision-history summaries, active governed memory records, searchable
  reports/artifacts, bounded memory synthesis candidates, deterministic memory
  write gates, and SOP/skill document validation. Planning prompts receive only
  selected compact snippets, and recommendation traces cite stored context
  when memory influences a plan. Memory and SOP/skill documents remain context
  only; they cannot override safety policy or execution gates.
- Phase 9 added continuous-operation hardening through read-only host
  diagnostics, queue admission pressure, routine trigger coalescing, low-risk
  notification digests, deterministic budget enforcement, and read-only backup,
  restore, and migration validation. These gates use memory only as context and
  do not expand execution authority.

## Bounded LLM Call Contract

LLM calls are bounded helpers, not state owners. The only accepted orchestrator call modes are:

- planning: produce one structured `ORCHESTRATOR_PLAN` payload
- synthesis: produce one structured `ORCHESTRATOR_SYNTHESIS` payload from completed worker evidence
- question drafting: produce one structured `ORCHESTRATOR_QUESTION_DRAFT` payload for an ambiguous blocker
- review/spec/evaluation: report-only worker tasks that stay behind the normal task and dispatch gates

Every bounded call runs as a proposal generator. It may not directly create tasks, approve actions, dispatch workers, mark runs, merge, push, clean up worktrees, or update lifecycle state. Samantha validates the structured payload first, then the deterministic CEO office decides whether to append plan state, create a decision item, materialize tasks/actions, or write a report.

Question-drafting output is stored only as a BK decision item after deterministic validation. A question draft never resolves its own decision and never advances work by itself.

## Skill Policy

External skill bundles are allowed only as agent work methodology. They do not own orchestration, grant connector access, create routines, change budgets, or expand profile authority.

Example policy:

```yaml
required_bundles:
  - id: superpowers
    source: https://github.com/obra/superpowers.git
    ref: pinned-commit
blocked_skills:
  - using-git-worktrees
  - dispatching-parallel-agents
  - subagent-driven-development
```

Samantha remains responsible for worktree allocation, dispatch, merge, push, and safety checks.
Adding or allowing a skill that materially changes agent behavior should be
treated as a governed capability change, not as an informal prompt edit.
A blocked orchestration skill remains blocked even if a capability approval
exists; approvals cannot override the safety policy.

SOP and skill markdown documents use the same non-authority model. A valid
document must start with frontmatter containing:

- `schemaVersion: 1`
- `kind: sop_document` or `skill_document`
- stable `id`, `title`, `owner`, and `updatedAt`
- project or profile `scope`
- `status`, `riskClass`, and `behaviorImpact`
- at least one source citation

The body must include these sections: Preconditions, Workflow Steps, Quality
Checks, Forbidden Actions, Safety Boundaries, Rollback Notes, and Citations.
Samantha validates the document deterministically before use. Unsafe authority
claims fail validation when they attempt to override or bypass safety,
dispatch, worktree, merge, push, cleanup, recovery, approval, project,
connector, secret, routine, or budget gates. Blocked skill names remain blocked
even if a skill document requests them.

Behavior-changing SOP or skill publication remains a governed memory and/or
capability/profile change. The markdown document can explain methodology; it
cannot grant runtime authority.

External agent frameworks, prompt packs, or skill systems may be mined for
bounded patterns only. Samantha should not import another runtime wholesale,
let LLMs promote their own skills, mutate memory automatically, pool
credentials across providers, or bypass deterministic deny rules. Useful
adoption candidates should enter a governed learning or capability review flow,
then graduate through the same explicit policy, audit, and test gates as local
features.

## Planning Memory Context

The orchestrator planning path may include a small selected memory context when
a request has assigned project ancestry. Samantha derives that context from
project-scoped search over CEO reports, derived decision-history summaries,
active project briefs, active governed memory records, and governance events.

The planning prompt treats these snippets as advisory context only. If a prior
decision, project brief, preference, known risk, report, or SOP affects the
recommendation, the plan payload must record a `recommendationTrace` entry with
the reason and citations. Operator plan reports render that trace as the local
"why was this recommended?" surface. Stale or conflicting memory can be cited
only as risk, ambiguity, or a rejected alternative.

## Connector And Secret Boundaries

Connector and secret access is unavailable to workers unless an agent profile
declares governed capability records and BK has approved matching
`capability_change` decisions. Ad hoc connector or secret fields are rejected
before dispatch.

Connector records identify the connector and deterministic capability id.
Secret records identify a secret reference for gate calculation, but denial
reports do not print secret values and summarize missing secret approvals by
count. No connector access is inherited from BK, the operator machine, or
enabled local tools.

## First Safety Gates

- writer profiles require `worktreePolicy: "per-task"`
- non-writer profiles require `resultMode: "report"` tasks with `worktreePolicy: "none"` and `mergePolicy: "none"`
- writer tasks require non-empty `targetFiles`
- writer tasks require non-empty `forbiddenChanges`
- writer concurrency starts at `1`
- external skills cannot override Samantha safety policy

## Current Execution Contract

The first dispatch surface is `bun run dispatch-worker`.

It currently:

1. reads a task JSON file
2. reads an agent profile JSON file
3. validates the task against the safety policy
4. prepares the task worktree path, or allocates it with `--allocate`
5. prints the exact `codex exec` command Samantha would run

With `--execute`, it also runs task `setupCommands` inside the worktree, then runs the prepared `codex exec` command and evaluates the captured output. Setup failures block the worker before Codex starts. Any tracked file changes produced by setup still go through the normal scope gate.

For supervisor visibility, `tasks:dispatch --execute --live-log` writes a live
JSONL stream under `runs/live/<run-id>.jsonl` for the dashboard and later
inspection. `--tmux` remains a manual read-only observer option for local
debugging, but server-hosted action execution does not require tmux.

Executed worker runs are written to `runs/<timestamp>-<task-id>.json` by default. Each log includes the task, agent profile, dispatch input, setup results, Codex command result when it ran, and Samantha's evaluation. Use `--log-dir=<path>` to choose another directory or `--no-log` for one-off debugging runs that should not leave an audit file.

Compact run summaries are appended to `state/runs.jsonl`. The local operator CLI is `bun run samantha`.

The current operator surface includes:

- run and task ledger inspection
- merge candidate checks
- explicit fast-forward merge application
- separate clean-branch push gating
- completed worker worktree cleanup
- multi-task plan execution
- local inbox processing
- daemon lock, heartbeat, and health check
- orchestration request and plan state
- background remote action execution with dependency promotion
- plan-level result synthesis through `codex-orchestrator`
- remote command enqueueing into the inbox
- Telegram polling into the inbox
- Telegram outbox replies
- read-only static dashboard generation

## Worker Result Gate

Samantha accepts a worker run only when all of these pass:

1. worker output contains `HARNESS_RESULT: {...}`
2. `status` is `pass`
3. changed files since the task base commit do not match `forbiddenChanges`
4. changed files stay inside `targetFiles`
5. every `verifyCommand` exits with code `0`
6. Samantha creates the writer commit after gates pass

Worker agents do not commit or push. Integration is split across `merge:check`, `merge:apply`, and `merge:push`.

Completed worktrees are removed through `worktree:cleanup`, which requires a passing run log, a clean target repo, a clean worker worktree, and a target branch that already contains the worker commit.

Worker worktrees default to an external `.samantha-worktrees/<repo>` directory beside the target repo parent. Keeping worktrees outside the target repo prevents broad test commands from accidentally discovering duplicated files inside active worker worktrees.

Remote adapters are input-only. The Telegram adapter polls updates, requires an allowed sender id, maps only the narrow supported command set, and writes inbox files. Deprecated id-based commands produce guidance instead of running the old flow. The adapter does not execute commands directly.
