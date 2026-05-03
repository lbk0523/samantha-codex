# Samantha-Codex Next Plan

Last updated: 2026-05-03

## Starting Point

The Phase 1-7 MVP exists:

- run index and task ledger
- operator CLI
- merge candidate checks
- plan runner
- local inbox/outbox loop
- narrow remote command enqueueing
- read-only static dashboard

The first full dogfood pass completed through read-only real Codex execution against `oh-my-health-trainer`. No critical stop condition occurred.

The next plan should not jump directly to Telegram or autonomous merging. The next useful proof is one fresh writer dogfood task that exercises the full write path while keeping merge execution manual.

## Current Constraints

- `oh-my-health-trainer` main is clean but ahead of its remote by one commit from prior work.
- The old `omht-schema-07-new-block-fixture-canary` task must not be rerun because it was already applied.
- Read-only reviewer dogfood suggested a good next write candidate: schema `0.7` should reject unknown `document_blocks[].type`.
- Non-writer agents no longer receive parent `.git` metadata write access.
- Writer agents do not receive parent `.git` metadata access. They edit and verify files only; Samantha creates commits after scope and verify gates pass.

## Objective

Prove Samantha can safely handle a real writer task end to end:

1. prepare task contract
2. allocate writer worktree
3. run setup commands
4. execute Codex writer
5. capture full audit log
6. append compact run summary
7. render dashboard state
8. run merge gate
9. stop before actual merge unless BK explicitly approves integration

## Stage A: Writer Dogfood Task Definition

Create a new task under `references/tasks/`.

Suggested task id:

```text
omht-schema-07-unknown-block-negative-canary
```

Target files:

```text
tests/unit/zod-plan-schema.spec.ts
03 Prompts/(C) 2026-05-03 codex-omht-schema-07-unknown-block-negative-canary-report.md
```

Instructions:

- add one tests-only negative canary
- prove `LLMOutputSchema` rejects an unknown `document_blocks[].type` under `schema_version: "0.7"`
- do not modify production code or schema code
- do not commit or push
- Samantha creates the commit with the expected subject after gates pass

Setup commands:

```bash
bun install
```

Verify commands:

```bash
bun typecheck
bun test tests/unit/zod-plan-schema.spec.ts
```

Expected commit subject:

```text
test(w8): reject unknown schema 0.7 document block
```

Success criteria:

- task file declares exact target files
- forbidden changes cover production/app/docs areas broadly
- task can dry-run through `dispatch-worker`

## Stage B: Writer Dogfood Execution

Run:

```bash
bun run dispatch-worker \
  --task=references/tasks/omht-schema-07-unknown-block-negative-canary.json \
  --agent=references/agent-profiles/codex-worker.json \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer \
  --allocate \
  --execute
```

Success criteria:

- `pass` is `true`
- `runSummary.outcome` is `pass`
- `runSummary.commit` is non-empty after Samantha-owned commit creation
- changed files are exactly within target files
- verify commands pass in Samantha evaluation
- full run log exists under `runs/`
- compact summary exists in `state/runs.jsonl`

Critical stop conditions:

- production code changes
- files outside `targetFiles`
- verify commands fail but run summary says pass
- worker commits or pushes
- target repo main becomes dirty

## Stage C: Merge Gate Review

Run `merge:check` with the writer run log:

```bash
bun run samantha merge:check \
  --run-log=<writer-run-log-path> \
  --repo-root=/home/lbk0523/projects/oh-my-health-trainer
```

Success criteria:

- `mayMerge` is `true`
- command candidate is `git merge --ff-only <commit>`
- target repo is on `main`
- target repo is clean
- target repo `HEAD` matches worker base commit
- reported commit exists and descends from base commit

Do not execute the merge automatically in this stage. The merge command is a candidate for BK review.

## Stage D: Post-Dogfood Hardening

Harden whatever the writer dogfood reveals. Likely areas:

- duplicate task/run handling
- cleanup command for allocated worktrees
- better `runs:show` output for long Codex JSONL logs
- dashboard links to full run logs
- explicit `writer:cleanup` or `worktree:cleanup` command
- plan runner failure handling when one task in a batch fails

Success criteria:

- any discovered failure gets either a fix or a documented blocked reason
- tests cover each fix
- `BUILD_PLAN.md` and `DOGFOOD_SCENARIOS.md` stay consistent

## Stage E: Integration Gate Design

After one writer dogfood passes and BK approves the integration model, use separate integration gates.

Implemented commands:

```text
merge:check
merge:apply --run-log=<path>
merge:push --remote=origin --branch=main
```

Policy:

- `merge:apply` only accepts a passing run log
- no dirty target repo
- no branch mismatch
- no missing commit
- post-merge verify commands must run
- push remains separate from merge

Do not combine merge and push in one command yet.

Current behavior:

- `merge:check` returns the fast-forward candidate without changing the target repo.
- `merge:apply` reuses `merge:check`, executes `git merge --ff-only <commit>`, then runs the task `verifyCommands` on the target main worktree.
- `merge:push` checks branch and clean worktree state, then runs `git push <remote> <branch>`.

## Stage F: Daemon Packaging

Only after writer dogfood and integration gate are stable:

- add a systemd user service template
- add `inbox:watch` restart guidance
- keep lockfile protection for duplicate watchers
- keep `health:check`
- keep structured daemon heartbeat under `state/`

Success criteria:

- process restart does not lose queued inbox commands
- duplicate daemon start is blocked or harmless
- dashboard can show last heartbeat
- bad inbox commands produce outbox failure reports and are archived

## Stage G: Remote Adapter

Only after file-backed daemon is stable:

- add one Telegram adapter or another narrow remote adapter
- remote adapter writes to inbox only
- adapter cannot run shell commands
- sender allowlist is mandatory
- all remote commands produce outbox reports

Success criteria:

- no remote path bypasses inbox/ledger/audit
- unsupported commands fail closed
- remote UX stays read-mostly until merge gate is mature

## Stage H: Dashboard Upgrade

After writer dogfood:

- show pending inbox count
- show latest run outcome
- show failed gate summary
- show merge candidates
- link to run log path
- show repo status summaries from explicit snapshots

Keep dashboard read-only.

## Definition Of Done For Next Cycle

The next cycle is complete when:

- one fresh writer dogfood task passes
- run log and run index capture the writer result
- dashboard displays the writer result
- merge gate returns the correct conservative answer
- no automatic merge or push happens without BK approval
- any hardening fix is committed and pushed

## Execution Notes

This cycle revealed that Codex CLI sandboxing still blocks worker writes to parent worktree Git metadata, even when explicit Git metadata paths are supplied through `--add-dir`.

The safer design is now:

- worker agents edit files and run verification only
- worker agents do not commit or push
- Samantha creates the task commit after `HARNESS_RESULT`, scope checks, and verify commands pass
- merge gate reads Samantha-owned commit metadata from the run log

The fresh writer dogfood passed with commit:

```text
61824293b56fdf8ed84258c70de419b6f4353171
```

The merge candidate remained manual:

```bash
git merge --ff-only 61824293b56fdf8ed84258c70de419b6f4353171
```

## Recommended Next Action

Next, dogfood hardened `inbox:watch` locally, then add either systemd user-service packaging or the first narrow remote adapter.
