# Samantha Workflow Playbook

Last updated: 2026-05-11

Status: living user guide.

## 목적

이 문서는 Samantha를 24/7 개인 운영 control plane으로 사용할 때의
실제 사용법과 운영 절차를 한 곳에 모은 playbook이다.

사용자는 이 문서를 통해 Samantha가 무엇을 하는 시스템인지, 어디까지가 안전한
사용 범위인지, 어떤 명령이 정상 workflow인지 확인하고 운영할 수 있어야 한다.

이 문서는 architecture나 phase 문서를 대체하지 않는다. 대신 "지금 Samantha로
무엇을 해야 하지?"에 답하는 첫 진입점이다.

## 핵심 모델

Samantha는 상주 LLM 대화방도 아니고 Telegram-first bot도 아니다. Samantha는
deterministic CEO office다.

- 사용자는 방향을 정하고, 모호하거나 위험한 결정을 승인하고, 우선순위를 바꾼다.
- deterministic TypeScript control plane은 durable state, queue, approval,
  dispatch, merge, push, cleanup, reporting, recovery, backup, audit record를
  소유한다.
- bounded Codex agent는 planning, synthesis, review, research, operations,
  content, evaluation, coding을 제한된 범위에서 돕는다.
- agent는 제안하거나 명시된 scope 안에서 실행할 뿐, Samantha gate를 우회하지
  않는다.

## 운영 표면

상황에 맞는 가장 작은 surface를 쓴다.

| Surface | 쓰는 경우 | 쓰지 않는 경우 |
| --- | --- | --- |
| Telegram | compact status, 새 work intake, plan approval, 짧은 feedback, recovery 시작 | shell command, 임의 repo path, 내부 id, 긴 debugging |
| CLI | 정밀 inspection, diagnostics, local recovery, integration gate, backup/restore validation | 모바일 quick status |
| Dashboard | queue, run, blocker, next action의 read-only long review | write action이나 approval |
| State files | CLI/dashboard로 부족한 audit/debug evidence 확인 | 일상 운영 |

모르겠으면 로컬에서는 이것부터 본다.

```bash
bun run samantha ceo:status
```

원격에서는 이것부터 본다.

```text
/now
```

## Telegram 명령어 빠른 참조

Telegram은 운영 보고, 새 work 접수, 계획 승인, 짧은 feedback, recovery 시작만
다룬다. Shell command, 임의 repo path, 내부 task/action/run/decision id는 받지
않는다.

| 명령어 | 수행 작업 |
| --- | --- |
| `/help`, `/start` | 기본 Telegram workflow와 안전 경계를 보여준다. |
| `/now` | 현재 상태에서 다음으로 보낼 안전한 Telegram 명령이나 필요한 local action을 제안한다. |
| `/work <요청>` | 새 작업 요청을 orchestration request로 저장한다. Worker를 바로 실행하지 않는다. |
| `/plan [project_id] [scope_id]` | pending request에 대해 read-only Orchestrator Agent planning을 실행하고 plan을 저장한다. |
| `/plan_current [project:<id>]` | 현재 미승인 plan을 Codex 재실행 없이 다시 보여준다. |
| `/approve [project:<id>]` | 현재 plan approval decision 하나만 승인한다. 일반 실행은 보통 `/go`를 쓴다. |
| `/answer [project:<id>] <답변>` | 현재 blocker clarification 하나에 답변을 기록하고 plan은 유지한다. |
| `/go [project:<id>]` | valid plan을 materialize해 task/action을 만들거나, 최신 성공 run의 integration gate를 전진시킨다. |
| `/revise [project:<id>] <피드백>` | 현재 미승인 plan을 supersede하고 feedback을 반영한 새 planning request를 만든다. |
| `/cancel [project:<id>] [reason]` | 현재 pending request 또는 미승인 plan을 취소한다. 이미 실행 중인 worker를 멈추지는 않는다. |
| `/recover [project:<id>]` | 최신 실패한 materialized plan result를 근거로 recovery request를 만든다. Retry나 dispatch는 하지 않는다. |
| `/check` | compact status view를 보여준다. |
| `/problems` | host, daemon, queue, Telegram poll/reply 등 운영 이상 징후를 진단한다. |

