# Multi-Project Baseline Inventory

Last updated: 2026-05-10

This is the Phase 6 M1 inventory for current project identity behavior. It is
descriptive only: M1 does not change runtime behavior, schemas, remote command
behavior, or `writerCap`.

## Baseline Fixtures

- Project profiles:
  - `references/project-profiles/samantha.json`
  - `references/project-profiles/omht.json`
- Ambiguous request baseline:
  - `다음 작업 계획 보고`
  - Current result: no deterministic project profile is inferred when multiple
    profiles are configured and the request has no project keyword.
- Current-behavior test:
  - `tests/multi-project-baseline.test.ts`

## Inventory

| Record surface | Current project identity | Current gap | Follow-up owner |
| --- | --- | --- | --- |
| Project profiles | Direct identity via profile `id`; `repoRoot` is resolved at load time from profile path expressions or environment overrides. | Profiles are source of identity, but validation, uniqueness guarantees, tie handling, and identity-vs-runtime-root distinctions are still loose. | M2 |
| Orchestration requests | No `projectId`; request text may contain a project keyword; recovery requests may link `recoveryOfPlanId`. | Project is inferred from text, latest active context, profile defaults, or not known. No durable project or goal ancestry. | M2, M3, M4, M6 |
| Orchestrator plans | No plan-level `projectId`; task proposals may contain `projectId` and `repoRoot`; classification records intent only. | A plan can contain mixed, missing, or inferred proposal identity; no plan-level project/goal/work-item ancestry. | M3, M4 |
| Decisions | No `projectId`; subject links to a plan, task, action, run, profile, capability, or policy. | Decision queues cannot filter or disambiguate by project without traversing subject links and prose. | M3, M5, M6 |
| Tasks and task drafts | `TaskSpec`, `TaskDraftRecord`, and orchestrator task proposals have optional `projectId`; `repoRoot` is also optional until defaults/materialization. | Legacy and partially prepared records may have no `projectId`; `repoRoot` can act as identity in practice. | M3, M4, M7 |
| Remote actions | No `projectId`; stores `taskId`, `orchestratorPlanId`, `orchestratorTaskId`, and canonical `repoRoot`. | Action project is inferred from the task, plan proposal, or `repoRoot`; wrong-project remote approval risk remains when multiple current items exist. | M3, M5, M6 |
| Worker run logs | Nested `task` may contain optional `projectId`; `input.repoRoot` records execution root evidence. | Run log identity depends on nested task shape; execution roots are evidence, not durable project identity. | M3, M8 |
| Run summaries | No `projectId`; stores `taskId`, `repoRoot`, `worktreePath`, and `logPath`. | Project lookup requires joining through task/action/run log or inferring from `repoRoot`. | M3, M5, M8 |
| Run lifecycle records | No `projectId`; stores `runId`, `taskId`, `repoRoot`, and `runLogPath`. | Merge/push/cleanup lifecycle is not directly project-filterable. | M3, M5 |
| Recovery records | Recovery request links `recoveryOfPlanId`; recovery text includes canonical action repo roots and proposed task project ids when available. | Recovery context is prose-heavy; source and recovery project ancestry is not structured. | M3, M4, M5 |
| CEO reports and status | Report audit records store global counts only; status items do not carry project identity. | Cross-project and per-project reports cannot be reconstructed from report records alone. | M5, M9 |
| Operator review reports | Reconstructs request -> plan -> decision -> task -> action -> run through ids; displays gaps. | Project identity is not a first-class reconstruction axis and must be inferred from task/action/run fields. | M3, M5 |
| Governance events | Source/subject ids and related decision/action/run ids exist; no `projectId` or `goalId`. | Governance audit can reconstruct transitions, but not directly by project or goal. | M3, M5, M7 |
| Budget observations | `CostBudgetContext` already supports optional `projectId`, `goalId`, `planId`, `actionId`, `taskId`, `runId`, and `repoRoot`; run observations copy `task.projectId` when present. | Existing observations may have missing project/goal context; no rollup contract yet. | M3, M8 |

## Single-Project Assumptions

- Latest/current selection is global. `latestPending`, `latestActionable`,
  latest approval, latest blocker clarification, latest action, and integration
  next actions do not partition by project.
- Remote compact commands such as `/go`, `/approve`, `/answer`, `/revise`,
  `/cancel`, and `/recover` currently operate on global latest/current records
  unless a command path explicitly asks for a project id.
- Reports and dashboard/status surfaces aggregate global counts and choose one
  global next action.
- Materialized work normally belongs to one project by convention, but the
  current schema does not put that ancestry on every durable record.
- `repoRoot` is used as execution evidence and fallback identity in several
  flows, even though it is host-local after profile resolution.

## Compatibility Expectations

- Old records must continue to load without synthetic project assignment.
- Missing project identity must remain visible as `missing`, `legacy`, or
  `unassigned` in later views instead of being silently inferred.
- Resolved runtime paths must not become portable project identity.
- M2-M10 may add deterministic contracts and filters, but M1 establishes that
  current behavior is a single-project/global-latest baseline.

## Stage Handoff

- M2 owns profile validation, deterministic profile resolution, tie handling,
  and identity-vs-runtime-root separation.
- M3 owns the project -> goal -> work-item ancestry contract and legacy
  representation.
- M4 owns propagation through request intake, planning, materialization,
  synthesis, and recovery.
- M5 owns project-isolated queues, filters, reports, dashboard/status views,
  and visible legacy/unassigned buckets.
- M6 owns wrong-project guards and remote compact command disambiguation.
- M7 owns per-project safety policy overlays and governed authority changes.
- M8 owns project/goal budget observation rollups and missing-cost ancestry
  reporting.
- M9 owns ranked cross-project recommendations.
- M10 owns dogfood, migration review, and Phase 6 exit evidence.
