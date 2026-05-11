# samantha-codex

Codex-only Samantha control plane prototype.

Korean version: [readme-kr.md](readme-kr.md)

Samantha-Codex is a personal operations layer where BK talks to one orchestrator surface, the orchestrator turns requests into explicit plans, and deterministic TypeScript control-plane code runs safety, dispatch, verification, integration, and reporting gates.

The current repository is not a general multi-agent framework. It is the minimum useful control plane for safe Codex-based work.

## Current Shape

```text
BK
  <-> Telegram / local operator CLI
Samantha Orchestrator Agent
  - discusses goals, scope, risk, and next actions
  - proposes task plans for approval
  - synthesizes final results
Samantha Control Plane
  - stores requests, plans, tasks, actions, runs, and audit logs
  - validates safety policy before dispatch
  - dispatches approved Codex CLI agents
  - evaluates worker output and verification commands
  - gates merge, push, cleanup, and reporting
Codex Agents
  - codex-worker     writer
  - codex-reviewer   non-writer
  - codex-evaluator  non-writer
  - codex-spec       non-writer
  - codex-researcher non-writer
  - codex-content    non-writer
  - codex-operations non-writer
  - codex-orchestrator planner/synthesizer
```

The orchestrator proposes work. The control plane owns execution and safety. Agents do not bypass control-plane gates.

## Operating Boundaries

- Exactly one active machine is the Samantha automation host at a time.
- Supported automation hosts are Ubuntu/WSL and macOS.
- A separate Mac may remain a development/client machine and may edit, test, commit, and push normal repo code.
- Do not run Samantha daemon, watch, poll, reply, worker dispatch, or dashboard runtime processes from a client machine.
- Runtime state belongs to the automation host: `state/`, `runs/`, `.samantha-worktrees/`, dashboard runtime output, outbox/archive data, and live logs.
- Repo code and docs should not hard-code local absolute paths. Prefer repo-relative paths, project ids, environment variables, or project profile resolution.
- Mac/SSH host handoff remains manual and single-active-host. See [docs/DAEMON_OPERATIONS.md](docs/DAEMON_OPERATIONS.md).

## Supported Remote Flow

Telegram is intentionally small. The normal remote workflow is:

```text
/work <request>
/plan
/go
```

Common follow-up commands:

- `/plan_current` shows the current unapproved plan without rerunning Codex.
- `/approve` approves the single current plan approval decision.
- `/answer <answer>` records the answer for one current blocker clarification without changing the plan.
- `/revise <feedback>` replaces the current plan request with revised context.
- `/cancel [reason]` discards the pending request or unapproved plan.
- `/go` approves a valid plan, then later advances passed work through merge, push, and cleanup gates.
- `/recover` creates a recovery-oriented request after a failed materialized plan result.
- `/drop stale project:<project>`, `/drop recovery project:<project>`, and `/drop all project:<project>` clean project-scoped pending requests without requiring internal ids.
- `/now`, `/check`, and `/problems` report current operating status.

Telegram input cannot provide shell commands, arbitrary repo paths, merge/push/cleanup paths, or internal task/action/run/decision ids.

## Local Commands

Use Bun from the repository root:

```bash
bun typecheck
bun run test
bun run test:portable
bun run verify:docs
bun run verify:mac
bun run test:host
bun run verify:host
bun run validate-fixture
bun run dispatch-worker --task=references/tasks/fixture-single-writer.json --agent=references/agent-profiles/codex-worker.json --repo-root=.
bun run samantha runs:list
```

Verification profiles:

- `bun run test` is the same as `bun run test:portable`.
- `bun run test:portable` runs Mac-safe unit and contract tests.
- `bun run test:host` runs automation-host tests that depend on host runtime behavior.
- `bun run test:all` runs both portable and host tests.
- `bun run verify:docs` checks README cross-links and local absolute path safety.
- `bun run verify:mac` runs the normal Mac-side verification bundle.
- `bun run verify:host` runs the automation-host verification bundle.

