#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
compose_files=(-f "$script_dir/compose.yml")
if [[ -n "${BOTCUBE_BUILD_CA_CERTS:-}" ]]; then
  [[ -r "$BOTCUBE_BUILD_CA_CERTS" ]] || { echo "BOTCUBE_BUILD_CA_CERTS must name a readable CA bundle" >&2; exit 1; }
  compose_files+=(-f "$script_dir/compose.build-ca.yml")
  NODE_EXTRA_CA_CERTS="$BOTCUBE_BUILD_CA_CERTS" SSL_CERT_FILE="$BOTCUBE_BUILD_CA_CERTS" \
    bash "$script_dir/../../template/deploy/stage-tools.sh"
else
  bash "$script_dir/../../template/deploy/stage-tools.sh"
fi
docker compose "${compose_files[@]}" up --build "$@"
