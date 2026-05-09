# Hermes Agent Adoption Review

Last updated: 2026-05-10

Status: deferred review notes. Revisit only after the current Samantha roadmap
has been implemented and verified.

## Purpose

This document preserves the session-level review of
[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) for
future reconsideration.

The review question was not whether Samantha should become Hermes. It was:

- which Hermes mechanisms are worth borrowing later
- which Hermes mechanisms conflict with Samantha's deterministic CEO Office
  model
- what should be revisited after Samantha's roadmap implementation is complete
- what should remain out of scope even if Hermes has good user feedback

This is intentionally not an active implementation plan. It should not be used
to insert a Hermes pilot into an in-progress roadmap phase. Treat it as a
scope guard and revisit checklist for the post-roadmap review.

## Bottom Line

Do not fork Hermes wholesale.

Borrow only narrow safety and governance mechanisms:

- learning candidate inboxes
- skill metadata standards
- static skill scanning
- hardline deny rules
- capability catalog patterns
- explicit subagent context isolation principles

Do not borrow Hermes' autonomy loop:

- no LLM self-evaluation based skill promotion
- no automatic skill or memory mutation
- no long-running AIAgent runtime fork
- no multi-provider credential pool
- no messenger gateway transplant
- no DSPy/GEPA self-evolution path until there is stronger evidence and a
  Samantha-native safety envelope

The main insight is that Hermes is a useful stress case for Samantha. Hermes
shows what becomes attractive once an agent can learn, remember, delegate, and
connect to many surfaces. It also shows the failure modes Samantha's design is
trying to avoid: silent state loss, memory drift, oversized prompt surfaces,
credential blast radius, and authority expansion through convenience features.

Samantha should therefore adopt Hermes-derived mechanisms only when they are
wrapped by Samantha's deterministic governance, audit, and approval model.

## Framing Assumptions

This review assumes the following Samantha invariants remain true:

- Samantha is a deterministic TypeScript CEO Office, not a permanently running
  LLM conversation.
- Durable state, dispatch, merge, push, cleanup, approval, and safety policy
  are owned by Samantha code.
- LLM agents are bounded workers, reviewers, evaluators, researchers,
  synthesizers, or spec helpers.
- BK talks to the orchestrator surface, not directly to autonomous workers.
- Production writers use isolated worktrees.
- Writer cap remains `1` unless dogfood evidence explicitly justifies a later
  increase.
- Non-writer parallelism is allowed only when tasks are report-only and bounded.
- Safety gates beat agent suggestions.
- Skill bundles are methodology or bounded prompt material, not orchestration
  authority.

If any of these invariants change before this document is revisited, the
recommendations below must be re-evaluated from first principles.

## What Hermes Is

Hermes Agent is positioned as a self-improving personal AI agent. Its public
repo presents a broad operating surface:

- long-lived agent loop
- memory and user model
- skill creation and curation
- delegation and parallelization
- approval tooling
- terminal and execution backends
- messaging gateway integrations
- multiple provider support
- scheduled or background activity

This makes Hermes close enough to Samantha's domain to be useful as a reference
project. It is not close enough to be a safe architectural base for Samantha.

The systems optimize for different control points:

- Hermes optimizes for an agent that can do more by itself over time.
- Samantha optimizes for a control plane that can safely authorize, bound,
  dispatch, audit, and recover work.

That difference should determine every adoption decision.

## Review Evidence

The review combined repository inspection with external issue and commentary
signals. The strongest evidence came from Hermes code and GitHub issues. Blog
posts and community commentary are useful as prompts for investigation, but
should not be treated as primary proof unless their claims can be reproduced or
verified from primary artifacts.

Primary artifacts reviewed:

- Hermes repository root and README:
  <https://github.com/NousResearch/hermes-agent>
- Skill scanner:
  <https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_guard.py>
- Skill manager:
  <https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py>
- Skill curator:
  <https://github.com/NousResearch/hermes-agent/blob/main/agent/curator.py>