`project:<id>`는 여러 프로젝트에 현재 항목이 있어 명령이 모호할 때만 붙인다.
낡은 proposal/draft/task/action/run id 기반 Telegram 명령은 실행되지 않고 현재
workflow의 대체 명령만 안내한다.

## 일일 운영 루프

### 1. 현재 상태 확인

로컬:

```bash
bun run samantha ceo:status
bun run samantha next-action
bun run samantha doctor --local-only
```

원격:

```text
/now
/check
/problems
```

출력은 이 순서로 판단한다.

1. 사용자 결정이 필요한가
2. host나 daemon이 unsafe 상태인가
3. 실패하거나 blocked 된 work가 있는가
4. pending integration gate가 있는가
5. pending plan, task, action이 있는가
6. idle 또는 routine 상태인가

Samantha가 decision이 필요하다고 하면 먼저 결정한다. 그 상태에서 새 work를
더 넣으면 queue pressure만 커진다.

### 2. 새 work 넣기

정상 원격 workflow:

```text
/work <request>
/plan
/go
```

각 단계의 의미:

1. `/work`는 bounded orchestration request를 기록한다.
2. `/plan`은 `codex-orchestrator` planning path를 실행하고 structured plan을
   저장한다.
3. `/go`는 현재 valid plan을 승인하고 materialize하거나, 이후 passed run의
   integration gate를 전진시킨다.

현재 미승인 plan을 다시 보고 싶으면:

```text
/plan_current
```

plan은 틀렸지만 work 자체는 유지할 때:

```text
/revise <feedback>
```

request나 plan을 중단할 때:

```text
/cancel [reason]
```

Samantha가 blocker clarification 하나를 물었고 plan은 유지해야 할 때:

```text
/answer <answer>
```

### 3. 승인된 work 실행

활성 automation host에서 approved remote action은 이것이 실행한다.

```bash
bun run samantha actions:watch
```

1회성 fallback:

```bash
bun run samantha actions:run-pending --limit=1
```

직접 local dispatch는 사용자가 정밀하게 확인하거나 통제된 local work를 수행할 때
쓴다.

```bash
bun run samantha tasks:dispatch <task-id> --repo-root=<repo>
bun run samantha tasks:dispatch <task-id> --repo-root=<repo> --execute
bun run samantha tasks:dispatch <task-id> --repo-root=<repo> --execute --live-log
```

`--execute`가 없으면 dispatch는 worker command를 준비하고 출력만 한다.

`--execute`가 있으면 Samantha가 setup command, Codex 실행, `HARNESS_RESULT`
평가, verification command, run log 작성, task state update까지 수행한다.

`--live-log`는 dashboard와 사후 inspection을 위한 live JSONL stream을 남긴다.
Server hosting 운영에서 tmux는 필수 경로가 아니다.

### 4. 통과한 work 통합

writer run이 pass한 뒤에도 integration은 명시적 gate로 남는다.

```bash
bun run samantha merge:check --run-log=<run-log.json> --repo-root=<repo>
bun run samantha merge:apply --run-log=<run-log.json> --repo-root=<repo>
bun run samantha merge:push --run-log=<run-log.json> --repo-root=<repo>
bun run samantha worktree:cleanup --run-log=<run-log.json> --repo-root=<repo>
```

순서를 건너뛰지 않는다. Cleanup은 worker commit이 merge되고 push된 뒤에만 한다.

Telegram `/go`도 저장된 run metadata가 충분하면 최신 safe integration gate를
전진시킬 수 있다. `/go`가 거부하면 Samantha가 추천하는 local CLI report를 본다.

### 5. 결과 검토

```bash
bun run samantha runs:list
bun run samantha runs:show <run-id>
bun run samantha review:show <id>
bun run samantha dashboard:build
```

Dashboard는 read-only다. 긴 review에는 적합하지만 state를 직접 고치는 표면이
아니다.

## Active Host 규칙

