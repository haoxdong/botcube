#!/usr/bin/env bash
# BotCube's secret-free suite, run from the tree's root: the mirror's CI and a local check run exactly this.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
uv sync --frozen --quiet --directory templates/always-on
pnpm exec vitest run

for cdk in infra/agentcore/cdk infra/ecs/cdk; do
  pnpm --dir "$cdk" run build
  pnpm --dir "$cdk" test --runInBand
done

pytest_in() {
  local package=$1
  shift
  uv sync --frozen --quiet --directory "$package"
  uv run --frozen --directory "$package" pytest tests -q "$@"
}
pytest_in cartridge
pytest_in credential-service
# This test loads the private repository's scripts/check_prompt_caching.py, which the mirror does not carry.
pytest_in harness/deepagents -n 2 --ignore=tests/test_prompt_caching_check.py
pytest_in harness/deepagents/tools
pytest_in templates/always-on
pytest_in infra
uv run --frozen --directory infra python -m unittest discover -s ecs/origin-provider -p 'test_*.py'