- Approval and sensitive command policy:
  <https://github.com/NousResearch/hermes-agent/blob/main/tools/approval.py>
- Delegation tool:
  <https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool.py>
- Code execution tool:
  <https://github.com/NousResearch/hermes-agent/blob/main/tools/code_execution_tool.py>
- Memory manager:
  <https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_manager.py>
- Tool registry:
  <https://github.com/NousResearch/hermes-agent/blob/main/tools/registry.py>

Issue signals discussed:

- Memory flush overwrite / merge risk:
  <https://github.com/NousResearch/hermes-agent/issues/2670>
- Token overhead issue:
  <https://github.com/NousResearch/hermes-agent/issues/4379>
- Memory persistence / state database corruption:
  <https://github.com/NousResearch/hermes-agent/issues/5563>

Lower-confidence signals discussed:

- Reddit/community comments about LLM self-evaluation being overconfident.
- Blog commentary about long-run production drift, memory behavior, and
  messenger/cron conflicts.
- External discussion of LiteLLM supply-chain risk and multi-provider
  credential exposure.

These lower-confidence signals are still useful for threat modeling, but they
should not be used as sole justification for code changes. The safer conclusion
is narrower: multi-provider credential pools expand the blast radius, and
Samantha should not add that surface until it has a strong connector and secret
governance model.

## Strong Positive Findings

Hermes contains several well-engineered mechanisms that are worth studying
later.

### Skill Metadata And Manager

Hermes uses `SKILL.md`-style skill artifacts with frontmatter validation,
content limits, path constraints, and a skill manager.

Useful ideas:

- explicit skill metadata
- required `name` and `description`
- bounded file sizes
- constrained skill directories
- provenance-oriented skill lifecycle
- separation between built-in and externally sourced skills

Samantha mapping:

- `SkillBundleRef` already exists in `src/lib/contracts.ts`.
- `skillPolicy.requiredBundles` and `blockedSkills` already exist in agent
  profiles.
- Profile governance already treats skill bundle changes as capability changes.

Recommended later direction:

- define a Samantha `SkillManifest` schema before creating any generic loader
- include source, pinned ref, checksum, license, provenance, risk categories,
  required tools, required secrets, required connectors, and intended profile
  scope
- keep external skills as reviewable artifacts until BK approval promotes them
- never let a skill itself grant authority

### Static Skill Scanner

Hermes has a static skill scanner with six useful risk categories:

- `exfiltration`
- `injection`
- `destructive`
- `persistence`
- `network`
- `obfuscation`

Useful ideas:

- regex and heuristic scanning before skill installation
- severity classes
- trust levels for built-in, trusted, community, and agent-created skills
- install policy that blocks or requires review for risky findings

Samantha mapping:

- This belongs in a pure TypeScript module, likely `src/lib/skill-safety.ts`
  or similar.
- It should be a deterministic scanner, not an LLM reviewer.
- Scanner output should feed proposal or governance review, not directly mutate
  profiles.

Recommended later direction:

- make scanner default ON for any external skill import
- treat findings as `allow`, `needs_review`, or `block`
- keep the scanner conservative and explainable
- add tests with known dangerous skill snippets
- require BK approval for any risky imported skill even if static scanning is
  only heuristic

### Approval And Hardline Deny Rules

Hermes' approval code contains useful sensitive path and destructive command
patterns.

Useful ideas:

- hardline deny list for commands that approval cannot override
- sensitive write target detection
- special handling for credential and environment files
- detection of shell startup file writes
- detection of raw disk, system shutdown, recursive deletion, and similar
  actions

Samantha mapping:

- Current `src/lib/risk-policy.ts` classifies governance transitions.
- It should not become a regex dumping ground.
- A separate hardline layer is cleaner, for example `src/lib/hardline-policy.ts`.

Recommended later direction:

- create a deterministic hardline policy module
- apply it to setup commands, remote actions, future host-only commands, and
  any command execution path before approval checks
