import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { credentialSource } from './blocks.js';
import { modelsDeployment } from './models.js';

describe('the models section on an OpenAI-compatible Endpoint', () => {
  const credential = { kind: 'secret', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/models-api-key' } as const;
  const deployed = modelsDeployment({
    kind: 'openai-compatible', url: 'https://models.example.com/v1', credential, headers: { 'x-tenant': 'botcube-example' }, turnSummaryModel: 'summary',
  });
  const endpoint = JSON.stringify({ url: 'https://models.example.com/v1', credential, headers: { 'x-tenant': 'botcube-example' } });

  it('gives the Endpoint and its credential to the Chat Service, for Turn summaries, and the Credential Service, which relays the agent', () => {
    expect(deployed?.chatService).toEqual({ BOTCUBE_MODELS_ENDPOINT: endpoint, BOTCUBE_TURN_SUMMARY_MODEL: 'summary' });
    expect(deployed?.credentialService).toEqual({ BOTCUBE_MODELS_ENDPOINT: endpoint });
    expect(deployed?.secretArns).toEqual([credential.secretArn]);
  });

  it('gives the Harness only where its models run, and none of the Endpoint', () => {
    expect(deployed?.harness).toEqual({ BOTCUBE_MODELS_KIND: 'openai-compatible' });
  });
});

describe('cache markers on an OpenAI-compatible Endpoint', () => {
  const models = { kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: { kind: 'file', path: '/run/key' }, turnSummaryModel: 'summary' } as const;

  it('reach the Harness, which writes them, and stay out of the Endpoint the others read', () => {
    const deployed = modelsDeployment({ ...models, cacheMarkers: 'claude' });
    const endpoint = JSON.stringify({ url: 'https://models.example.com/v1', credential: { kind: 'file', path: '/run/key' } });

    expect(deployed?.harness).toEqual({ BOTCUBE_MODELS_KIND: 'openai-compatible', BOTCUBE_MODELS_CACHE_MARKERS: 'claude' });
    expect(deployed?.credentialService).toEqual({ BOTCUBE_MODELS_ENDPOINT: endpoint });
    expect(deployed?.chatService).toEqual({ BOTCUBE_MODELS_ENDPOINT: endpoint, BOTCUBE_TURN_SUMMARY_MODEL: 'summary' });
  });
});

describe("the Harness's models environment", () => {
  it.each([
    { kind: 'secret', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/models-api-key' },
    { kind: 'file', path: '/run/secrets/botcube/models-api-key' },
    { kind: 'command', command: ['/usr/local/bin/token-broker', '--audience', 'models'], timeoutSeconds: 30 },
    { kind: 'aws', audience: 'models.example.com' },
  ] as const)('carries no bearer and no Credential Source for a $kind credential', (credential) => {
    const deployed = modelsDeployment({
      kind: 'openai-compatible', url: 'https://models.example.com/v1', credential, headers: { 'x-tenant': 'botcube-example' }, turnSummaryModel: 'summary', cacheMarkers: 'claude',
    });

    expect(deployed?.harness).toEqual({ BOTCUBE_MODELS_KIND: 'openai-compatible', BOTCUBE_MODELS_CACHE_MARKERS: 'claude' });
  });
});

it('deploys nothing for models on Bedrock, the default', () => {
  expect(modelsDeployment({ kind: 'bedrock' })).toBeUndefined();
});

describe('the Credential Service, which relays the models Endpoint', () => {
  it('knows every credential kind the Deployment Config accepts', () => {
    const relay = readFileSync(new URL('../credential-service/src/botcube_credential_service/credential_source.py', import.meta.url), 'utf8');
    const known = [...relay.matchAll(/kind: Literal\['([^']+)'\]/g)].map(([, kind]) => kind);

    expect(known.sort()).toEqual(credentialSource.options.map((option) => option.shape.kind.value).sort());
  });
});
