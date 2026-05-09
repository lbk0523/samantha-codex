#!/usr/bin/env bash
set -euo pipefail

repo_root="${SAMANTHA_HOME:-$HOME/projects/samantha-codex}"

cd "$repo_root"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

bun_bin="${SAMANTHA_BUN_BIN:-$HOME/.bun/bin/bun}"

exec "$bun_bin" run samantha "$@"