- make hardline blocks non-overridable by BK approval
- preserve an audit event explaining the block
- keep risk classification and hardline deny separate:
  - risk classification asks whether an allowed transition needs approval
  - hardline deny says a specific action must not execute at all

### Capability Registry Pattern

Hermes has a central tool registry with schema, handlers, checks, and dynamic
availability. Samantha should not copy this runtime directly, but the catalog
idea is valuable.

Useful ideas:

- central inventory of available capabilities
- explicit schemas
- availability checks
- policy-aware registration
- cache or TTL for expensive checks

Samantha mapping:

- Samantha already has distributed governance surfaces:
  - `profile-governance.ts`
  - `risk-policy.ts`
  - `policy.ts`
  - `remote-action-store.ts`
  - agent profile JSON files
  - project profiles
- A read-only capability catalog could unify connector, secret, skill bundle,
  remote action, host-only command, routine, and profile authority.

Recommended later direction:

- begin with a read-only projection, not a new authority system
- derive catalog entries from existing source-of-truth records
- include owner, subject type, authority surface, risk class, approval status,
  active/inactive state, and audit references
- only later consider using the catalog as an enforcement input

### Subagent Context Isolation

Hermes' delegation model is useful as a principle even if its runtime is not.
The child agent should not inherit the entire parent conversation. It should
receive a bounded goal, explicit context, and a narrow contract. The parent
should receive a final summary or artifact, not the child's entire internal
history.

Samantha mapping:

- Current worker dispatch already builds prompts from task contracts and agent
  profiles.
- Non-writer tasks are report-only and should not mutate files.
- Writer prompts are bounded by target files, forbidden changes, setup
  commands, verify commands, and worktree policy.

Recommended later direction:

- document this as a dispatch invariant
- add regression tests that workers do not receive unrelated parent history
- keep non-writer parallelism report-only
- feed only final summaries back into the orchestrator state
- do not import Hermes' delegation runtime or nested agent authority

### Streaming Context Scrubbing

Hermes includes streaming context scrubbing for memory tags. Samantha does not
currently need to adopt this as a priority, but it is a good reference if
Samantha later streams hidden context into visible channels.

Useful idea:

- hidden context markers should never leak into user-visible stream output

Samantha mapping:

- This is relevant only if Samantha later streams model responses that include
  hidden memory, policy, connector, or internal state blocks.

Recommended later direction:

- defer until Samantha has a streaming surface that can leak hidden context
- if adopted, make scrubbing deterministic and tested with chunk-boundary cases

## Strong Negative Findings

The following Hermes patterns should not be adopted into Samantha.

### LLM Self-Evaluation Based Skill Promotion

The most dangerous pattern is not skill creation itself. The dangerous pattern
is letting the same LLM that performed the task decide that its own new habit,
memory, or skill should become durable capability.

Failure mode:

- an LLM completes work with incomplete understanding
- it overestimates success
- it writes a skill or memory that encodes the mistake
- future runs treat that mistake as durable guidance

Samantha decision:

- no automatic skill promotion
- no automatic profile mutation
- no direct durable memory writes from workers
- all learning artifacts stay in a proposal or candidate queue until reviewed

### Automatic Skill Or Memory Mutation

Hermes' learning loop is attractive, but it introduces a silent mutation
surface. Samantha should treat learned material as untrusted until reviewed.

Samantha decision:

- workers may suggest learning candidates
- Samantha may store those candidates as pending records
- BK or a governed review flow decides whether to publish, merge, archive, or
  drop
- publication must preserve provenance and audit trail

### Memory Flush Overwrite Patterns

External issue signals around memory overwrite and state loss reinforce
Samantha's single-writer design.

Samantha decision:

- no multi-writer memory flush
- no background process that rewrites durable state without ownership
- no silent merge of unrelated memory scopes
- any future memory compaction must have explicit input, output, owner,
  checksum or version, and audit event

### Multi-Provider Credential Pool

Hermes' broad provider support is useful for flexibility, but Samantha should
avoid a broad credential pool until secret governance is mature.

Samantha decision:

