#!/bin/sh
# Every story's play-function checks at both viewports:
#   stories.sh [vitest args]
#   stories.sh --screenshots <out-dir> [vitest args]   also writes each passing state to <out-dir>
set -eu
if [ "${1:-}" = '--screenshots' ]; then
  shift
  if [ "${1:-}" = '--' ]; then shift; fi
  STORYBOOK_SCREENSHOT_DIR=$(node -e 'process.stdout.write(require("node:path").resolve(process.env.INIT_CWD || process.cwd(), process.argv[1]))' "${1:-screenshots}")
  export STORYBOOK_SCREENSHOT_DIR
  if [ "$#" -gt 0 ]; then shift; fi
fi
if [ "${1:-}" = '--' ]; then shift; fi
../../scripts/heavy.sh pnpm exec msw init .storybook/public --save
status=0
STORYBOOK_SCREEN=phone ../../scripts/heavy.sh pnpm exec vitest run --config vitest.storybook.config.ts "$@" || status=1
STORYBOOK_SCREEN=desktop ../../scripts/heavy.sh pnpm exec vitest run --config vitest.storybook.config.ts "$@" || status=1
exit "$status"
