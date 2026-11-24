import type { z } from 'zod';
import type { configSections } from 'botcube-config';

/** Every Endpoint the BotCube Config reaches through its proxy, by its path. */
export function proxiedFields({ integrations: { signIn: identity, modelGateway: models, telemetry, relayProviders: providers }, network }: z.output<typeof configSections>): string[][] {
  return [
    ...(network.openEgress?.proxy ? [['network', 'openEgress', 'proxy']] : []),
    ...(identity.kind === 'oidc' && identity.proxy ? [['integrations', 'signIn', 'proxy']] : []),
    ...Object.entries(providers ?? {}).flatMap(([name, provider]) => (provider.proxy ? [['integrations', 'relayProviders', name, 'proxy']] : [])),
    ...(models.kind === 'openai-compatible' && models.proxy ? [['integrations', 'modelGateway', 'proxy']] : []),
    ...(telemetry.kind === 'otlp' && telemetry.proxy ? [['integrations', 'telemetry', 'proxy']] : []),
  ];
}
