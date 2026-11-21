# BotCube Config

An operator writes `botcube.yaml` in YAML 1.2. `botcube.schema.json` is the contract emitted from `schema.ts`. Unknown keys stop startup and name their path.

External services live under `integrations`, existing resources under `existing`, and proxy and CORS settings under `network`. The Bot Image carries its own settings at `/bot/bot.yaml`, against `bot.schema.json`.

Run `node botcube/config/cli.ts footprint botcube/examples/public/botcube.yaml` from the repository root to list resources, grants, images, and egress. Regenerate the schemas with `pnpm --filter botcube-config emit`.

[ADR 0091](../../docs/adr/0091-botcube-is-configured-not-extended.md) defines the boundary. [Integration](../INTEGRATING.md) covers images and deployment.
