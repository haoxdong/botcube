#!/usr/bin/env bash
set -euo pipefail

DEPLOY_ROOT="${BOTCUBE_DEPLOY_ROOT:?BOTCUBE_DEPLOY_ROOT must point to the active deploy directory}"
CONFIG_ROOT="$DEPLOY_ROOT/.."

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

read -r AWS_REGION CA_BUCKET CA_KEY CA_VERSION SECRET_NAME PREVIEW_URL ORGANIZATION < <(node -e '
  const config = require(require("node:path").resolve(process.argv[1])).readDeployment(process.argv[2]);
  const names = require(require("node:path").resolve(process.argv[1])).deploymentNames(config);
  process.stdout.write([
    config.env.region,
    config.cloudflare.originPull.caCertificate.bucket,
    config.cloudflare.originPull.caCertificate.key,
    config.cloudflare.originPull.caCertificate.versionId ?? "-",
    names.originPullClientSecretName,
    config.domains.chatServicePreview,
    config.cloudflare.originPull.organization ?? config.name,
  ].join(" ") + "\n");
' "$(dirname "${BASH_SOURCE[0]}")/../../config/read.cjs" "$DEPLOY_ROOT")
export AWS_REGION

SECRET_EXISTS=false
aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1 && SECRET_EXISTS=true
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
if [[ "$ROTATE" == true ]]; then
  version=()
  if [[ "$CA_VERSION" != - ]]; then version+=(--version-id "$CA_VERSION"); fi
  aws s3api get-object --bucket "$CA_BUCKET" --key "$CA_KEY" "${version[@]}" "$WORK/bundle.pem" >/dev/null
  cat "$WORK/ca.crt" >> "$WORK/bundle.pem"
else
  cp "$WORK/ca.crt" "$WORK/bundle.pem"
fi
new_version=$(aws s3api put-object --bucket "$CA_BUCKET" --key "$CA_KEY" --body "$WORK/bundle.pem" --query VersionId --output text)
node -e '
  const fs = require("node:fs");
  const reader = require(require("node:path").resolve(process.argv[1]));
  const file = process.argv[2];
  const config = reader.readConfig(file);
  const ca = config.cloudflare.originPull.caCertificate;
  if (process.argv[3] === "None") delete ca.versionId;
  else ca.versionId = process.argv[3];
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' "$(dirname "${BASH_SOURCE[0]}")/../../config/read.cjs" "$CONFIG_ROOT/botcube.yaml" "$new_version"

printf 'Stored the Cloudflare client certificate in %s\n' "$SECRET_NAME"
printf 'Uploaded the CA bundle to s3://%s/%s and updated botcube.yaml; deploy its trust store before switching the client.\n' "$CA_BUCKET" "$CA_KEY"
