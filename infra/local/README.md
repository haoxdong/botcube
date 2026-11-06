# Local sandbox

Install Docker Compose, Node 24 with npm, and uv on the host. Startup stages
the template browser tools with npm, uv, and Node before building the images.

Run `./run.sh -d`, wait for the services, then run `./smoke.sh` and open
`http://localhost:3001`. No cloud or model-provider credentials are used.
See [Integrating BotCube](../../INTEGRATING.md) for the configuration reference.

Set `BOTCUBE_LOCAL_CHAT_PORT` and `BOTCUBE_LOCAL_UI_PORT` to change the host
ports. The UI uses the selected Chat port unless `NEXT_PUBLIC_CHAT_SERVICE_URL`
is set. Use the same variables for startup and smoke.

If your HTTPS proxy uses a private CA, set `BOTCUBE_BUILD_CA_CERTS` to a
readable combined CA bundle before startup. Host tool staging uses it through
`NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` in its subprocess. BuildKit mounts the
same bundle for image dependency downloads without putting it in the images.
TLS verification stays enabled. When unset, staging inherits the host trust
configuration.

The Harness persists each Session's checkpoints in `harness-state`, and the
session API replays Sessions from that same record; the Chat Service keeps Session Metadata
in DynamoDB Local's `dynamodb-state` volume. To exercise replacement, send a
turn, run `docker compose -f compose.yml kill harness`, bring the Harness back
with `docker compose -f compose.yml up -d harness`, and send the next turn with
the same `threadId`. The checked-in contract test automates this process-level
replacement and proves the first turn remains in the resumed snapshot.

The initializer creates the `chat` table before Chat Service starts. DynamoDB Local
is internal to Compose and uses dummy credentials. Re-running startup reuses the
table. The smoke test checks echo, replay, restart persistence, deletion and an
invalid request. Set `COMPOSE_PROJECT_NAME` consistently for startup and smoke.

The template Chat Service installs Chromium and starts each Session's Agent
Computer on the internal fake site. Its HTTP endpoint returns an owner-authorized
image of that browser. Its signed CDP handoff uses `chat-service:8123` so the
Harness can reach it inside Compose. Stopping the Chat Service sleeps its
computers and cancels any startup in progress. Local Take-over is unavailable.

The upgrade instructions below concern Harness checkpoints, which use SQLite.

## Upgrade an existing local stack

Before updating a checkout that already has checkpoints, inspect its running
Harness container with `docker inspect` and record the checkpoint volume's
actual name. Stop the old stack with its original Compose file (`down`, without
`--volumes`). Keep the same Compose project name so existing volumes stay
attached. A new volume key does not rename or migrate an existing Docker volume.

After updating, run `docker compose -f compose.yml create harness` to
create the new container and volume without starting a checkpoint writer. Use
`docker inspect` on that container to find the new checkpoint volume. Set
`SOURCE_VOLUME` and `DESTINATION_VOLUME` to those two inspected names; confirm
they differ and that the destination is empty. With both services stopped, copy
the entire directory, including SQLite sidecar files and metadata:

```bash
docker run --rm --entrypoint sh \
  --mount "type=volume,src=$SOURCE_VOLUME,dst=/source,readonly" \
  --mount "type=volume,src=$DESTINATION_VOLUME,dst=/destination" \
  python:3.13-slim -ec \
  'test -z "$(ls -A /destination)"; cp -a /source/. /destination/'
```

Compare the copied files and permissions before starting the stack, then send a
new turn on a saved `threadId` and verify that its earlier messages survive.
Keep the source volume for rollback until that check passes. New installations
with no existing volume need no migration. See the
[Docker volume backup and restore guide](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes).
