# samanth-codex

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
bun test
bun run src/index.ts validate-fixture
bun run dispatch-worker --task=references/tasks/fixture-single-writer.json --agent=references/agent-profiles/codex-worker.json --repo-root=.
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

## Design Notes

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
