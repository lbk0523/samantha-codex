# Samantha v2 Phase 1

Last updated: 2026-05-12

Status: implementation handoff plan.

## Purpose

This document turns the Phase 1 direction into staged implementation work.
Phase 1 means building the natural CEO turn loop: BK should talk to Samantha in
natural language, and Samantha should translate that into safe deterministic
progress without making BK drive internal command choreography.

This document is not the durable architecture contract. Keep durable rules in:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CEO_OFFICE_ROADMAP.md](CEO_OFFICE_ROADMAP.md)
- [NORTH_STAR.md](NORTH_STAR.md)
- [REMOTE_ADAPTERS.md](REMOTE_ADAPTERS.md)
- [DETERMINISTIC_CEO_OFFICE.md](DETERMINISTIC_CEO_OFFICE.md)

## Operating Assumptions

- Samantha v2 Phase 1 changes the product surface, not the safety hierarchy.
- Natural CEO conversation can be broad and flexible.
- Execution authority remains narrow and deterministic.
- Telegram slash commands remain compatibility and debug surfaces.
- Plain natural language should become the primary user path.
- `CEO_Conversation_MEMORY.md` is planning context, not authority.
- Memory updates start as candidates unless BK explicitly approves a safe write.
- The first success criterion is removing `/work -> /plan -> /go` choreography
  from routine report-only CEO work.

## Stage Plan

### Stage 1 - Failure Contract

Goal: lock the dogfood failure into tests before changing behavior.

Scope:

- Add tests showing plain natural Telegram input should become a CEO turn.
- Add tests showing report-only CEO work must not ask BK to send `/plan`,
  `/go`, `/approve`, `/now`, or `/check`.
- Add tests for negated recovery wording such as `복구 실행 없이`.

Do not:

- Add the CEO turn store yet.
- Change runtime behavior beyond the minimum needed to make characterization
  tests meaningful.
- Expand Samantha authority.

Verify:

- Focused tests fail before implementation and pass after the minimum fix.
- Existing remote command and project classification tests remain green.

### Stage 2 - CEO Turn Store

Goal: add a durable record for one natural CEO conversation turn without
changing execution behavior.

Scope:

- Add a `CeoTurnRecord` model.
- Add a JSONL store for `state/ceo-turns.jsonl`.
- Record source, actor, text, detected intent, response boundary, linked state
  ids, and optional memory candidate refs.
- Add focused store tests.

Do not:

- Call LLMs from the store.
- Mutate requests, plans, decisions, actions, or runs.
- Write `CEO_Conversation_MEMORY.md`.

Verify:

- Store append/list/read behavior is deterministic.
- Missing or malformed records fail closed.

### Stage 3 - Natural Input Adapter

Goal: route natural user messages into the CEO turn loop.

Scope:

- Map Telegram plain text to a `ceo:turn` inbox command.
- Keep existing slash commands working as compatibility paths.
- Avoid requiring BK to know internal ids for normal operation.

Do not:

- Remove `/work`, `/now`, `/check`, `/approve`, or `/go`.
- Route arbitrary shell text to execution.
- Treat natural text as approval unless a later stage adds deterministic
  approval matching.

Verify:

- Plain Korean input becomes `ceo:turn`.
- Existing slash command tests remain green.
- Unsupported slash commands remain rejected.

### Stage 4 - CEO Turn Runner v1

Goal: process one CEO turn and return a natural CEO/assistant response while
reusing the existing deterministic kernel.

Scope:

- Add `handleCeoTurn`.
- Retrieve current deterministic context: active requests, plans, decisions,
  reports, governed memory, project context, and recent relevant records.
- Use existing planning/orchestrator helpers where possible.
- Normalize the user-facing response so it describes result, blocker, approval
  boundary, or next safe action.

Do not:

- Duplicate request, plan, decision, or action state machines.
- Let the LLM mutate production state directly.
- Ask BK to operate internal command choreography for routine CEO turns.

Verify:

- A `ceo:turn` input produces a natural response.
- Report-only planning/status turns do not mention raw command choreography.
- Existing safety gates still block unsafe progress.