- no generic multi-provider credential pool in near-term scope
- connector and secret grants must be per-profile, explicit, reviewed, and
  auditable
- no worker inherits BK or host credentials by default
- no provider expansion without capability registry and secret audit support

### Messenger Gateway Transplant

Hermes supports broad messaging surfaces. Samantha already treats Telegram as a
compact adapter, not the primary workspace.

Samantha decision:

- do not transplant Hermes' gateway
- keep messaging adapters narrow
- remote approvals should resolve deterministic decisions, not start arbitrary
  agent behavior
- dashboard and CLI remain authoritative operator surfaces

### Full AIAgent Runtime Fork

Hermes' main agent loop is a different architecture from Samantha.

Samantha decision:

- do not fork the AIAgent runtime
- do not make Samantha a persistent autonomous LLM session
- keep LLM calls bounded by task, plan, synthesis, review, or question drafting

### DSPy / GEPA Self-Evolution

Self-evolution may be interesting later, but it is not compatible with
Samantha's current safety posture without significant evidence and gates.

Samantha decision:

- defer indefinitely
- require separate research, benchmarks, human review gates, rollback, and
  proof that it improves bounded worker quality without expanding authority

## Integrated Adoption Candidates

The session produced a combined ranking from two analyses: one focused more on
Hermes code and external failure evidence, the other focused more on how the
ideas map into Samantha's existing architecture.

The ranking below is the recommended order for post-roadmap reconsideration.

### 1. Learning Candidates Inbox

Priority: highest.

Description:

- a JSONL-backed queue of possible lessons, memories, skill updates, policy
  suggestions, or wiki candidates
- created as pending review records
- never published automatically

Why it matters:

- captures useful learning without durable self-mutation
- gives BK and Samantha a review point
- aligns with existing proposal and decision store patterns

Possible Samantha shape:

- extend `ProposalStore`, or add a sibling `LearningCandidateStore`
- candidate statuses:
  - `pending_review`
  - `accepted`
  - `rejected`
  - `archived`
  - `published`
- candidate types:
  - `skill_candidate`
  - `wiki_candidate`
  - `policy_candidate`
  - `profile_candidate`
  - `memory_candidate`
  - `runbook_candidate`
- required fields:
  - id
  - createdAt
  - sourceRunId
  - sourceTaskId
  - sourceAgentId
  - sourceKind
  - summary
  - proposedContent
  - evidence
  - riskClass
  - status
  - reviewedBy
  - reviewedAt
  - reviewNote

Important constraint:

- candidate creation is not publication
- candidate acceptance is not necessarily activation
- activation of any capability must still go through governance

### 2. Skill Manifest And Frontmatter Standard

Priority: high.

Description:

- a standard metadata schema for skill-like artifacts
- compatible in spirit with `SKILL.md`, but Samantha-native

Recommended fields:

- `id`
- `name`
- `description`
- `version`
- `source`
- `sourceRepo`
- `sourceRef`
- `sourcePath`
- `license`
- `checksum`
- `provenance`
- `maintainer`
- `intendedProfiles`
- `riskCategories`
- `requiredTools`
- `requiredConnectors`
- `requiredSecrets`
- `requiredRuntime`
- `allowedActions`
- `forbiddenActions`
- `activationStatus`
- `reviewDecisionId`

Important constraint:

- a manifest describes methodology or prompt material
- it does not grant runtime authority
- authority is granted only through profile/capability governance

### 3. Capability Registry Projection

Priority: high.

Description:

- a central read-only catalog of governed authority surfaces

Candidate capability types:

- agent profile
- skill bundle
- connector
- secret
- remote action
- host-only command
- routine
- policy
- budget
- worktree operation
- merge operation
- push operation
- cleanup operation

Recommended fields:

- `capabilityId`
- `kind`
- `subjectType`
- `subjectId`
- `owner`
- `sourceOfTruth`
- `riskClass`
- `status`
- `requiredDecisionKind`
- `approvalDecisionId`
- `activeSince`
- `lastReviewedAt`
- `auditRefs`

