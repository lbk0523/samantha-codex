# Architecture

## Target Shape

```text
BK
  <-> Telegram / future web UI
Samantha Orchestrator
  - receives instructions
  - creates tasks
  - assigns agent profiles
  - enforces safety policy
  - dispatches Codex CLI agents
  - verifies results
  - merges/pushes only after gates pass
Codex Agents
  - codex-worker     writer
  - codex-reviewer   non-writer
  - codex-evaluator  non-writer
  - codex-spec       non-writer
Git worktrees / audit logs / dashboard
```

## Near-Term Scope

The first useful system is not a general multi-agent platform. It is a safe personal operations layer:

1. BK sends one instruction to Samantha.
2. Samantha creates one or more tasks.
3. Samantha may run non-writer agents in parallel.
4. Samantha runs at most one production writer until safety gates are proven.
5. Samantha verifies, merges, pushes, and reports.

## Skill Policy

External skill bundles are allowed only as agent work methodology. They do not own orchestration.

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

## First Safety Gates

- writer profiles require `worktreePolicy: "per-task"`
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

Executed worker runs are written to `runs/<timestamp>-<task-id>.json` by default. Each log includes the task, agent profile, dispatch input, setup results, Codex command result when it ran, and Samantha's evaluation. Use `--log-dir=<path>` to choose another directory or `--no-log` for one-off debugging runs that should not leave an audit file.

## Worker Result Gate

Samantha accepts a worker run only when all of these pass:

1. worker output contains `HARNESS_RESULT: {...}`
2. `status` is `pass`
3. changed files since the task base commit do not match `forbiddenChanges`
4. changed files stay inside `targetFiles`
5. every `verifyCommand` exits with code `0`
