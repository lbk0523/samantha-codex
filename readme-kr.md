# samantha-codex

Codex 전용 Samantha control plane 프로토타입입니다.

English version: [README.md](README.md)

Samantha-Codex는 BK가 하나의 orchestrator surface와 대화하면, orchestrator가 요청을 명시적인 계획으로 만들고, 결정적인 TypeScript control plane이 safety, dispatch, verification, integration, reporting gate를 실행하는 개인 운영 레이어입니다.

이 저장소는 범용 multi-agent framework가 아닙니다. 안전한 Codex 기반 작업을 위한 최소한의 유용한 control plane이 현재 목표입니다.

## 현재 구조

```text
BK
  <-> Telegram / local operator CLI
Samantha Orchestrator Agent
  - 목표, 범위, 위험, 다음 행동을 논의
  - 승인 가능한 작업 계획을 제안
  - 최종 결과를 종합 보고
Samantha Control Plane
  - request, plan, task, action, run, audit log 저장
  - dispatch 전에 safety policy 검증
  - 승인된 Codex CLI agent dispatch
  - worker output과 verification command 평가
  - merge, push, cleanup, reporting gate 실행
Codex Agents
  - codex-worker     writer
  - codex-reviewer   non-writer
  - codex-evaluator  non-writer
  - codex-orchestrator planner/synthesizer
```

Orchestrator는 작업을 제안합니다. Control plane은 실행과 안전을 소유합니다. Agent는 control-plane gate를 우회하지 않습니다.

## 작업 환경 경계

- Ubuntu/WSL은 Samantha automation host입니다.
- Mac은 개발/클라이언트 머신입니다.
- Mac에서는 일반 repo code 수정, 테스트, 커밋, 푸시를 할 수 있습니다.
- Mac에서 Samantha daemon, watch, poll, reply, worker dispatch, dashboard runtime process를 실행하지 않습니다.
- Runtime state는 automation host 소유입니다: `state/`, `runs/`, `.samantha-worktrees/`, dashboard runtime output, outbox/archive data, live log.
- Repo code와 docs에는 로컬 절대경로를 하드코딩하지 않습니다. repo-relative path, project id, environment variable, project profile resolution을 우선합니다.

## 지원되는 원격 흐름

Telegram command surface는 의도적으로 작게 유지합니다. 일반적인 원격 작업 흐름은 다음과 같습니다.

```text
/work <request>
/plan
/go
```

자주 쓰는 후속 명령:

- `/plan_current`는 Codex를 다시 실행하지 않고 현재 미승인 계획을 보여줍니다.
- `/revise <feedback>`은 현재 계획 요청을 피드백이 반영된 새 컨텍스트로 교체합니다.
- `/cancel [reason]`은 pending request 또는 미승인 plan을 폐기합니다.
- `/go`는 유효한 plan을 승인하고, 이후 통과한 작업을 merge, push, cleanup gate로 전진시킵니다.
- `/recover`는 실패한 materialized plan result 이후 recovery-oriented request를 만듭니다.
- `/now`, `/check`, `/problems`는 현재 운영 상태를 보고합니다.

Telegram input은 shell command, 임의 repo path, merge/push/cleanup path, 내부 task/action/run id를 제공할 수 없습니다.

## 로컬 명령

Repository root에서 Bun을 사용합니다.

```bash
bun typecheck
bun run test
bun run test:portable
bun run verify:docs
bun run verify:mac
bun run test:host
bun run verify:host
bun run validate-fixture
bun run dispatch-worker --task=references/tasks/fixture-single-writer.json --agent=references/agent-profiles/codex-worker.json --repo-root=.
bun run samantha runs:list
```

검증 profile:

- `bun run test`는 `bun run test:portable`과 같습니다.
- `bun run test:portable`은 Mac에서 안전하게 실행할 수 있는 unit/contract test를 실행합니다.
- `bun run test:host`는 Ubuntu/Samantha host runtime behavior에 의존하는 테스트를 실행합니다.
- `bun run test:all`은 portable test와 host test를 모두 실행합니다.
- `bun run verify:docs`는 README cross-link와 로컬 절대경로 안전성을 확인합니다.
- `bun run verify:mac`은 일반적인 Mac-side verification bundle입니다.
- `bun run verify:host`는 automation-host verification bundle입니다.

