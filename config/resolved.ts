import { readFileSync } from 'node:fs';
import { gatewayServesProvider, modelProvider, unreachedProvider, type ModelProvider, type CredentialSource } from './blocks.js';
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

export function resolveConfig(config: Config) {
  const { integrations: { modelGateway: gateway }, name, names, services } = config;
  const physicalNames: Partial<ReturnType<typeof deploymentNames>> = name === undefined ? {} : deploymentNames({ name, names });
  const reach = (provider: ModelProvider) => ({
    route: modelRoute(gateway, provider),
    unreachableReason: unreachedProvider(gateway, provider) ?? null,
  });
  const modelGateway: Partial<Record<ModelProvider, ReturnType<typeof reach>>> = Object.fromEntries(
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