Important constraint:

- first implementation should be projection-only
- do not replace existing governance modules in the first pass
- use it to make review and audit clearer before using it as an enforcement
  dependency

### 4. Hardline Deny Layer

Priority: high.

Description:

- deterministic rules for actions that must never execute, even with approval

Candidate blocked patterns:

- destructive root/system deletes
- raw disk writes
- system shutdown or reboot
- fork bombs
- shell startup file writes
- credential file writes
- `.env` and secret file writes outside explicit approved secret workflows
- writes under `~/.ssh`
- broad home directory cleanup
- command strings that combine network exfiltration with secret reads

Recommended shape:

- pure module with no side effects
- accepts structured command/action input
- returns `allow` or `block`
- includes block reason and matched rule id
- produces audit-friendly messages

Important constraint:

- hardline blocks are not approval prompts
- they are execution stops

### 5. Skill Static Scanner

Priority: medium-high.

Description:

- deterministic scanner for imported skill text and attached scripts

Risk categories:

- exfiltration
- injection
- destructive
- persistence
- network
- obfuscation

Recommended output:

- finding id
- category
- severity
- file path
- line number when available
- matched pattern name
- short explanation
- recommended disposition

Important constraint:

- scanner findings are conservative signals
- passing the scanner does not mean the skill is safe
- failing the scanner should block or require explicit review depending on
  severity

### 6. Subagent Context Isolation

Priority: medium.

Description:

- child agents receive only explicit task context
- parent conversation history is not inherited by default
- final child output is summarized or attached as an artifact

Samantha already partly has this through task-contract dispatch. Later work
should document and test the invariant.

Important constraint:

- do not add nested autonomous delegation
- keep writer authority centralized
- keep non-writer children report-only

### 7. Sensitive Path Rules With Environment Expansion

Priority: medium.

Description:

- detect sensitive write targets even when paths use `~`, `$HOME`, env vars, or
  shell expansion

Candidate sensitive targets:

- `~/.ssh`
- shell rc/profile files
- `.env`
- `.env.*`
- credentials files
- cloud config directories
- keychains or token stores
- git config credential helpers

Important constraint:

- this belongs with hardline or action preflight
- it should not rely on the LLM to interpret command safety

### 8. Prompt-Cache Invariance Rule

Priority: medium-low.

Description:

- avoid mid-conversation memory or context reloads that invalidate prompt-cache
  assumptions
- defer cache invalidation by default
- require explicit opt-in for immediate reload behavior

Samantha mapping:

- likely an AGENTS.md / dispatch policy note rather than code at first
- useful because repeated Codex CLI calls make context stability and cache hit
  rates cost-relevant

Important constraint:

- this is an optimization and consistency rule, not a substitute for safety
  policy

### 9. Progressive Disclosure Catalog

Priority: medium-low.

Description:

- profiles list allowed skill ids
- prompts receive only the relevant skill summaries or selected skill content
- full skill text is not injected unless needed

Samantha mapping:

- later prompt-builder enhancement
- depends on manifest and registry work

Important constraint:

- do not build a generic skill loader before repeated need is proven
- start with explicit prompt rendering for one or two carefully chosen bundles

## Recommended Post-Roadmap Implementation Sequence

When this document is revisited, implement in small PRs.

### PR 1: Adoption Guardrail And Hardline Deny

Goal:

- document the Hermes adoption boundary
- add deterministic hardline deny checks

Expected changes:

- this document may be updated from deferred notes to active review
- add `src/lib/hardline-policy.ts`
- add tests for blocked commands and sensitive paths
- wire checks only into the narrowest existing execution surface selected for
  the phase

Verification:

- unit tests prove blocked commands cannot proceed
- existing dispatch tests still pass
- no profile, skill, or connector authority changes are introduced

### PR 2: Learning Candidate Store

Goal:

- preserve possible lessons without self-mutation

Expected changes:

- add `LearningCandidateRecord` or extend `ProposalRecord`
- add append/list/update status operations
- add tests for duplicate ids, status transitions, and JSONL persistence

