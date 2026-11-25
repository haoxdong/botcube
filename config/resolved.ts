import { gatewayServesProvider, modelProvider, unreachedProvider, type ModelProvider, type CredentialSource } from './blocks.js';
import { deploymentNames, webOrigins } from './read.cjs';
import type { sectionDefaults } from './schema.js';

export const FORMAT_VERSION = 1;

type Config = ReturnType<typeof sectionDefaults>;
type Route = {
  url: string;
  credential: CredentialSource;
  headers: Record<string, string>;
  useResponsesApi: boolean;
};

export type ResolvedConfig = ReturnType<typeof resolveConfig>;

export function resolveConfig(config: Config) {
  const { integrations: { modelGateway: gateway }, name, names, services } = config;
  const physicalNames: Partial<ReturnType<typeof deploymentNames>> = name === undefined ? {} : deploymentNames({ name, names });
  const reach = (provider: ModelProvider) => ({
    route: modelRoute(gateway, provider),
    unreachableReason: unreachedProvider(gateway, provider) ?? null,
  });
  return {
    formatVersion: FORMAT_VERSION,
    config,
    physicalNames,
    webOrigins: webOrigins(config) ?? [],
    credentialServiceHttpPath: services?.credentialService?.http?.path ?? '',
    modelGateway: Object.fromEntries(modelProvider.options.map(provider => [provider, reach(provider)])),
  } as const;
}

function modelRoute(
  gateway: Config['integrations']['modelGateway'],
  provider: ModelProvider,
): Route | null {
  if (gateway.kind === 'bedrock' || !gatewayServesProvider(gateway, provider)) return null;
  const override = gateway.providers?.[provider];
  return {
    url: (override?.url ?? gateway.url).replace(/\/+$/, ''),
    credential: override?.credential ?? gateway.credential,
    headers: override?.headers ?? gateway.headers ?? {},
    useResponsesApi: provider === 'openai' && (gateway.providers?.openai?.useResponsesApi ?? false),
  };
}

export function resolvedJson(config: ResolvedConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}
