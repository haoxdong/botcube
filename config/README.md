# BotCube Config

An operator writes `botcube.yaml` in YAML 1.2. `botcube.schema.json` is the contract emitted from `schema.ts`. Unknown keys stop startup and name their path.

A deployment is this one file plus the images it names. Its name, account and Region, and domains sit at the top level; outside services, the proxy among them, under `integrations`; the images and the resources BotCube creates under `services`, `agentCore`, `network` and `cloudflare`; and existing resources under `existing`. CORS allows `domains.web` and `domains.webAliases`. The Bot Image carries its own settings at `/bot/bot.yaml`, against `bot.schema.json`.

Run `node botcube/config/cli.ts footprint botcube/examples/public/botcube.yaml` from the repository root to list resources, grants, images, and egress. Regenerate the schemas with `pnpm --filter botcube-config emit`.

[ADR 0091](../../docs/adr/0091-botcube-is-configured-not-extended.md) defines the boundary. [Integration](../INTEGRATING.md) covers images and deployment.
