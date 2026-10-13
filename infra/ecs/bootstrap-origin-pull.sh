#!/usr/bin/env bash
set -euo pipefail

# Issues the Authenticated Origin Pulls material: a private CA the ALB trusts
# (committed, public) and a Cloudflare client certificate signed by it (kept in
# Secrets Manager for upload to Cloudflare). The CA key is discarded: --rotate
# reissues both and appends the new CA to the bundle, so the ALB trusts old and
# new client certificates until Cloudflare switches; then drop the old CA.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CARTRIDGE_REPOSITORY_ROOT:?}"

ROTATE=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --profile)
      test -n "${2:-}"
      export AWS_PROFILE="$2"
      shift 2
      ;;
    --rotate)
      ROTATE=true
      shift
      ;;
    *)
      echo 'usage: bootstrap-origin-pull.sh [--profile AWS_PROFILE] [--rotate]' >&2
      exit 2
      ;;
  esac
done

read -r AWS_REGION CA_PATH SECRET_NAME PREVIEW_URL ORGANIZATION < <(node -e '
  const identity = require(process.argv[1]);
  process.stdout.write([
    identity.aws.region,
    identity.aws.ecs.originPullCaCertificate,
    identity.aws.ecs.originPullClientSecretName,
    identity.domains.chatServicePreview,
    identity.aws.ecs.originPullOrganization,
  ].join(" ") + "\n");
' "${CARTRIDGE_DEPLOY_ROOT:?}/identity.json")
export AWS_REGION

if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  SECRET_EXISTS=true
else
  SECRET_EXISTS=false
fi
if [[ "$SECRET_EXISTS" == true && "$ROTATE" != true ]]; then
  echo "$SECRET_NAME already exists; pass --rotate to issue new material" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

openssl req -x509 -newkey rsa:4096 -sha256 -days 1826 -nodes \
  -subj "/O=$ORGANIZATION/CN=$ORGANIZATION Cloudflare Origin Pull CA" \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null
openssl req -new -newkey rsa:2048 -sha256 -nodes \
  -subj "/O=$ORGANIZATION/CN=${PREVIEW_URL#https://}" \
  -keyout "$WORK/client.key" -out "$WORK/client.csr" 2>/dev/null
printf '%s\n' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=clientAuth' > "$WORK/client.ext"
openssl x509 -req -sha256 -days 730 \
  -in "$WORK/client.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
  -CAcreateserial -extfile "$WORK/client.ext" -out "$WORK/client.crt" 2>/dev/null
openssl verify -CAfile "$WORK/ca.crt" "$WORK/client.crt" >/dev/null

node -e '
  const fs = require("fs");
  const [cert, key, out] = process.argv.slice(1);
  fs.writeFileSync(out, JSON.stringify({
    certificate: fs.readFileSync(cert, "utf8"),
    privateKey: fs.readFileSync(key, "utf8"),
  }));
' "$WORK/client.crt" "$WORK/client.key" "$WORK/secret.json"

if [[ "$SECRET_EXISTS" == true ]]; then
  aws secretsmanager put-secret-value \
    --secret-id "$SECRET_NAME" \
    --secret-string "file://$WORK/secret.json" \
    >/dev/null
else
  aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --description 'Cloudflare Authenticated Origin Pulls client certificate for the Chat Service ALB' \
    --secret-string "file://$WORK/secret.json" \
    >/dev/null
fi
if [[ "$ROTATE" == true && -f "$REPO_ROOT/$CA_PATH" ]]; then
  cat "$WORK/ca.crt" >> "$REPO_ROOT/$CA_PATH"
else
  cp "$WORK/ca.crt" "$REPO_ROOT/$CA_PATH"
fi

printf 'Stored the Cloudflare client certificate in %s\n' "$SECRET_NAME"
printf 'Wrote the ALB trust-store CA to %s; commit it.\n' "$CA_PATH"
