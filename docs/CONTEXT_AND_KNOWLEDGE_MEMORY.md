# Context And Knowledge Memory

Last updated: 2026-05-10

Status: in progress.

This document contains the execution stages for roadmap Phase 8:
[Context And Knowledge Memory](CEO_OFFICE_ROADMAP.md#8-context-and-knowledge-memory).

This phase assumes Phase 7 is implemented: Samantha has project profiles,
project -> goal -> work-item ancestry, governed profile and capability changes,
report-only non-writer parallelism, advisory role topology, deterministic merge
and cleanup classification, rollback drill evidence, and a writer-cap governance
gate. Phase 7 closed without increasing `DEFAULT_SAFETY_POLICY.writerCap`.

The purpose of Phase 8 is not to make Samantha a self-modifying long-running
agent. It is to give the deterministic CEO Office source-backed project memory
so BK does not have to repeat strategic context, product decisions, recurring
preferences, or known risks, while preserving the Phase 5-7 safety and authority
model.

## Inputs From Previous Phases

- Phase 5 established governance taxonomy, append-only governance events,
  approval gates, skill/connector/secret boundaries, and rollback drills.
- Phase 6 established project profile identity, project -> goal -> work-item
  ancestry, project-isolated queues, and wrong-project remote command guards.
- Phase 7 established report-only parallel specialists, advisory role topology,
  deterministic merge and cleanup gates, rollback evidence, and writer-cap
  governance. Role topology remains advisory metadata only.
- Phase 5 and Phase 6 handoff notes explicitly deferred SOP and memory to Phase
  8 and required source-backed, reviewable, reversible write gates.
- Phase 7 exit review explicitly kept `writerCap` at `1` and did not approve
  multi-writer execution.

## Assumptions

- The deterministic CEO Office remains the owner of durable state, task/action
  creation, approval, dispatch, merge, push, cleanup, recovery, and audit.
- LLM orchestrator calls remain bounded proposal, synthesis, question-drafting,
  review, evaluation, research, content, or operations workers.
- Memory is durable state. It must be written only through deterministic,
  reviewable, reversible gates.
- Memory can inform planning and reporting, but cannot grant execution
  authority.
- Source-of-truth records outrank derived memory summaries.
- Source-backed memory entries must distinguish observed facts, BK decisions,
  and LLM summaries.
- Behavior-changing memory, SOP, or skill updates require explicit review and
  approval before they affect agent prompts or profile behavior.
- Mac-side work may edit, test, and document normal repo code. Active
  automation-host runtime verification remains host-owned.

## Non-Scope

- No writerCap increase.
- No multi-writer execution.
- No routine scheduler.
- No budget enforcement.
- No connector/secret expansion.
- No LLM-owned durable state mutation.
- No memory/SOP override of safety, dispatch, worktree, merge, push, cleanup,
  recovery, approval, or project gates.
- No general self-organizing agent teams.
- No hidden background learning loop.
- No automatic promotion of LLM-generated summaries into source-of-truth state.
- No silent overwrite of project profiles, agent profiles, safety policy, task
  contracts, run logs, governance events, or decision records.

## Memory Authority Rules

- Memory records are context, not authority.
- A memory citation may explain why Samantha recommends something, but the
  recommendation still has to pass normal project, safety, approval, dispatch,
  merge, push, cleanup, and recovery gates.
- A memory or SOP document cannot loosen `DEFAULT_SAFETY_POLICY`, project safety
  overlays, profile governance, connector/secret gates, writer caps, worktree
  allocation, or remote command guards.
- LLM summaries are derived views. They must cite source records and must not be
  treated as source-of-truth records.
- Conflicting memory must be surfaced as ambiguity or risk, not silently
  resolved by recency or model judgment.
- Revisions must preserve prior versions or an append-only history sufficient
  for audit and rollback.

## M1: Baseline And Phase Spec

Goal: open Phase 8 with a phase-specific execution document and roadmap link
before changing runtime behavior.

Focus:

- create this Phase 8 execution document
- link it from the roadmap phase document list and Phase 8 section
- move Phase 8 roadmap status to `in progress`
- incorporate Phase 5/6 handoff notes and the Phase 7 exit review
- define stage sequence and verification expectations
- prepare handoff prompts that can be copied into separate Codex sessions

Verification focus:

- roadmap links to this execution document
- Phase 8 status is `in progress`
- no runtime behavior changes in this stage
- all future stages have explicit Goal, Focus, Verification focus, and Outcome
  placeholders
- `bun run verify:docs` passes

Outcome:

- Added this Phase 8 execution document.
- Linked Phase 8 from the roadmap phase document list and Phase 8 section.
- Moved Phase 8 roadmap status to `in progress`.
- Left runtime behavior unchanged. `DEFAULT_SAFETY_POLICY.writerCap` remains
  `1`.
- Verified with `bun run verify:docs` and `bun run verify:mac`.

## M2: Memory Taxonomy And Source Model

Goal: define what counts as durable memory, what counts as source evidence, and
which memory transitions are governed before any planning prompt consumes
memory.

Focus:

- add the smallest memory taxonomy needed for project briefs, decision
  summaries, preference entries, strategy context, known risks, artifact
  references, and SOP or skill documents
- distinguish observed facts, BK decisions, LLM summaries, and operator notes
- define required source citation fields using stable record ids, ancestry, and
  source kinds instead of local absolute paths
- decide which memory subjects and transitions belong in governance taxonomy
- fail closed for unknown memory kinds, unknown sources, missing citations, and
  path-like ids where stable ids are required
- avoid wiring memory into orchestrator prompts in this stage

Verification focus:

- taxonomy tests cover every memory kind and source kind
- unknown memory kind, source kind, or transition fails closed
- fixture coverage stays in sync with code
- source references preserve project/goal/work-item ancestry where available
- `writerCap` remains `1`

Outcome:

- Added a governed `memory` subject to the governance taxonomy with explicit
  propose, approve, reject, activate, deactivate, archive, and block
  transitions.
- Added the minimal Phase 8 durable memory taxonomy in
  `src/lib/memory-taxonomy.ts`: project briefs, decision summaries,
  preferences, strategy context, known risks, artifact references, SOP
  documents, and skill documents.
- Memory entries now distinguish observed facts, BK decisions, LLM summaries,
  and operator notes, and every durable memory entry requires at least one
  source citation.
- Source citations use stable source kinds, stable record ids, and optional
  project/goal/work-item ancestry; path-like ids fail closed where stable ids
  are required.
- Added `references/memory/taxonomy.json` and focused tests covering fixture
  sync, every memory kind, every source kind, unknown kind/source/transition
  failure, missing citations, ancestry preservation, and `writerCap` staying
  `1`.
- Left runtime behavior and orchestrator prompts unchanged.
- Verified with `bun test tests/governance-taxonomy.test.ts
  tests/risk-policy.test.ts tests/governance-event-store.test.ts
  tests/ancestry.test.ts tests/memory-taxonomy.test.ts`, `bun typecheck`,
  `bun run test:portable`, and `bun run verify:docs`.

## M3: Durable Project Briefs

Goal: create a reviewable durable project-brief layer that summarizes stable
project context without replacing project profiles or runtime state.

Focus:

- define a minimal project brief record or markdown contract for product
  context, current strategy, key constraints, known risks, and open questions
- require project id and source citations for every substantive brief section
- keep project profile identity and resolved runtime roots out of brief
  authority
- make brief reads deterministic and project-scoped
- add write/update behavior only through a pending review path, not silent
  overwrite

Verification focus:

- valid briefs load in deterministic order by project id
- missing project ids, unknown projects, and missing citations are rejected
- a brief cannot override project profile repo roots, remote scopes, safety
  overlays, or dispatch prerequisites
- old or absent briefs produce an explicit "no project memory" result rather
  than inferred context

Outcome:

- Added the minimal durable project brief contract and JSONL store in
  `src/lib/project-brief-store.ts`.
- Project briefs are project-scoped, source-backed, and sectioned into product
  context, current strategy, key constraints, known risks, and open questions.
  Every substantive section entry requires source citations.
- Brief reads are deterministic, sorted by project id, and scoped to known
  project profiles. Absent or pending-only briefs return an explicit
  `no_project_memory` result instead of inferred context.
- Brief writes can only enter `pending_review`; active briefs require review
  evidence and duplicate ids are rejected rather than silently overwritten.
- Brief records reject authority fields such as repo roots, remote scopes,
  safety policy overlays, dispatch prerequisites, forbidden changes, setup or
  verify commands, writer caps, and runtime roots. Briefs remain context only.
- Left orchestrator prompts and runtime authority unchanged.
- Verified with `bun test tests/project-brief-store.test.ts
  tests/memory-taxonomy.test.ts tests/project-profile.test.ts
  tests/project-queues.test.ts tests/ancestry.test.ts
  tests/governance-event-store.test.ts`, `bun typecheck`,
  `bun run test:portable`, and `bun run verify:docs`.

## M4: Decision History Summaries

Goal: let Samantha cite prior BK decisions and governance events without forcing
BK to reread raw decision and event ledgers.

Focus:

- build derived decision-history summaries from existing decision records,
  governance events, operator reports, and ancestry
- preserve links to source decision ids, governance event ids, project ids, goal
  ids, work-item ids, and relevant report ids
- distinguish approved BK decisions from LLM or operator summaries
- mark superseded, rejected, reversed, or stale decisions explicitly
- keep summaries derived and regenerable where possible

Verification focus:

- a planner-facing summary can cite at least one prior BK decision by source id
- stale or reversed decisions are not presented as active policy
- conflicting prior decisions produce a risk or ambiguity result
- summary generation does not mutate source-of-truth records

Outcome:

- Added a derived decision-history summary builder in
  `src/lib/decision-history-summary.ts`.
- Summaries cite source decision ids, related governance event ids, relevant
  report ids, subject plan ids, and preserved ancestry.
- Summaries distinguish BK-resolved decisions from derived LLM/system prompts:
  BK decisions use `bk_decision`, while unresolved/system prompts remain
  derived `llm_summary` context.
- Rejected, pending, archived, superseded, reversed, and stale decisions are
  emitted as inactive guidance and are not mixed into active planner guidance.
- Conflicting prior BK decisions for the same subject produce an explicit
  ambiguity risk instead of silent recency-based selection.
- Summary generation is pure and does not mutate decision, governance event,
  report, or plan source-of-truth records.
- Added focused tests in `tests/decision-history-summary.test.ts`.
- Verified with `bun test tests/decision-history-summary.test.ts`,
  `bun test tests/decision-store.test.ts tests/governance-event-store.test.ts
  tests/operator-review-report.test.ts tests/operator-reports.test.ts
  tests/decision-history-summary.test.ts`, `bun typecheck`,
  `bun run test:portable`, and `bun run verify:docs`.

## M5: Preference And Risk Capture Candidates

Goal: preserve recurring BK preferences and known risks as review candidates
without letting LLMs mutate durable memory directly.

Focus:

- add or reuse a candidate/proposal flow for possible preferences, product
  heuristics, repeated feedback, and known risks
- require source evidence, confidence, project scope, and proposed memory kind
  for every candidate
- separate "candidate captured" from "memory accepted"
- require BK or deterministic operator approval before candidate promotion
- avoid treating frequency alone as approval

Verification focus:

- candidates can be appended, listed, accepted, rejected, or archived through
  deterministic status transitions
- candidates cannot directly edit project briefs, decision summaries, SOPs,
  skills, profiles, policies, connectors, secrets, or task state
- LLM-generated candidate text remains attributed as an LLM summary until
  approved
- rejection and supersession remain audit-visible

Outcome:

- Added a deterministic learning candidate flow in `src/lib/proposal-store.ts`
  alongside the existing proposal store.
- Learning candidates now cover recurring preferences, product heuristics,
  repeated feedback, and known risks with required source evidence, confidence,
  project or cross-project scope, proposed memory kind, and attribution.
- LLM-authored candidates must remain `llm_summary` claims until a later
  deterministic write gate approves durable memory promotion.
- Candidate status transitions support pending review, accepted, rejected, and
  archived states. Accepted candidates only record that the deterministic memory
  write gate is still required; they do not write memory.
- Candidate validation blocks direct mutation payloads for memory, project
  briefs, SOPs, skills, profiles, policies, connectors, secrets, tasks,
  actions, runs, dispatch, merge, push, or cleanup.
- Added `learning_candidate` as a governance source-of-truth record kind so
  candidate review events can be audit-linked without treating candidates as
  active memory.
- Added focused append, list, filter, status, attribution, direct-mutation, and
  governance source tests.
- Left orchestrator prompts, durable memory writes, SOPs, skills, profiles,
  policies, connectors, secrets, tasks, actions, runs, dispatch, merge, push,
  cleanup, and `DEFAULT_SAFETY_POLICY.writerCap` unchanged.
- Verified with `bun test tests/governance-taxonomy.test.ts
  tests/memory-taxonomy.test.ts tests/proposal-store.test.ts
  tests/governance-event-store.test.ts tests/decision-store.test.ts`,
  `bun typecheck`, `bun run test:portable`, and `bun run verify:docs`.

## M6: Searchable Reports And Artifacts

Goal: make prior reports and artifacts searchable enough for planning and
operator review while keeping search read-only and citation-backed.

Focus:

- index or query existing CEO reports, operator reports, run logs, report-only
  artifacts, decision summaries, project briefs, and governance events
- use project/goal/work-item ancestry and stable ids as primary filters
- return compact snippets with citations rather than injecting full historical
  artifacts into prompts
- classify missing, stale, or conflicting artifacts as search results, not
  hidden failures
- avoid new connector, secret, network, or scheduler surfaces

Verification focus:

- search can retrieve context by project id, goal id, work-item id, memory kind,
  and source id
- results include citation metadata and source kind
- missing artifacts and malformed records are reported clearly
- search is read-only and cannot mutate memory, state, profiles, or policies

Outcome:

- Added a read-only searchable context surface in
  `src/lib/context-search.ts`.
- Search indexes already-loaded CEO reports, operator reports, report-only run
  artifacts, explicit artifact previews, derived decision-history summaries,
  project briefs, project-brief absence records, and governance events.
- Results are compact snippets with citation metadata, source kind, source id,
  optional ancestry, status, and memory kind where applicable.
- Search supports project id, goal id, work-item id, memory kind, source id,
  source kind, text, and result limit filters.
- Report-only run logs are exposed as `artifact_reference` results when they
  contain agent output, and as explicit missing-artifact results when artifact
  content is absent.
- Malformed records are surfaced as searchable `malformed_record` results
  instead of hidden failures.
- Search is pure over caller-provided records and does not mutate memory,
  source-of-truth ledgers, project profiles, policies, connectors, secrets,
  network, schedulers, routines, or budgets.
- Added focused tests in `tests/context-search.test.ts`.
- Verified with `bun test tests/context-search.test.ts`, `bun typecheck`, and
  `bun test tests/ceo-report-store.test.ts tests/operator-reports.test.ts
  tests/run-log.test.ts tests/governance-event-store.test.ts
  tests/project-queues.test.ts tests/context-search.test.ts`.

## M7: Bounded Memory Synthesis Worker

Goal: allow LLMs to propose concise memory updates from source evidence without
giving them write authority.

Focus:

- define one bounded memory synthesis prompt and structured payload contract
- require the prompt to list Samantha-provided source evidence and forbid
  invented sources
- validate proposed memory entries, citations, confidence, stale-source notes,
  and behavior-impact flags before any candidate is stored
- store accepted LLM output only as a candidate or proposal until a deterministic
  gate approves it
- keep synthesis read-only with no dispatch, merge, push, cleanup, profile,
  connector, secret, routine, budget, or policy authority

Verification focus:

- valid synthesis output becomes a review candidate, not active memory
- missing citations, unsupported source kinds, behavior-changing claims without
  review flags, and malformed payloads fail closed
- synthesis prompt contains explicit non-authority language
- synthesis cannot overwrite a project brief, SOP, skill, profile, or policy

Outcome placeholder:

- Fill after M7 implementation and verification.

## M8: Deterministic Memory Write Gates And Reversibility

Goal: make memory updates explicit, reviewable, reversible, and auditable before
memory can affect future planning context.

Focus:

- add deterministic write gates for creating, updating, superseding, archiving,
  and restoring memory records
- require source citations and a diff summary for every write
- require explicit approval for behavior-changing memory or SOP updates
- record governance events for approved, rejected, blocked, superseded, and
  restored memory changes
- preserve prior revisions or append-only history sufficient for rollback
- keep memory writes separate from source-of-truth state writes

Verification focus:

- unapproved memory writes are blocked
- approved writes include source citations, actor, timestamp, risk class, and
  diff summary
- restore or supersede operations do not erase history
- behavior-changing updates require explicit BK approval
- LLMs, workers, remote commands, and dashboard views cannot mutate memory
  directly

Outcome placeholder:

- Fill after M8 implementation and verification.

## M9: SOP And Skill Document Contract

Goal: define markdown SOP and skill documents that can guide agents without
becoming hidden execution authority.

Focus:

- define frontmatter for SOP/skill documents, including id, title, project or
  profile scope, source citations, status, risk class, owner, updated date, and
  behavior-impact flag
- require sections for preconditions, workflow steps, quality checks, forbidden
  actions, safety boundaries, and rollback notes where relevant
- add deterministic validation for required fields, citation presence, unsafe
  claims, and blocked authority patterns
- route behavior-changing SOP or skill updates through capability/profile or
  memory approval gates as appropriate
- make clear that SOPs and skills are methodology only

Verification focus:

- valid SOP/skill documents pass frontmatter and section checks
- missing citations, missing preconditions, missing quality checks, or unsafe
  authority claims fail validation
- SOP or skill text cannot override safety policy, dispatch, worktree, merge,
  push, cleanup, recovery, approval, project, connector, secret, routine, or
  budget gates
- blocked skill names remain blocked even if a document requests them

Outcome placeholder:

- Fill after M9 implementation and verification.

## M10: Planning Citation Integration And Exit Review

Goal: close Phase 8 only after Samantha can use memory in planning with
traceable citations and without authority expansion.

Focus:

- inject only selected, citation-backed memory snippets into bounded planning
  prompts
- keep prompt context small and project-scoped
- make planning output cite prior decisions, project briefs, preferences, risks,
  reports, or SOPs when they influence recommendations
- expose "why was this recommended?" through a local report or operating
  surface using stored context citations
- dogfood at least two active project profiles and at least one plan influenced
  by prior decisions or preferences
- update roadmap, architecture, and related docs only for implemented behavior
- write the Phase 8 exit review

Verification focus:

- Samantha can cite prior decisions when planning new work
- memory updates are explicit, reviewable, and reversible
- LLM-generated summaries cannot silently overwrite source-of-truth state
- SOP or skill documents guide agents without overriding safety, dispatch,
  worktree, merge, push, cleanup, recovery, approval, or project gates
- BK can ask why a recommendation was made and trace it to stored context
- `writerCap` remains `1`
- `bun run verify:docs` and `bun run verify:mac` pass unless only docs changed
  in the exit review

Outcome placeholder:

- Fill after M10 implementation, dogfood evidence, and exit verification.

## Stage Handoff Prompts

Use these prompts to hand each stage to a separate Codex session. Each prompt
assumes the session starts from the repository root.

Before working on any stage, check `git status --short`, do not revert
unrelated user changes, and keep runtime authority unchanged unless the stage
explicitly implements a deterministic gate with tests. Confirm all previous
stage Outcome sections before editing. If a previous Outcome is still a
placeholder, treat it as a blocker and ask BK whether to proceed.

### M1 Prompt

Perform Phase 8 M1 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/NORTH_STAR.md`, `docs/ARCHITECTURE.md`,
`docs/SAFETY_AUDIT_GOVERNANCE.md` Phase 6/7/8/9 handoff notes,
`docs/MULTI_PROJECT_OPERATIONS.md` Phase 7/8/9 handoff notes,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md` Phase 7 Exit Review,
`docs/PARALLELISM_EVIDENCE.md`, `src/lib/policy.ts`,
`src/lib/profile-governance.ts`, `src/lib/governance-event-store.ts`,
`src/lib/project-profile.ts`, and `src/lib/orchestrator-agent.ts`.
이전 stage Outcome을 확인하라. For M1, there are no previous Phase 8 stage
Outcomes, so verify the Phase 5/6 handoff notes and Phase 7 exit review
instead.

Create or refine the Phase 8 execution document, link it from the roadmap phase
document list and Phase 8 section, and mark Phase 8 `in progress`. M1 is docs
and roadmap only. Do not change runtime behavior, source code, tests, state,
runs, dispatch, merge, push, cleanup, recovery, profile authority, connector or
secret access, routines, budgets, or `DEFAULT_SAFETY_POLICY.writerCap`. Run
`bun run verify:docs`.

### M2 Prompt

Implement Phase 8 M2 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` through M2, all previous Phase 8 stage
Outcome sections, `docs/SAFETY_AUDIT_GOVERNANCE.md`,
`docs/MULTI_PROJECT_OPERATIONS.md`, `docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`
Authority Review, `src/lib/governance-taxonomy.ts`,
`src/lib/risk-policy.ts`, `src/lib/governance-event-store.ts`,
`src/lib/ancestry.ts`, `references/governance/taxonomy.json`,
`tests/governance-taxonomy.test.ts`, `tests/risk-policy.test.ts`,
`tests/governance-event-store.test.ts`, and `tests/ancestry.test.ts`.
이전 stage Outcome을 확인하라.

Define the smallest memory taxonomy and source model needed for Phase 8. Memory
must distinguish observed facts, BK decisions, LLM summaries, and operator
notes, and every durable memory entry must cite source evidence. Add focused
tests and fixtures for fail-closed taxonomy behavior. Do not wire memory into
orchestrator prompts yet. Keep `writerCap` at `1`.

### M3 Prompt

Implement Phase 8 M3 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` through M3, all previous Phase 8 stage
Outcome sections, `docs/MULTI_PROJECT_OPERATIONS.md`,
`src/lib/project-profile.ts`, `src/lib/project-safety-policy.ts`,
`src/lib/ancestry.ts`, `src/lib/governance-event-store.ts`,
`tests/project-profile.test.ts`, `tests/project-queues.test.ts`,
`tests/ancestry.test.ts`, and nearby JSONL or markdown validation tests.
이전 stage Outcome을 확인하라.

Create the minimal durable project brief contract and store/read path. Briefs
must be project-scoped, source-backed, reviewable, and unable to override
project profiles, safety overlays, remote scopes, dispatch prerequisites, or
runtime roots. Add focused validation and read tests. Do not add prompt
injection unless this stage explicitly proves a narrow read-only surface.

### M4 Prompt

Implement Phase 8 M4 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` through M4, all previous Phase 8 stage
Outcome sections, `src/lib/decision-store.ts`,
`src/lib/governance-event-store.ts`, `src/lib/operator-review-report.ts`,
`src/lib/operator-reports.ts`, `src/lib/orchestrator-store.ts`,
`tests/decision-store.test.ts`, `tests/governance-event-store.test.ts`,
`tests/operator-review-report.test.ts`, and `tests/operator-reports.test.ts`.
이전 stage Outcome을 확인하라.

Build derived decision-history summaries that cite source decisions, governance
events, reports, and ancestry. Summaries must distinguish BK decisions from LLM
summaries and must mark stale, rejected, superseded, or reversed decisions
instead of presenting them as active guidance. Do not mutate source-of-truth
records. Add focused summary tests.

### M5 Prompt

Implement Phase 8 M5 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` through M5, all previous Phase 8 stage
Outcome sections, `docs/HERMES_AGENT_ADOPTION_REVIEW.md` learning candidate
notes, `src/lib/proposal-store.ts`, `src/lib/decision-store.ts`,
`src/lib/governance-event-store.ts`, `src/lib/ancestry.ts`,
`tests/proposal-store.test.ts`, `tests/decision-store.test.ts`, and
`tests/governance-event-store.test.ts`. 이전 stage Outcome을 확인하라.

Add or reuse a deterministic candidate/proposal flow for recurring preferences,
product heuristics, repeated feedback, and known risks. Candidates must not
directly mutate memory, SOPs, skills, profiles, policies, connectors, secrets,
tasks, actions, or runs. Candidate promotion requires a later deterministic
write gate. Add focused append/list/status tests and keep LLM output attributed.

### M6 Prompt

Implement Phase 8 M6 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` through M6, all previous Phase 8 stage
Outcome sections, `src/lib/ceo-report-store.ts`, `src/lib/operator-reports.ts`,
`src/lib/run-log.ts`, `src/lib/governance-event-store.ts`,
`src/lib/orchestrator-store.ts`, `src/lib/project-queues.ts`,
`tests/ceo-report-store.test.ts`, `tests/operator-reports.test.ts`,
`tests/run-log.test.ts`, `tests/governance-event-store.test.ts`, and
`tests/project-queues.test.ts`. 이전 stage Outcome을 확인하라.

Create a read-only searchable context surface for reports, artifacts, briefs,
decision summaries, and governance events. Results must be compact,
project-scoped where possible, and citation-backed. Search must not mutate
memory or source-of-truth state and must not add connector, secret, network,
scheduler, routine, or budget surfaces. Add focused search tests.

### M7 Prompt

Implement Phase 8 M7 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` through M7, all previous Phase 8 stage
Outcome sections, `src/lib/orchestrator-agent.ts`,
`src/lib/worker-dispatch.ts`, `src/lib/policy.ts`,
`src/lib/profile-governance.ts`, the memory taxonomy/store files added by
M2-M6, `tests/orchestrator-agent.test.ts`, `tests/policy.test.ts`, and the
memory tests added by M2-M6. 이전 stage Outcome을 확인하라.

Add one bounded memory synthesis worker contract. It may propose memory updates
from Samantha-provided evidence, but valid output must become only a review
candidate until approved by deterministic gates. The prompt must forbid
invented sources and all execution authority. Validate malformed payloads,
missing citations, unsupported source kinds, and behavior-changing claims. Do
not allow direct memory overwrite.

### M8 Prompt

Implement Phase 8 M8 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` through M8, all previous Phase 8 stage
Outcome sections, `docs/SAFETY_AUDIT_GOVERNANCE.md`,
`src/lib/decision-store.ts`, `src/lib/risk-policy.ts`,
`src/lib/governance-event-store.ts`, `src/lib/profile-governance.ts`, memory
files added by M2-M7, `tests/decision-store.test.ts`,
`tests/risk-policy.test.ts`, `tests/governance-decision-cli.test.ts`,
`tests/governance-event-store.test.ts`, and memory tests added by M2-M7.
이전 stage Outcome을 확인하라.

Implement deterministic memory write gates and reversibility. Memory writes
must require citations and diff summaries; behavior-changing memory or SOP
updates require explicit BK approval. Governance events must record approved,
rejected, blocked, superseded, and restored changes. History must remain
auditable. LLMs, workers, remote commands, and dashboard views must not mutate
memory directly.

### M9 Prompt

Implement Phase 8 M9 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
`docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md` through M9, all previous Phase 8 stage
Outcome sections, `docs/ARCHITECTURE.md` Skill Policy,
`docs/AGENT_SKILLS_ADOPTION_NOTES.md`, `docs/HERMES_AGENT_ADOPTION_REVIEW.md`
skill metadata and scanner notes, `src/lib/policy.ts`,
`src/lib/profile-governance.ts`, `src/lib/contracts.ts`,
`tests/policy.test.ts`, `tests/profile-governance.test.ts`, and SOP/skill
tests added in this stage. 이전 stage Outcome을 확인하라.

Define the SOP/skill markdown contract with frontmatter, preconditions,
workflow steps, quality checks, forbidden actions, safety boundaries, rollback
notes, and citations. Add deterministic validation for unsafe authority claims.
SOPs and skills are methodology only and cannot override Samantha safety,
dispatch, worktree, merge, push, cleanup, recovery, approval, project,
connector, secret, routine, or budget gates. Keep blocked skill names blocked.

### M10 Prompt

Perform Phase 8 M10 from `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`.

먼저 읽을 문서/코드/테스트: `AGENTS.md`, `docs/CEO_OFFICE_ROADMAP.md`,
all of `docs/CONTEXT_AND_KNOWLEDGE_MEMORY.md`, every previous Phase 8 stage
Outcome section, `docs/NORTH_STAR.md`, `docs/ARCHITECTURE.md`,
`docs/SAFETY_AUDIT_GOVERNANCE.md`, `docs/MULTI_PROJECT_OPERATIONS.md`,
`docs/EVIDENCE_BASED_PARALLELISM_EXPANSION.md`, `docs/PARALLELISM_EVIDENCE.md`,
`src/lib/orchestrator-agent.ts`, `src/lib/operator-reports.ts`,
`src/lib/ceo-status.ts`, the memory/SOP files added by M2-M9, and the tests
changed by M2-M9. 이전 stage Outcome을 확인하라.

Integrate only selected, citation-backed memory snippets into bounded planning
context and write the Phase 8 exit review. Planning must cite prior decisions,
briefs, preferences, risks, reports, or SOPs when they influence
recommendations. Add a local "why was this recommended?" trace if it does not
already exist. Dogfood at least two active project profiles and at least one
plan influenced by prior memory. Update roadmap, architecture, and related docs
only for implemented behavior. Keep `writerCap` at `1`, do not add
multi-writer execution, and do not expand connector, secret, routine, budget,
merge, push, cleanup, recovery, approval, or runtime authority. Run
`bun run verify:docs` and `bun run verify:mac` unless the M10 change is docs
only and the narrower docs verification is sufficient.
