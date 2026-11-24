import type { BotCubeConfig, BotSettings } from './schema.js';

export type FootprintBot = Pick<BotSettings, 'models'> & Partial<Pick<BotSettings, 'environment'>>;

const RELAY_ORIGIN = 'http://127.0.0.1:<port>';

export function modelLines(gateway: BotCubeConfig['integrations']['modelGateway'], bot: FootprintBot | undefined): string[] {
  return [
    ...(gateway.kind === 'openai-compatible'
      ? [`openai-compatible ${gateway.url}`, ...Object.entries(gateway.providers ?? {}).map(([provider, own]) => `provider ${provider} ${own.url ?? gateway.url}`)]
      : [gateway.kind]),
    ...(bot?.models ?? []).map(({ key, provider }) => `model ${key}: ${provider}`),
  ];
}

export function shellEnvironment(bot: FootprintBot | undefined): string[] {
  return Object.entries({ BOTCUBE_RELAY_URL: RELAY_ORIGIN, ...bot?.environment })
    .map(([name, value]) => `${name}=${value.replace(/\$\$|\$\{BOTCUBE_RELAY_URL\}/g, (reference) => (reference === '$$' ? '$' : RELAY_ORIGIN))}`);
}