동시에 정확히 하나의 machine만 Samantha automation host다.

Active host에서만 실행할 수 있는 것:

- `inbox:watch`
- `actions:watch`
- `telegram:poll`
- `telegram:reply`
- `ceo:notify`
- `dashboard:serve`
- worker dispatch
- host verification
- merge, push, cleanup, recovery, backup, restore, migration validation

Client machine은 repo code 수정, portable test, commit, push는 할 수 있다.
하지만 host-owned Samantha runtime loop나 worker dispatch를 실행하면 안 된다.

host-local environment와 state가 준비된 뒤 active host를 claim한다.

```bash
bun run samantha host:claim --host-id=<host-id>
```

비활성 후보 machine은 client로 표시한다.

```bash
bun run samantha host:client --host-id=<host-id>
```

host safety 확인:

```bash
bun run samantha doctor
bun run samantha health:check
```

`doctor`가 `client`, `stale`, `unknown`, `unsafe_to_continue`를 보고하면 그
machine에서 automation을 돌리지 않는다. 먼저 ownership이나 runtime 문제를
해결한다.

## 24/7 운영 시작

manual active-host baseline:

```bash
bun run samantha doctor
bun run samantha inbox:watch
```

approved action 실행이 필요하면 다른 host-owned process에서:

```bash
SAMANTHA_REPO_ROOT=$HOME/projects/samantha-codex bun run samantha actions:watch
```

선택적 host-owned loop:

```bash
bun run samantha telegram:poll
bun run samantha telegram:reply
bun run samantha ceo:notify
bun run samantha dashboard:serve
```

장기 운영은 Linux/WSL에서는 `ops/systemd/`, macOS에서는 `ops/launchd/`
template을 사용한다. 새 host service를 켜기 전에 반드시 old host service를
먼저 멈춘다.

## Verification profile

machine과 change type에 맞는 profile만 쓴다.

| 상황 | 명령 |
| --- | --- |
| client-side docs/code edit | `bun typecheck`, `bun run test:portable`, `bun run verify:docs` |
| 일반 Mac-side verification | `bun run verify:mac` |
| active-host runtime change | `bun run test:host`, `bun run test:all`, `bun run verify:host` |
| docs-only change | `bun run verify:docs` |

Client machine에서는 `test:host`, `verify:host`, daemon loop, dashboard runtime,
worker dispatch, merge, push, cleanup을 실행하지 않는다.

## 기억해야 할 safety gate

Samantha는 다음을 모두 만족한 writer output만 받는다.

1. worker output에 `HARNESS_RESULT: {...}`가 있다
2. result status가 `pass`다
3. changed file이 `forbiddenChanges`를 피한다
4. changed file이 `targetFiles` 안에 있다
5. 모든 `verifyCommand`가 exit code `0`이다
6. gate 통과 후 Samantha가 writer commit을 만든다

Production writer는 per-task worktree를 쓴다. Writer agent는 commit하거나
push하지 않는다. Non-writer agent는 report-only다. Writer concurrency는
dogfood evidence와 명시 approval 전까지 하나다.

Remote adapter는 shell command, 임의 repo path, 내부 task/action/run/decision id,
merge path, push path, cleanup path, connector grant, secret grant, routine grant,
budget authority를 받을 수 없다.

Routine trigger는 intake-only다. Budget gate는 deterministic local policy다.
Memory, SOP, skill은 context와 methodology일 뿐이다. 이것들은 safety, approval,
dispatch, worktree, merge, push, cleanup, recovery, project, connector, secret,
routine, budget gate를 override할 수 없다.

## Recovery playbook

실패가 나면 무작정 retry하지 않는다.

먼저 본다.

```bash
bun run samantha runs:show <run-id>
bun run samantha review:show <id>
bun run samantha drills:list
```

materialized plan이 실패했다면 정상 recovery loop를 쓴다.

```text
/recover
/plan
/go
```

Recovery request는 failed-plan evidence와 canonical project profile root를
사용한다. Old worker worktree는 evidence일 뿐 recovery root가 아니다.

standalone local worker failure일 때:

