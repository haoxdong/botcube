#!/usr/bin/env bash
# Tool hook: stage the example bot (examples/bot) for the Harness build context (ADR 0091). AgentCore's CodeBuild builds
# one context with no named build contexts, so this copies the bot's files to .tool-dist/bot/ and writes
# .tool-dist/Dockerfile: the Harness Dockerfile, then examples/bot/Dockerfile with its COPYs read from there.
#   botcube/examples/public/deploy/stage-tools.sh
#   docker build -f botcube/harness/deepagents/.tool-dist/Dockerfile botcube/harness/deepagents
set -euo pipefail

cube_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)
bot="$cube_root/examples/bot"
destination="$cube_root/harness/deepagents/.tool-dist"

rm -rf "$destination"
mkdir -p "$destination/bot"
cp -R "$bot/bot.json" "$bot/skills" "$destination/bot/"
{
  cat "$cube_root/harness/deepagents/Dockerfile"
  sed -E 's#^COPY ([^ ]+) #COPY .tool-dist/bot/\1 #' "$bot/Dockerfile"
} > "$destination/Dockerfile"

echo "Staged the example bot in $destination"
