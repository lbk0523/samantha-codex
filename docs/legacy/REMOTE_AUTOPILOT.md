# Legacy Remote Autopilot Contract

Last updated: 2026-05-11

Status: legacy historical contract. This file records the remote-autopilot
correction slice that followed the first remote dogfood pass. It is no longer
the top-level product direction. The active direction is the CEO turn loop in
`../CEO_OFFICE_ROADMAP.md` and `../ARCHITECTURE.md`.

Use this document only as implementation background for the existing
report-only autopilot code path and Telegram compatibility behavior. Do not use
it to add more user-facing commands or to constrain natural CEO conversation.

## Principle

```text
Samantha owns progress.
BK owns judgment.
Policy owns authority.
```

Remote autopilot is not a larger Telegram command set. It is the rule that
Samantha should advance safe deterministic transitions after a remote intent
until it reaches one of three endpoints:

- result delivered
- exactly one BK judgment question
- local-only blocker

## First Success Criterion

A read-only planning, analysis, or report request should finish with one BK
input:

```text
/work <read-only planning/report request>
-> # autopilot-result
```

The result may include a report-only worker result, a plan-result style
synthesis, or one blocker question. It must not require BK to decide whether the
next command is `/plan`, `/go`, `/now`, or `/check`.

## State Contract

| State | Autopilot action | BK approval required | Stop condition |
| --- | --- | --- | --- |
| New remote intent | Save the orchestration request and classify scope. | No. | Stop if intake is rejected, duplicated, unsafe, or project selection is ambiguous. |
| Accepted read-only planning/report request | Run bounded orchestrator planning. | No, when authority policy allows report-only autopilot. | Stop if the plan asks questions, fails, has prerequisites/blockers, or proposes write work. |
| Report-only plan | Materialize only report-mode tasks and report-mode actions. | No, when authority policy allows report-only materialization. | Stop if materialization validation fails or any task is not report-only. |
| Report-only action | Execute report-only workers under read-only/non-writer dispatch policy. | No, when authority policy allows report-only execution. | Stop on failed verification, blocked worker result, queue pressure, or missing repo/profile prerequisites. |
| Write plan | Present compact plan and one BK decision. | Yes. | Stop before task/action materialization. |
| Merge, push, cleanup, recovery execution, connector, secret, budget, routine, profile, host operation | Do not autopilot. Route through existing gates. | Yes. | Stop with local or approval fallback. |

## Authority Boundary

Autopilot may proceed only because deterministic policy permits it. Memory never
grants authority by itself.

Allowed in the first slice:

- remote intake
- request classification
- read-only planning
- report-only task materialization
- report-only worker execution
- compact result reporting
- evidence recording

Denied in the first slice:

- write-mode task execution
- arbitrary shell input
- internal id navigation
- merge, push, cleanup, rollback, or recovery execution
- connector or secret access
- budget policy, routine, profile, SOP, skill, or host authority changes

## Memory And Delegation

Memory may record observations, preferences, and repeated BK judgments. It may
support a future delegation proposal, but it cannot grant runtime permission.

Authority expansion must follow this path:

```text
BK decisions -> decision memory -> pattern synthesis -> proposed authority grant
-> BK approval -> deterministic policy
```

An authority grant needs explicit scope, allowed actions, denied actions,
project/profile boundaries, limits, evidence, audit trail, and revocation path.

## Evidence

Every autopilot attempt should leave evidence that can later support or reject a
delegation proposal:

- request id
- plan id when planning ran
- authority grant id
- requested project and scope
- automatic transitions attempted
- endpoint: result, BK judgment, or local-only blocker
- action ids and run ids when report-only workers ran
- failure or blocked reason
- whether BK later revised, canceled, or corrected the result when known

Evidence is not an authority grant. It is input for a future proposal.
