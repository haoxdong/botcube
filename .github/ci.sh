#!/usr/bin/env bash
# BotCube's secret-free suite, run from the tree's root: the mirror's CI and a local check run exactly this.
set -euo pipefail
cd "$(dirname "$0")/.."

suite=${CI_SUITE:-all}
python_packages=(cartridge credential-service harness/deepagents harness/deepagents/tools templates/always-on infra)
case "$suite" in
  all|node|cdk|cartridge|credential-service|harness/deepagents|harness/deepagents/tools|templates/always-on|infra) ;;
  *) echo "Unknown CI_SUITE: $suite" >&2; exit 2 ;;
esac

pnpm install --frozen-lockfile

if [[ "$suite" == all || "$suite" == node ]]; then
  uv sync --frozen --quiet --directory templates/always-on
  pnpm run pretest:chat
  pnpm exec vitest run --maxWorkers=4
fi

if [[ "$suite" == all || "$suite" == cdk ]]; then
  for cdk in infra/agentcore/cdk infra/ecs/cdk; do
    pnpm --dir "$cdk" run build
    pnpm --dir "$cdk" test --runInBand
  done
fi

pytest_in() {
  local package=$1
  shift
  uv sync --frozen --quiet --directory "$package"
  uv run --frozen --directory "$package" pytest tests -q "$@"
}
for package in "${python_packages[@]}"; do
  if [[ "$suite" != all && "$suite" != "$package" ]]; then continue; fi
  pytest_args=()
  if [[ "$package" == harness/deepagents ]]; then
    pytest_args=(-n 4 --ignore=tests/test_prompt_caching_check.py)
  fi
  pytest_in "$package" "${pytest_args[@]}"
  if [[ "$package" == infra ]]; then
    uv run --frozen --directory infra python -m unittest discover -s ecs/origin-provider -p 'test_*.py'
  fi
done