Verification:

- candidates can be created and reviewed
- candidates cannot directly mutate profiles, skills, docs, memory, or policy
- accepted candidates still require separate publish or governance flow

### PR 3: Skill Manifest And Static Scanner

Goal:

- define external skill import safety before any loader exists

Expected changes:

- add manifest type/schema
- add static scanner module
- add fixtures for safe and unsafe skill text
- update docs with import policy

Verification:

- scanner detects exfiltration, injection, destructive, persistence, network,
  and obfuscation fixtures
- manifest validation requires source pinning and provenance
- no skill activation path is added yet

### PR 4: Capability Registry Projection

Goal:

- make governed authority visible in one catalog

Expected changes:

- add read-only capability catalog builder
- derive entries from existing profiles, skill policy, connector grants, secret
  grants, remote action definitions, and safety policy
- add tests for stable capability ids and approval metadata

Verification:

- catalog reflects existing governance without changing enforcement
- unapproved capability changes remain blocked by current profile governance
- dashboard or CLI usage is optional until a later phase

### PR 5: Dispatch Context Isolation Tests

Goal:

- lock in Samantha's bounded worker context model

Expected changes:

- add tests around worker prompt construction
- assert parent conversation history is not included
- assert non-writer report-only constraints are present
- assert skill bundles cannot override Samantha gates

Verification:

- prompt tests pass
- no behavior changes unless a gap is discovered

## Revisit Checklist

Only reconsider active adoption after the roadmap implementation is complete
and the following questions can be answered:

1. Which concrete Samantha weakness are we trying to fix?
2. Is the weakness in worker output quality, governance visibility, safety
   preflight, learning retention, prompt cost, or operator review?
3. Can the weakness be fixed by a small deterministic module instead of a
   runtime import?
4. Does the proposed adoption expand agent authority?
5. If authority expands, what capability record, approval decision, audit event,
   and rollback path cover it?
6. Does the adoption create a new durable state writer?
7. If yes, who owns the writer lock?
8. Does the adoption add connector or secret access?
9. If yes, is access scoped by profile and visible in the capability catalog?
10. Does the adoption add background or scheduled behavior?
11. If yes, how are conflicts, retries, and stale state handled?
12. Does the adoption rely on an LLM judging its own success?
13. If yes, redesign it.
14. Can failure be silent?
15. If yes, add alarms, audit events, and explicit blocked states before
    adoption.
16. Can the result be verified with a small test fixture?
17. Is there a rollback path that does not require manual archaeology?

Default answer:

- borrow the mechanism only if it strengthens Samantha's deterministic control
  plane
- reject it if it makes Samantha more autonomous without adding stronger
  governance

## Open Questions For Future Review

These questions were intentionally left unresolved in the session:

- Should learning candidates reuse `ProposalStore`, or should they have a
  dedicated `LearningCandidateStore`?
- Should `SkillManifest` live in `contracts.ts`, a new `skill-manifest.ts`, or
  under a future governance module?
- Should hardline policy run before or after risk classification in every
  execution path?
- Which command surfaces exist by the time the roadmap completes?
- Does Samantha need a generic capability registry, or only a dashboard-facing
  projection?
- Should prompt-cache invariance be a repo-level AGENTS rule, a worker dispatch
  invariant, or both?
- What source pinning format should Samantha require for external skill
  imports?
- How should license and attribution be preserved if a skill is adapted rather
  than copied?
- What is the minimum dogfood evidence required before any learning candidate
  can become a reusable skill?

## Final Session Recommendation

After the roadmap is complete, start with the smallest high-leverage safety
work:

1. hardline deny module
2. learning candidate inbox
3. skill manifest and scanner
4. read-only capability registry projection
5. context isolation and prompt-cache invariance documentation/tests

Do not begin with a Hermes runtime fork, skill curator, messenger gateway,
provider pool, or self-improvement loop.

The enduring rule is:

> Borrow Hermes' safety lessons and metadata discipline, not Hermes' autonomy.