Local operator CLI는 다음 entrypoint를 사용합니다.

```bash
bun run samantha <command>
```

주요 command group:

- `runs:*`는 run log와 compact run index를 읽습니다.
- `tasks:*`는 file-backed task ledger를 관리합니다.
- `plan:run`은 non-writer batching과 writer serialization을 적용해 local multi-task plan을 실행합니다.
- `actions:*`는 승인된 remote dispatch action을 기록하고 실행합니다.
- `merge:check`, `merge:apply`, `merge:push`는 integration을 명시적인 gate로 나눕니다.
- `worktree:cleanup`은 통합이 끝난 worker worktree를 제거합니다.
- `inbox:*`, `remote:enqueue`, `telegram:poll`은 제한된 remote input을 local inbox record로 변환합니다.
- `health:check`는 daemon heartbeat와 lock health를 보고합니다.
- `dashboard:build`는 read-only dashboard HTML을 작성합니다.
- `dashboard:serve`는 automation host에서 read-only dashboard를 제공합니다.

## Worker Dispatch

실제 worktree를 만들지 않고 worker dispatch를 dry-run합니다.

```bash
bun run dispatch-worker \
  --task=references/tasks/fixture-single-writer.json \
  --agent=references/agent-profiles/codex-worker.json \
  --repo-root=.
```

Automation host가 task worktree를 만들어야 할 때만 `--allocate`를 추가합니다.

`--execute`를 추가하면 setup command 실행, 준비된 `codex exec` command 실행, `HARNESS_RESULT` 평가, verification command 실행, audit log 작성까지 수행합니다.

```bash
bun run dispatch-worker \
  --task=references/tasks/fixture-single-writer.json \
  --agent=references/agent-profiles/codex-worker.json \
  --repo-root=. \
  --execute
```

실행된 run은 기본적으로 `runs/`에 audit JSON file을 씁니다. 다른 audit 위치는 `--log-dir=<path>`, 일회성 실행에서 log를 남기지 않으려면 `--no-log`를 사용합니다.

## Safety Model

Samantha는 모든 gate가 통과한 writer output만 수락합니다.

- worker output에 `HARNESS_RESULT: {...}`가 포함되어야 합니다.
- `status`가 `pass`여야 합니다.
- 변경 파일이 `forbiddenChanges`를 피해야 합니다.
- 변경 파일이 `targetFiles` 안에 있어야 합니다.
- 모든 `verifyCommand`가 exit code `0`으로 끝나야 합니다.
- gate 통과 후 Samantha가 writer commit을 생성합니다.

Writer agent는 commit하거나 push하지 않습니다. Production code writer는 per-task worktree를 사용합니다. Non-writer agent는 병렬 실행될 수 있고, writer concurrency는 dogfood evidence가 쌓이기 전까지 하나로 시작합니다.

## Project Layout

- `src/samantha.ts`는 local operator CLI entrypoint입니다.
- `src/dispatch-worker.ts`는 worker dispatch를 준비하고 선택적으로 실행합니다.
- `src/lib/`는 control-plane store, gate, adapter, dispatch, dashboard, orchestration helper를 포함합니다.
- `tests/`는 control-plane contract와 operation을 검증합니다.
- `references/agent-profiles/`는 Codex agent contract를 정의합니다.
- `references/tasks/`와 `references/plans/`는 fixture와 canary를 포함합니다.
- `references/project-profiles/`는 canonical project profile hint를 포함합니다.
- `docs/`는 architecture, operations, remote adapter, dashboard, dogfood, next-plan 문서를 포함합니다.
- `ops/systemd/`는 automation-host service와 timer template을 포함합니다.

## Design Notes

자세한 맥락은 다음 문서를 참고합니다.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/NEXT_PLAN.md](docs/NEXT_PLAN.md)
- [docs/DAEMON_OPERATIONS.md](docs/DAEMON_OPERATIONS.md)
- [docs/REMOTE_ADAPTERS.md](docs/REMOTE_ADAPTERS.md)
- [docs/DASHBOARD_DOGFOOD.md](docs/DASHBOARD_DOGFOOD.md)
- [docs/DOGFOOD_SCENARIOS.md](docs/DOGFOOD_SCENARIOS.md)
- [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)