### Stage 5 - Conversation Memory Spine

Goal: make `CEO_Conversation_MEMORY.md` useful context without letting it become
ungoverned authority.

Scope:

- Add a reader for `CEO_Conversation_MEMORY.md`.
- Include conversation memory in CEO turn context.
- Generate memory update candidates for decisions, durable product direction,
  rejected paths, and important progress.
- Store candidates separately from the memory file.

Do not:

- Automatically append to `CEO_Conversation_MEMORY.md` on every turn.
- Let memory override policy, approvals, project profile, host ownership,
  connector gates, or writer caps.

Verify:

- CEO turn context includes conversation memory.
- Candidate generation is tested.
- No test mutates `CEO_Conversation_MEMORY.md` without explicit write intent.

### Stage 6 - Safe Report-Only Autopilot Turn

Goal: remove the specific dogfood failure for report-only work.

Scope:

- Let a natural CEO turn complete safe report-only planning, synthesis, or
  review work without asking BK for another command.
- Return a compact natural result with evidence references when useful.
- Explain deterministic boundaries when Samantha cannot proceed.
- Fix classification cases where negated recovery language is misread.

Do not:

- Start writer work without approval.
- Bypass local repair, project, profile, or authority boundaries.
- Hide failures that require BK decision.

Verify:

- Dogfood-style input no longer produces `/work -> /plan -> /go` choreography.
- Evidence is recorded.
- Focused operations tests pass.
- `bun run typecheck` passes.

### Stage 7 - Natural Approval For Write Work

Goal: allow BK to approve pending work in natural language while keeping the
deterministic decision gate.

Scope:

- Match natural approval phrases to a pending decision only when unambiguous.
- Ask one clarifying question when multiple pending decisions could match.
- Preserve stale approval, risk, project, profile, merge, push, cleanup,
  recovery, and memory gates.

Do not:

- Treat vague encouragement as approval.
- Approve irreversible or risky work without a matching deterministic decision.
- Remove explicit slash approval commands; keep them as compatibility.

Verify:

- Write intent creates a natural approval boundary.
- Clear approval resolves the intended decision.
- Ambiguous approval does not execute.

### Stage 8 - Host Dogfood Rollout

Goal: prove the CEO turn loop on the active automation host.

Scope:

- Run portable verification on the development/client machine.
- Roll out to the active automation host through the existing host-owned
  process.
- Dogfood Telegram plain natural input.
- Capture evidence that Samantha can complete report-only CEO work without BK
  command choreography.

Do not:

- Run host-owned daemon, poll, reply, dispatch, merge, or dashboard runtime
  processes from a client machine.
- Declare Phase 1 complete from client-only evidence.

Verify:

- Plain natural Telegram request enters `ceo:turn`.
- Report-only request completes or reaches a natural deterministic boundary.
- BK is not asked to send `/plan`, `/go`, `/approve`, `/now`, or `/check` for
  routine report-only progress.
- Evidence is recorded under host-owned state.

## Session Handoff Prompts

Each prompt below is written to be pasted into a separate Codex session from the
repository root.

### Stage 1 Prompt

```text
You are in the Samantha Codex repository root.

Implement Samantha v2 Phase 1 Stage 1 from docs/Samantha_v2_Phase1.md.

Read first, in order:
1. docs/Samantha_v2_Phase1.md for the stage boundary.
2. docs/CEO_OFFICE_ROADMAP.md for the Phase 1 direction and product principles.
3. docs/NORTH_STAR.md for the reopened CEO conversation success criteria.
4. docs/REMOTE_ADAPTERS.md for Telegram/remote adapter constraints.
5. CEO_Conversation_MEMORY.md for the current durable conversation decisions.
6. src/lib/remote-command.ts, src/lib/project-profile.ts, tests/remote-command.test.ts, tests/project-profile.test.ts, and tests/operations.test.ts for the current behavior surface.

Goal: lock the current dogfood failure into tests before changing behavior.

Required work:
- Add focused tests showing plain natural Telegram text should become a CEO turn.
- Add focused tests showing report-only CEO work must not tell BK to send /plan, /go, /approve, /now, or /check.
- Add focused tests for negated recovery wording such as "복구 실행 없이" so it is not classified as recovery execution.

Constraints:
- Keep changes surgical.
- Do not add the CEO turn store yet.
- Do not expand Samantha authority.
- Do not remove existing slash command compatibility.
- If behavior must change to make the tests meaningful, use the smallest deterministic change.

Verification:
- Run the focused tests you changed.
- Run bun run typecheck if TypeScript behavior changed.
- Report exact files changed and remaining gaps.
```

