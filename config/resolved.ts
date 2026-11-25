import { readFileSync } from 'node:fs';
import { modelProvider, type ModelProvider, type CredentialSource } from './blocks.js';
import { deploymentNames, webOrigins } from './read.cjs';
import { botcubeConfig, type sectionDefaults } from './schema.js';
import { BotCubeConfigError, parsed } from './parse.js';

export const FORMAT_VERSION = 1;

type Config = ReturnType<typeof sectionDefaults>;
type Route = {
  url: string;
  credential: CredentialSource;
  headers: Record<string, string>;
  useResponsesApi: boolean;
};

export type ResolvedConfig = ReturnType<typeof resolveConfig>;

const gatewayProviders = ['anthropic', 'openai'] as const satisfies readonly ModelProvider[];

export function resolveConfig(config: Config) {
  const { integrations: { modelGateway: gateway }, name, names, services } = config;
  const physicalNames: Partial<ReturnType<typeof deploymentNames>> = name === undefined ? {} : deploymentNames({ name, names });
  const served = gateway.kind === 'bedrock' ? [] : gatewayProviders.filter(
    provider => gateway.providers === undefined || gateway.providers[provider] !== undefined,
  );
  const reach = (provider: ModelProvider) => resolveProvider(gateway, provider, served);
  const modelGateway: Partial<Record<string, ReturnType<typeof reach>>> = Object.fromEntries(
    modelProvider.options.map(provider => [provider, reach(provider)]),
  );
  return {
    formatVersion: FORMAT_VERSION,
    config,
    physicalNames,
    webOrigins: webOrigins(config) ?? [],
    credentialServiceHttpPath: services?.credentialService?.http?.path ?? '',
    modelGateway,
  } as const;
}

function resolveProvider(
  gateway: Config['integrations']['modelGateway'],
  provider: ModelProvider,
  served: readonly (typeof gatewayProviders)[number][],
): { route: Route | null; unreachableReason: string | null } {
  if (gateway.kind === 'bedrock' || provider === 'echo') return { route: null, unreachableReason: null };
  const name = served.find(candidate => candidate === provider);
  if (!name) return { route: null, unreachableReason: `integrations.modelGateway reaches the providers ${served.join(' and ')}` };

  const override = gateway.providers?.[name];
  const url = override?.url ?? gateway.url;
  if (name === 'anthropic' && /\/v1\/*$/.test(new URL(url).pathname)) {
    const field = override?.url ? 'integrations.modelGateway.providers.anthropic.url' : 'integrations.modelGateway.url';
    const next = override?.url ? 'remove /v1 from that URL' : 'set integrations.modelGateway.providers.anthropic.url without /v1';
    return { route: null, unreachableReason: `${field} ends in /v1, which Anthropic's API adds itself: ${next}` };
  }
  return {
    route: {
      url: url.replace(/\/+$/, ''),
      credential: override?.credential ?? gateway.credential,
      headers: override?.headers ?? gateway.headers ?? {},
      useResponsesApi: name === 'openai' && (gateway.providers?.openai?.useResponsesApi ?? false),
    },
    unreachableReason: null,
  };
}

export function resolvedJson(config: ResolvedConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

export function loadResolvedConfig(path: string): ResolvedConfig {
  return parseResolvedConfig(() => readFileSync(path, 'utf8'), path);
}

export function parseResolvedConfig(read: () => string, locator: string): ResolvedConfig {
  const source = `Resolved BotCube Config ${locator}`;
  try {
    const artifact = JSON.parse(read()) as ResolvedConfig | null;
    if (artifact?.formatVersion !== FORMAT_VERSION) {
      throw new Error(`expected formatVersion ${FORMAT_VERSION}, got ${artifact?.formatVersion}`);
    }
    return { ...artifact, config: parsed(botcubeConfig, artifact.config, source) };
  } catch (error) {
    if (error instanceof BotCubeConfigError) throw error;
    throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
