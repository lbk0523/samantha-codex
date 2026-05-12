# AGENTS.md

## Project

This repository builds a Codex-only version of Samantha: a personal 24/7
operations control plane with a natural CEO conversation layer and a
deterministic TypeScript policy/state kernel. Samantha tracks work state,
manages approvals and safety gates, dispatches bounded Codex CLI agents when
needed, and reports back through one CEO surface.

## Operating Rules

- Samantha should support natural turn-by-turn CEO conversation with BK, while
  execution authority remains in deterministic TypeScript gates.
- The TypeScript kernel is the durable state and safety authority, not an
  ungoverned permanently running LLM.
- LLM orchestrator calls are bounded planning, synthesis, review, or question-drafting workers.
- Codex/GPT agents are workers, reviewers, evaluators, or spec helpers.
- BK talks only to the orchestrator.
- Production code writers must work in isolated git worktrees.
- Start with one writer. Parallel non-writers are allowed. Writer cap > 1 requires explicit dogfood evidence.
- Safety gates beat agent suggestions.

## Cross-OS Workspace Rules

- Exactly one active machine is the Samantha automation host at a time.
- Supported automation hosts are Ubuntu/WSL and macOS. A separate Mac may remain a development/client machine.
- Do not assume absolute paths are portable across OSes.
  - Ubuntu paths look like `/home/lbk0523/...`.
  - Mac paths look like `/Users/byung/...`.
- Repo code and docs must not hard-code local absolute paths unless the file is explicitly local-only or operational state.
- Prefer project ids, repo-relative paths, environment variables, or project profile resolution over absolute paths.
- `state/`, `runs/`, `.samantha-worktrees/`, and dashboard runtime output belong to the active automation host.
- Do not run Samantha daemon, watch, poll, reply, worker dispatch, or dashboard runtime processes from a client machine.
- Final automation verification and merge gates are active-automation-host responsibilities.
- Client-side work may edit, test, commit, and push normal repo code, but operational state remains host-owned.
- Client-side verification should use portable commands such as `bun typecheck`, `bun run test:portable`, `bun run verify:docs`, and `bun run verify:mac`.
- Host/runtime verification should use the active automation host with commands such as `bun run test:host`, `bun run test:all`, and `bun run verify:host`.

## Safety Priority

1. Samantha safety policy
2. Project-specific `AGENTS.md` / `CLAUDE.md`
3. Task spec frontmatter
4. Optional skill bundles such as Superpowers

Agents must not create worktrees, dispatch subagents, merge, or push on their own unless the task contract explicitly permits it. Those responsibilities belong to Samantha.

## Current Scope

Turn the completed control-plane baseline toward the CEO turn-loop roadmap:

- Phase 1: natural CEO turn loop over the existing deterministic kernel
- Phase 2: short-term context and long-term conversation memory structure
- Phase 3: a general software development organization built from bounded
  spec, research, review, evaluation, operations, and writer roles

Avoid adding framework breadth before the CEO turn loop and memory structure are
dogfooded.