### Stage 2 Prompt

```text
You are in the Samantha Codex repository root.

Implement Samantha v2 Phase 1 Stage 2 from docs/Samantha_v2_Phase1.md.

Read first, in order:
1. docs/Samantha_v2_Phase1.md for the stage boundary.
2. docs/ARCHITECTURE.md for the deterministic kernel and state ownership rules.
3. docs/CEO_OFFICE_ROADMAP.md for the natural CEO conversation direction.
4. CEO_Conversation_MEMORY.md for the conversation-memory role.
5. Existing store patterns in src/lib/decision-store.ts, src/lib/task-store.ts, src/lib/ceo-report-store.ts, and src/lib/run-lifecycle-store.ts.
6. Existing store tests such as tests/decision-store.test.ts, tests/task-store.test.ts, and tests/ceo-report-store.test.ts.

Goal: add a durable CEO turn record/store without changing runtime execution behavior.

Required work:
- Add a CeoTurnRecord model.
- Add a JSONL store for state/ceo-turns.jsonl.
- Include source, actor, text, detected intent, response boundary, linked state ids, timestamps, and optional memory candidate refs.
- Add focused tests for append/list/read and malformed record handling.

Constraints:
- Do not call LLMs from the store.
- Do not mutate requests, plans, decisions, actions, or runs.
- Do not write CEO_Conversation_MEMORY.md.
- Match existing store patterns in src/lib.

Verification:
- Run the new store tests.
- Run bun run typecheck.
- Report exact files changed and any store contract decisions.
```

### Stage 3 Prompt

```text
You are in the Samantha Codex repository root.

Implement Samantha v2 Phase 1 Stage 3 from docs/Samantha_v2_Phase1.md.

Read first, in order:
1. docs/Samantha_v2_Phase1.md for the stage boundary.
2. docs/REMOTE_ADAPTERS.md for adapter authority and compatibility constraints.
3. docs/ARCHITECTURE.md for the CEO turn loop and deterministic authority boundary.
4. CEO_Conversation_MEMORY.md for the current natural CEO conversation direction.
5. src/lib/remote-command.ts and the inbox handling path in src/samantha.ts.
6. tests/remote-command.test.ts, tests/remote-approval.test.ts, and tests/operations.test.ts.

Goal: route natural user messages into the CEO turn loop.

Required work:
- Add a ceo:turn inbox command type or equivalent existing command representation.
- Map Telegram plain text to ceo:turn.
- Keep existing slash commands working as compatibility paths.
- Keep unsupported slash commands rejected.

Constraints:
- Do not remove /work, /now, /check, /approve, or /go.
- Do not treat natural text as shell execution.
- Do not treat natural text as approval yet.
- Avoid requiring BK to know internal ids for normal operation.

Verification:
- Run remote command tests.
- Run focused inbox/operations tests if command routing touches them.
- Run bun run typecheck.
- Report exact files changed and the natural-input routing rule.
```

### Stage 4 Prompt

