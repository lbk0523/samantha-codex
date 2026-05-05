# samantha-codex

Codex-only Samantha prototype.

Goal: BK talks to one 24/7 orchestrator. The orchestrator assigns work to multiple Codex-based specialist agents, verifies their output, and escalates only when a human decision is required.

## First Milestone

This repository starts with the control-plane contract, not a full multi-agent runtime.

- `writer` agents change files in isolated worktrees.
- `reviewer`, `evaluator`, and `spec` agents are non-writers and may run in parallel.
- deterministic safety checks run before dispatch.
- worker output is accepted only through `HARNESS_RESULT` plus scope/verify gates.
- Telegram, Codex CLI process control, and worktree merge are follow-up layers.

## Commands

```bash
bun typecheck
bun run test
bun run src/index.ts validate-fixture
bun run dispatch-worker --task=references/tasks/fixture-single-writer.json --agent=references/agent-profiles/codex-worker.json --repo-root=.
bun run samantha runs:list
```

## Worker Dispatch Dry Run

Prepare a Codex worker command without allocating a real worktree:

```bash
bun run dispatch-worker \
  --task=references/tasks/fixture-single-writer.json \
  --agent=references/agent-profiles/codex-worker.json \
  --repo-root=.
```

After the repository has an initial commit, add `--allocate` to create a task worktree.

Add `--execute` to run the prepared `codex exec` command and evaluate the worker output:

```bash
bun run dispatch-worker \
  --task=references/tasks/fixture-single-writer.json \
  --agent=references/agent-profiles/codex-worker.json \
  --repo-root=. \
  --execute
```

Executed runs write audit JSON files to `runs/` by default. Use `--log-dir=<path>` to choose another location, or `--no-log` to disable logging for a one-off run.

## Operator CLI

The `samantha` CLI is the local operator surface for the current control plane:

```bash
bun run samantha runs:list
bun run samantha tasks:add references/tasks/fixture-reviewer-readonly.json
bun run samantha tasks:list
bun run samantha plan:run references/plans/fixture-review-write-plan.json
bun run samantha dashboard:build
bun run samantha dashboard:serve --port=4173
```

Available command groups:

- `runs:*` reads the compact run index in `state/runs.jsonl`
- `tasks:*` manages the task ledger in `state/tasks.jsonl`
- `merge:check` evaluates a passed run log as a safe merge candidate
- `merge:apply` fast-forwards an approved candidate and runs post-merge verification
- `merge:push` pushes an accepted clean branch separately from merge application
- `worktree:cleanup` removes completed worker worktrees after integration
- `health:check` reports daemon heartbeat and lock health
- `plan:run` runs a multi-task plan with non-writer batching and writer serialization
- `inbox:*` processes local file-backed commands
- `remote:enqueue` maps a narrow remote command JSON into the local inbox
- `telegram:poll` maps allowlisted Telegram updates into the local inbox
- `actions:*` records and runs Telegram-approved dispatch actions from `state/remote-actions.jsonl`
- `dashboard:build` writes read-only `dashboard/index.html` and `dashboard/lane-view.html`
- `dashboard:serve` serves Overview at `/`, `/index.html`, and `/overview`, and Lane View at `/lane-view` and `/lane-view.html`; each request rebuilds from local state

Run the first external read-only canary against `oh-my-health-trainer`:

```bash
bun run dispatch-worker \
  --task=references/tasks/omht-readonly-status-canary.json \
  --agent=references/agent-profiles/codex-reviewer.json \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer \
  --allocate \
  --execute
```

By default, worker worktrees are placed outside the target repo under `.samantha-worktrees` beside the repo parent directory. This prevents target-repo test commands from discovering worker worktree files.

For live worker visibility, dispatch through `samantha tasks:dispatch` with `--execute --tmux` or `--execute --live-log`. The browser dashboard reads `runs/live/*.jsonl`: Overview separates current operational problems from historical run failures and shows the reverse-chronological live timeline, Lane View groups the same events by worker/run lane, and the tmux view attaches with `tmux attach -t samantha`.

Telegram's primary operating flow is `/now`, then `/run_next`, then `/yes`. `/now` reports the single next command to send, `/run_next` prepares the next pending task as a safe dispatch action, and `/yes` approves the latest prepared action. Approval does not run inside `inbox:watch`; `actions:watch` picks up approved actions and runs the prebuilt `tasks:dispatch <task-id> --allocate --execute --tmux` shape using the locally configured `SAMANTHA_REPO_ROOT`. Telegram input cannot supply shell commands, repo paths, merge, push, or cleanup actions. Use `/help_advanced` for the explicit inspection and action-id commands.

## Design Notes

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md), [docs/DASHBOARD_DOGFOOD.md](docs/DASHBOARD_DOGFOOD.md), [docs/DOGFOOD_SCENARIOS.md](docs/DOGFOOD_SCENARIOS.md), [docs/DAEMON_OPERATIONS.md](docs/DAEMON_OPERATIONS.md), [docs/REMOTE_ADAPTERS.md](docs/REMOTE_ADAPTERS.md), and [docs/NEXT_PLAN.md](docs/NEXT_PLAN.md).
