#!/bin/sh
# Every Storybook state at both viewports:
#   screenshots.sh -- <out-dir>   writes each state to <out-dir>
#   screenshots.sh --check        compares each state with its committed baseline
#   screenshots.sh --update       rewrites the baselines
set -eu
if [ "${1:-}" = '--' ]; then shift; fi
case "${1:-}" in
  --check | --update)
    mode=$1
    shift
    export STORYBOOK_SCREENSHOTS=compare
    if [ "$mode" = --update ]; then set -- "$@" --update; fi
    ;;
  *)
    STORYBOOK_SCREENSHOT_DIR=$(node -e 'process.stdout.write(require("node:path").resolve(process.env.INIT_CWD || process.cwd(), process.argv[1]))' "${1:-screenshots}")
    export STORYBOOK_SCREENSHOT_DIR
    if [ "$#" -gt 0 ]; then shift; fi
    ;;
esac
pnpm exec msw init .storybook/public --save
status=0
STORYBOOK_SCREEN=phone ../../../scripts/heavy.sh pnpm exec vitest run --config vitest.storybook.config.ts "$@" || status=1
STORYBOOK_SCREEN=desktop ../../../scripts/heavy.sh pnpm exec vitest run --config vitest.storybook.config.ts "$@" || status=1
exit "$status"