```bash
bun run samantha tasks:retry <task-id>
bun run samantha tasks:finalize-worktree <task-id> --repo-root=<repo> --worktree=<worker-worktree>
```

이 명령은 실패 원인을 이해한 뒤에만 쓴다. Merge, push, cleanup이 blocked면
그 gate를 visible하게 둔 채 정상 approval과 verification을 거치는 corrective
work를 만든다.

drill 확인과 기록:

```bash
bun run samantha drills:show <drill-id>
bun run samantha drills:record <drill-id> --outcome=<fixed|still_blocked|needs_bk> --note=<summary>
```

## Backup, restore, migration

deterministic backup manifest 생성:

```bash
bun run samantha backup:manifest --out=backup-manifest.json --generated-at=<iso timestamp>
```

restore된 state를 active로 보기 전에 validate:

```bash
bun run samantha restore:validate --manifest=backup-manifest.json --current-host-id=<host-id>
```

host handoff evidence validate:

```bash
bun run samantha migration:validate \
  --old-host-ownership=<old-host-ownership.json> \
  --new-host-ownership=<new-host-ownership.json> \
  --target-host-id=<host-id>
```

Restore와 migration validation은 read-only다. Service 시작/중지, host 활성화,
worker dispatch, approval, merge, push, cleanup, recovery, history rewrite를 하지
않는다.

host migration 순서:

1. old host Samantha service를 멈춘다.
2. old host가 inbox, action, Telegram, reply, dashboard runtime, worker dispatch를
   더 이상 처리하지 않는지 확인한다.
3. backup/state evidence를 만들거나 복사한다.
4. old host를 client로 표시하거나 expired ownership record를 보존한다.
5. new host에 state를 restore한다.
6. new host를 claim한다.
7. restore와 migration validation을 실행한다.
8. validation이 통과한 뒤에만 new host service를 켠다.

Active-active Samantha host는 절대 운영하지 않는다.

## 처음 설정할 때

최소 local orientation:

```bash
bun install
bun run verify:docs
bun run samantha
```

Telegram 운영은 host-local이고 commit되지 않는 env 값이 필요하다. 예시는
`.env.example`을 본다. Bot token, allowed sender 또는 chat id, host id, Codex
command path, project repo-root override가 대표적이다.

사용자가 실제 work를 dispatch하기 전에는 project profile을 자기 환경에 맞게
고쳐야 한다.

- stable project id를 정한다.
- repo root는 environment 기반 resolution을 쓴다.
- source-controlled docs와 profile에 local absolute path를 넣지 않는다.
- `writerCap`은 하나에서 시작한다.
- Telegram은 compact approval/status surface로만 쓰고 shell access로 쓰지 않는다.

## Samantha를 확장할 때

새 capability를 추가하기 전에 이 질문에 답한다.

1. 어떤 deterministic record가 state를 소유하는가
2. 어떤 approval 또는 safety gate가 unsafe use를 막는가
3. 어떤 command가 next safe action을 보고하는가
4. 어떤 verification profile이 변경을 증명하는가
5. worker, connector, secret, routine, budget, merge, push, cleanup, recovery,
   host authority를 확장하는가

Authority가 확장된다면 dogfood 전에 governance, test, docs를 먼저 추가한다.
표시나 wording 개선뿐이라면 operating surface에 좁게 유지하고 새 state를
만들지 않는다.

## Source documents

이 playbook이 얕을 때 읽을 문서:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [NORTH_STAR.md](NORTH_STAR.md)
- [REMOTE_ADAPTERS.md](REMOTE_ADAPTERS.md)
- [DAEMON_OPERATIONS.md](DAEMON_OPERATIONS.md)
- [LOCAL_AND_SSH_HOST_CANDIDATES.md](LOCAL_AND_SSH_HOST_CANDIDATES.md)
- [ROLLBACK_AND_RECOVERY_DRILLS.md](ROLLBACK_AND_RECOVERY_DRILLS.md)
- [CONTINUOUS_24_7_OPERATIONS.md](CONTINUOUS_24_7_OPERATIONS.md)