The local operator CLI is:

```bash
bun run samantha <command>
```

Useful command groups:

- `runs:*` reads run logs and compact run indexes.
- `tasks:*` manages the file-backed task ledger.
- `plan:run` runs a multi-task local plan with non-writer batching and writer serialization.
- `actions:*` records and runs approved remote dispatch actions.
- `merge:check`, `merge:apply`, and `merge:push` split integration into explicit gates.
- `worktree:cleanup` removes completed worker worktrees after integration.
- `inbox:*`, `remote:enqueue`, and `telegram:poll` map narrow remote inputs into local inbox records.
- `health:check` reports daemon heartbeat and lock health.
- `doctor --local-only` suppresses Telegram-required failures for CLI/dashboard-only diagnostics.
- `host:claim` and `host:client` write host ownership records for manual host handoff; they do not run services or migrate state.
- `dashboard:build` writes read-only dashboard HTML.
- `dashboard:serve` serves the read-only dashboard on the automation host.

## Worker Dispatch

Dry-run a worker dispatch without allocating a real worktree:

```bash
bun run dispatch-worker \
  --task=references/tasks/fixture-single-writer.json \
  --agent=references/agent-profiles/codex-worker.json \
  --repo-root=.
```

Add `--allocate` only when the automation host should create the task worktree.

Add `--execute` to run setup commands, run the prepared `codex exec` command, evaluate `HARNESS_RESULT`, run verification commands, and write audit logs:

```bash
bun run dispatch-worker \
  --task=references/tasks/fixture-single-writer.json \
  --agent=references/agent-profiles/codex-worker.json \
  --repo-root=. \
  --execute
```

Executed runs write audit JSON files to `runs/` by default. Use `--log-dir=<path>` for another audit location, or `--no-log` for a one-off run.

## Safety Model

Samantha accepts writer output only when all gates pass:

- worker output contains `HARNESS_RESULT: {...}`
- `status` is `pass`
- changed files avoid `forbiddenChanges`
- changed files stay inside `targetFiles`
- every `verifyCommand` exits with code `0`
- Samantha creates the writer commit after gates pass

Writer agents do not commit or push. Production code writers use per-task worktrees. Non-writer agents are report-only, use no worktree or merge policy, and may run in parallel; writer concurrency starts at one until dogfood evidence justifies more.

## Project Layout

- `src/samantha.ts` is the local operator CLI entrypoint.
- `src/dispatch-worker.ts` prepares and optionally executes worker dispatch.
- `src/lib/` contains control-plane stores, gates, adapters, dispatch, dashboard, and orchestration helpers.
- `tests/` covers control-plane contracts and operations.
- `references/agent-profiles/` defines Codex agent contracts.
- `references/tasks/` and `references/plans/` contain fixtures and canaries.
- `references/project-profiles/` contains canonical project profile hints.
- `docs/` contains roadmap, architecture, operations, adapter, and policy notes.
- `ops/systemd/` contains Linux automation-host service and timer templates.
- `ops/launchd/` contains macOS automation-host LaunchAgent templates.

## Design Notes

For deeper context, see:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/REMOTE_AUTOPILOT.md](docs/REMOTE_AUTOPILOT.md)
- [docs/DETERMINISTIC_CEO_OFFICE.md](docs/DETERMINISTIC_CEO_OFFICE.md)
- [docs/CEO_OFFICE_ROADMAP.md](docs/CEO_OFFICE_ROADMAP.md)
- [docs/NORTH_STAR.md](docs/NORTH_STAR.md)
- [docs/DAEMON_OPERATIONS.md](docs/DAEMON_OPERATIONS.md)
- [docs/REMOTE_ADAPTERS.md](docs/REMOTE_ADAPTERS.md)
- [docs/PARALLELISM_EVIDENCE.md](docs/PARALLELISM_EVIDENCE.md)
- [docs/ROLLBACK_AND_RECOVERY_DRILLS.md](docs/ROLLBACK_AND_RECOVERY_DRILLS.md)
