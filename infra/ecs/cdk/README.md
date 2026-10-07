# Chat storage

`pnpm install && pnpm run build && pnpm test --runInBand` verifies the
`ChatStorage` stack. `pnpm run cdk synth -c parked=false` synthesizes it without
deployment. Every synth needs `-c parked=true|false`; deploys read it from the
stored park state (`docs/runbooks/production-parking.md`).
The `chat` table uses on-demand billing, point-in-time recovery, deletion
protection and retention on removal, with no TTL. It holds Session Metadata, whose
`pk` is the owner index; see the Chat Service README.

The preview-origin workflow consumes this stack from ECS by
granting the Chat Service task role table access and setting
`BOTCUBE_CHAT_TABLE`. See `docs/runbooks/preview-origin.md` for deployment and
verification. Account storage shares this table with
separate key prefixes; the Credential Service Vault uses its own table.