```text
You are in the Samantha Codex repository root.

Implement Samantha v2 Phase 1 Stage 4 from docs/Samantha_v2_Phase1.md.

Read first, in order:
1. docs/Samantha_v2_Phase1.md for the stage boundary.
2. docs/ARCHITECTURE.md for the bounded LLM contract, safety gates, and CEO turn direction.
3. docs/DETERMINISTIC_CEO_OFFICE.md for the TypeScript kernel boundary.
4. docs/NORTH_STAR.md for the user-facing CEO/assistant response criteria.
5. CEO_Conversation_MEMORY.md for durable conversation context.
6. src/samantha.ts, src/lib/orchestrator-agent.ts, src/lib/orchestrator-store.ts, src/lib/decision-store.ts, and src/lib/context-search.ts.
7. tests/orchestrator-agent.test.ts, tests/orchestrator-planning-baseline.test.ts, and tests/operations.test.ts.

Goal: process one CEO turn and return a natural CEO/assistant response while reusing the deterministic kernel.

Required work:
- Add handleCeoTurn in a small module or in the narrowest existing location.
- Retrieve relevant deterministic context using existing stores/helpers.
- Reuse existing planning/orchestrator helpers where possible.
- Normalize user-facing responses into result, blocker, approval boundary, or next safe action.
- Ensure routine CEO turns do not ask BK to operate /plan, /go, /approve, /now, or /check choreography.

Constraints:
- Do not duplicate request, plan, decision, action, or run state machines.
- Do not let LLM output mutate production state directly.
- Do not expand worker, connector, memory, host, merge, push, cleanup, or recovery authority.

Verification:
- Add focused tests for ceo:turn processing.
- Run changed tests.
- Run bun run typecheck.
- Report exact files changed and any remaining boundaries.
```

### Stage 5 Prompt

```text
You are in the Samantha Codex repository root.

Implement Samantha v2 Phase 1 Stage 5 from docs/Samantha_v2_Phase1.md.

Read first, in order:
1. docs/Samantha_v2_Phase1.md for the stage boundary.
2. docs/CEO_OFFICE_ROADMAP.md for the Phase 2 memory direction, even though this is still Phase 1 scaffolding.
3. docs/ARCHITECTURE.md for the rule that memory is context, not authority.
4. CEO_Conversation_MEMORY.md for the current durable memory file format and content.
5. src/lib/memory-store.ts, src/lib/memory-taxonomy.ts, and src/lib/context-search.ts.
6. tests/memory-store.test.ts, tests/memory-taxonomy.test.ts, and tests/context-search.test.ts.

Goal: include CEO_Conversation_MEMORY.md as conversation context and generate governed update candidates.

Required work:
- Add a reader for CEO_Conversation_MEMORY.md.
- Include its content or a bounded summary in CEO turn context.
- Generate memory update candidates for durable decisions, product direction, rejected paths, and important progress.
- Store candidates separately from CEO_Conversation_MEMORY.md.

Constraints:
- Do not automatically append to CEO_Conversation_MEMORY.md on every turn.
- Do not let memory override deterministic policy or authority gates.
- Do not store secrets.
- Keep memory candidate writes deterministic and auditable.

Verification:
- Add focused tests for memory read and candidate creation.
- Add a test proving CEO_Conversation_MEMORY.md is not mutated without explicit write intent.
- Run bun run typecheck.
- Report exact files changed and the candidate storage location.
```

### Stage 6 Prompt

```text
You are in the Samantha Codex repository root.

Implement Samantha v2 Phase 1 Stage 6 from docs/Samantha_v2_Phase1.md.

Read first, in order:
1. docs/Samantha_v2_Phase1.md for the stage boundary.
2. docs/CEO_OFFICE_ROADMAP.md for why command choreography is the product gap.
3. docs/REMOTE_ADAPTERS.md for compact adapter constraints.
4. docs/legacy/REMOTE_AUTOPILOT.md only as historical failure context; do not restore it as the product workflow.
5. CEO_Conversation_MEMORY.md for the dogfood decision context.
6. src/samantha.ts, src/lib/project-profile.ts, src/lib/autopilot-evidence-store.ts, and src/lib/orchestrator-agent.ts.
7. tests/operations.test.ts, tests/project-profile.test.ts, and tests/orchestrator-agent.test.ts.

Goal: make safe report-only CEO turns complete without BK command choreography.

Required work:
- Route report-only natural CEO turns through safe planning/synthesis/review progress.
- Return a compact natural result with evidence references when useful.
- Explain deterministic boundaries when Samantha cannot proceed.
- Fix classification cases where negated recovery language such as "복구 실행 없이" is misread.
- Record evidence for the report-only path.

Constraints:
- Do not start writer work without approval.
- Do not bypass local repair, project, profile, authority, host, or recovery boundaries.
- Do not hide failures that require BK decision.

Verification:
- Add or update a dogfood-style operations test.
- Confirm output does not ask BK to send /plan, /go, /approve, /now, or /check for routine report-only progress.
- Run focused tests.
- Run bun run typecheck.
- Run bun run verify:docs if docs changed.
- Report exact files changed and dogfood evidence behavior.
```

