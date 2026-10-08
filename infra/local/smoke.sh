#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
chat_url="${BOTCUBE_LOCAL_CHAT_URL:-http://localhost:${BOTCUBE_LOCAL_CHAT_PORT:-8123}}"
ui_url="${BOTCUBE_LOCAL_UI_URL:-http://localhost:${BOTCUBE_LOCAL_UI_PORT:-3001}}"
cookie_jar=$(mktemp)
trap 'rm -f "$cookie_jar"' EXIT
curl() { command curl --cookie "$cookie_jar" --cookie-jar "$cookie_jar" "$@"; }
thread_id="smoke-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
wait_for_chat() {
  for _ in {1..60}; do
    if curl --fail --silent --max-time 2 "$chat_url/health" >/dev/null; then
      return
    fi
    sleep 1
  done
  echo 'Chat Service did not become ready' >&2
  return 1
}
wait_for_chat
for host in localhost 127.0.0.1; do
  origin="http://$host:${BOTCUBE_LOCAL_UI_PORT:-3001}"
  headers=$(curl --fail --silent --show-error --dump-header - --output /dev/null \
    -X OPTIONS -H "Origin: $origin" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' "$chat_url/threads" | tr -d '\r')
  grep -Fxiq "access-control-allow-origin: $origin" <<<"$headers"
  grep -Fxiq 'access-control-allow-credentials: true' <<<"$headers"
done
headers=$(curl --silent --show-error --dump-header - --output /dev/null \
  -X OPTIONS -H 'Origin: https://unknown.example' \
  -H 'Access-Control-Request-Method: POST' "$chat_url/threads")
if grep -qi '^access-control-allow-origin:' <<<"$headers"; then
  echo 'Chat Service allowed an unknown browser origin' >&2
  exit 1
fi
curl --fail --silent --show-error "$chat_url/account/session" >/dev/null
payload="{\"threadId\":\"$thread_id\",\"runId\":\"smoke-run\",\"state\":{},\"messages\":[{\"id\":\"smoke-message\",\"role\":\"user\",\"content\":\"hello cube\"}],\"tools\":[],\"context\":[],\"forwardedProps\":{}}"
response=$(curl --fail --silent --show-error --no-buffer \
  -H 'content-type: application/json' --data "$payload" "$chat_url/")
grep -Fq 'Echo: hello cube' <<<"$response"

compose_files=(-f "$script_dir/compose.yml")
if [[ "${BOTCUBE_PRODUCTION_ARTIFACTS:-0}" == 1 ]]; then
  compose_files+=(-f "$script_dir/compose.production.yml")
fi
docker compose "${compose_files[@]}" restart harness
wait_for_chat
curl --fail --silent --show-error "$chat_url/threads" | \
  python3 -c 'import json,sys; t=next(t for t in json.load(sys.stdin)["threads"] if t["id"]==sys.argv[1]); assert t["title"]=="hello cube"' "$thread_id"
curl --fail --silent --show-error "$chat_url/threads/$thread_id" | \
  python3 -c 'import json,sys; assert [m["content"] for m in json.load(sys.stdin)["messages"]]==["hello cube", "Echo: hello cube"]'
curl --fail --silent --show-error -X DELETE "$chat_url/threads/$thread_id"
curl --fail --silent --show-error "$chat_url/threads" | \
  python3 -c 'import json,sys; assert all(t["id"]!=sys.argv[1] for t in json.load(sys.stdin)["threads"])' "$thread_id"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "$chat_url/threads/$thread_id")" = 404

status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -H 'content-type: application/json' --data '{}' "$chat_url/")
test "$status" = 422

for _ in {1..60}; do
  if page=$(curl --fail --silent --show-error --max-time 15 "$ui_url/" 2>/dev/null); then
    grep -Fq 'BotCube' <<<"$page"
    if [[ "${BOTCUBE_PRODUCTION_ARTIFACTS:-0}" == 1 ]]; then
      test "$(curl --silent --output /dev/null --write-out '%{http_code}' "$ui_url/browser-view")" = 200
      test "$(curl --silent --output /dev/null --write-out '%{http_code}' "$ui_url/nonexistent")" = 404
    fi
    echo 'Local Session smoke passed'
    exit 0
  fi
  sleep 1
done

echo 'UI did not become ready' >&2
exit 1
