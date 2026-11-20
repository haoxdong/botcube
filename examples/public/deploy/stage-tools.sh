#!/usr/bin/env bash
# Tool hook: stage the example bot (examples/bot) and the examples' Deployment Configs for the Harness build context
# (ADR 0091). AgentCore's CodeBuild builds one context with no named build contexts, so this copies the bot's files to
# .tool-dist/bot/ and writes .tool-dist/Dockerfile: the Harness Dockerfile, then examples/bot/Dockerfile with its COPYs
# read from there, then the configs' COPYs below, each staged from botcube/ at its .tool-dist/ path.
#   botcube/examples/public/deploy/stage-tools.sh
#   docker build -f botcube/harness/deepagents/.tool-dist/Dockerfile botcube/harness/deepagents
set -euo pipefail

cube_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)
bot="$cube_root/examples/bot"
context="$cube_root/harness/deepagents"
destination="$context/.tool-dist"
configs=$(cat <<'COPIES'
COPY .tool-dist/examples/enterprise/deployment-config.json /opt/botcube/examples/enterprise/deployment-config.json
COPY .tool-dist/examples/public/deployment-config.json /opt/botcube/examples/public/deployment-config.json
COPIES
)

rm -rf "$destination"
mkdir -p "$destination/bot"
cp -R "$bot/bot.json" "$bot/skills" "$destination/bot/"
while read -r _ source _; do
  mkdir -p "$(dirname "$context/$source")"
  cp "$cube_root/${source#.tool-dist/}" "$context/$source"
done <<< "$configs"
{
  cat "$cube_root/harness/deepagents/Dockerfile"
  sed -E 's#^COPY ([^ ]+) #COPY .tool-dist/bot/\1 #' "$bot/Dockerfile"
  echo "$configs"
} > "$destination/Dockerfile"

echo "Staged the example bot and the examples' Deployment Configs in $destination"