### Stage 7 Prompt

```text
You are in the Samantha Codex repository root.

Implement Samantha v2 Phase 1 Stage 7 from docs/Samantha_v2_Phase1.md.

Read first, in order:
1. docs/Samantha_v2_Phase1.md for the stage boundary.
2. docs/ARCHITECTURE.md for approval, risk, and safety gates.
3. docs/REMOTE_ADAPTERS.md for remote approval constraints and stale approval boundaries.
4. docs/DETERMINISTIC_CEO_OFFICE.md for the deterministic decision gate.
5. CEO_Conversation_MEMORY.md for the natural CEO conversation expectation.
6. src/samantha.ts, src/lib/decision-store.ts, src/lib/remote-command.ts, and src/lib/remote-action-store.ts.
7. tests/remote-approval.test.ts, tests/decision-store.test.ts, and tests/governance-decision-cli.test.ts.

Goal: allow BK to approve pending write work in natural language while preserving deterministic approval gates.

Required work:
- Match natural approval phrases to a pending deterministic decision only when unambiguous.
- Ask one clarifying question when multiple pending decisions could match.
- Preserve stale approval, risk, project, profile, merge, push, cleanup, recovery, memory, and authority gates.
- Keep slash approval commands as compatibility.

Constraints:
- Do not treat vague encouragement as approval.
- Do not approve irreversible or risky work without a matching decision.
- Do not expand writer cap or merge/push authority.

Verification:
- Add tests for clear natural approval, ambiguous natural approval, and non-approval feedback.
- Run focused approval tests.
- Run bun run typecheck.
- Report exact files changed and the approval matching rule.
```

### Stage 8 Prompt

```text
You are in the Samantha Codex repository root.

Implement Samantha v2 Phase 1 Stage 8 from docs/Samantha_v2_Phase1.md.

Read first, in order:
1. docs/Samantha_v2_Phase1.md for the rollout success criteria.
2. docs/DAEMON_OPERATIONS.md for active-host ownership and host/client boundaries.
3. docs/REMOTE_ADAPTERS.md for Telegram adapter behavior.
4. docs/ARCHITECTURE.md for the CEO turn loop and active-host authority rules.
5. docs/NORTH_STAR.md for Phase 1 completion criteria.
6. CEO_Conversation_MEMORY.md for the dogfood memory context.
7. Relevant ops, scripts, and state paths discovered with rg; do not assume portable absolute paths.

Goal: prepare and verify the active-host dogfood rollout for the CEO turn loop.

Required work:
- Run portable verification on the current development/client machine.
- Prepare host rollout notes using the existing active-host process.
- Verify that plain natural Telegram input enters ceo:turn on the active automation host.
- Capture evidence that report-only CEO work completes or reaches a natural deterministic boundary without BK command choreography.

Constraints:
- Do not run host-owned daemon, poll, reply, dispatch, merge, or dashboard runtime processes from a client machine.
- Do not declare Phase 1 complete from client-only evidence.
- Do not mutate host state outside the approved host-owned process.

Verification:
- Run bun run typecheck.
- Run bun run test:portable.
- Run bun run verify:docs.
- On the active automation host, verify the dogfood path and record evidence under host-owned state.
- Report evidence paths, failures, and the remaining Phase 1 gap if any.
```
