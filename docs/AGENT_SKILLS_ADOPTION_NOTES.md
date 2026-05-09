# Agent Skills Adoption Notes

Last updated: 2026-05-10

Status: deferred reference notes.

This document captures review notes about possibly borrowing ideas from
[`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) later.
It is not an active implementation plan and should not change the current phase
scope.

## Decision

Do not insert an `agent-skills` pilot into an already planned phase
implementation.

Finish the current Samantha system plan first. After the relevant governance and
dispatch work is complete, revisit `agent-skills` as external reference material
and borrow only the parts that fit Samantha's existing contracts.

## Reasoning

`agent-skills` and Samantha operate at different abstraction layers:

- `agent-skills` is a prompt-first collection of workflow documents for LLM
  agents.
- Samantha is a contract-first deterministic TypeScript CEO Office with safety,
  dispatch, approval, and audit gates.

The useful asset in `agent-skills` is not a runtime system. The useful asset is
the senior engineering judgment embedded in the skill documents: review
checklists, testing discipline, security triggers, incremental implementation
rules, and release-quality heuristics.

Adding a skill pilot during a governance phase would mix two questions:

- whether Samantha's planned governance/dispatch implementation works
- whether a specific external methodology bundle improves agent output

Those should be evaluated separately. Otherwise phase exit criteria become
harder to interpret.

## Existing Samantha Slot

Samantha already has a concept of skill governance through `SkillBundleRef`,
`skillPolicy.requiredBundles`, blocked skill names, and capability/profile
governance.

Important nuance: this is currently a governance slot, not necessarily a generic
skill loader or runtime. A registered bundle should not be assumed to affect
worker behavior unless Samantha deliberately renders that method into a bounded
prompt or another explicit contract.

If a future change adds a bundle to an agent profile, expect two separate review
questions:

- profile authority changed because `requiredBundles` changed
- capability changed because a skill bundle is now allowed for that profile

Both may require explicit governed approval depending on the final Phase 5
contracts.

## Future Adoption Rules

When revisiting `agent-skills`, use these constraints:

- Treat external skills as methodology only, never as orchestration authority.
- Do not import hooks, slash commands, agent launchers, or plugin runtime
  behavior by default.
- Do not let a skill create worktrees, dispatch agents, grant connector access,
  read secrets, commit, merge, push, clean up, approve decisions, or mutate
  durable Samantha state.
- Pin any external source to an exact commit SHA before relying on it.
- Preserve license and copyright notice when copying or adapting text.
- Prefer mapping a small checklist into existing Samantha prompts, tests, or
  policy docs before creating any generic skill loader.
- Add a generic loader only after repeated, proven need. A single borrowed
  checklist is not enough justification.

## Likely Useful Material

Review these later as candidates, not as immediate scope:

- `code-review-and-quality`: good fit for `codex-reviewer` report-only work.
- `test-driven-development`: possible input for writer/evaluator task guidance.
- `debugging-and-error-recovery`: possible input for recovery planning and
  evaluator checks.
- `security-and-hardening`: useful as review triggers, but avoid bloating
  governance taxonomy with app-security checklist detail.
- `source-driven-development`: useful when a task depends on library or API
  behavior that must be verified from source.
- `context-engineering`: useful for bounded prompt quality and context hygiene.

Treat commands such as shipping workflows, hooks, broad git workflow automation,
and subagent fan-out patterns as high-risk until proven compatible with
Samantha's control-plane boundaries.

## Recommended Later Review

After the current planned implementation is complete:

1. Pick one concrete weakness in Samantha worker output.
2. Choose one `agent-skills` document that directly addresses that weakness.
3. Extract only the checklist or judgment rule needed.
4. Decide its home: reviewer prompt, evaluator prompt, task instruction
   template, deterministic policy, documentation, or no adoption.
5. Verify with one normal Samantha task after the existing gates pass.
6. Only then decide whether `SkillBundleRef` registration or a richer manifest
   is warranted.

The default answer should remain: borrow judgment, not runtime.
