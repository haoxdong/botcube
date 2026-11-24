import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { credentialSource } from './blocks.js';
import { modelGatewayResources } from './models.js';

describe('the models section on an OpenAI-compatible Endpoint', () => {
  it('grants the Chat Service and the Credential Service the secret its credential is read from', () => {
    const credential = { kind: 'secret', secretId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/models-api-key' } as const;
    const deployed = modelGatewayResources({
      kind: 'openai-compatible', url: 'https://models.example.com/v1', credential, headers: { 'x-tenant': 'botcube-example' }, turnSummaryModel: 'openai:summary',
    });

    expect(deployed).toEqual({ secretIds: [credential.secretId] });
  });

  it("grants the secret each provider's own credential is read from, beside the gateway's", () => {
    const anthropic = { kind: 'secret', secretId: 'botcube/anthropic-key' } as const;
    const deployed = modelGatewayResources({
      kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: { kind: 'file', path: '/run/key' }, turnSummaryModel: 'openai:summary',
      providers: { anthropic: { url: 'https://models.example.com/anthropic', credential: anthropic }, openai: { url: 'https://models.example.com/openai/v1' } },
    });

    expect(deployed).toEqual({ secretIds: [anthropic.secretId] });
  });

  it('grants nothing for a credential read from a file', () => {
    const deployed = modelGatewayResources({
      kind: 'openai-compatible', url: 'https://models.example.com/v1', credential: { kind: 'file', path: '/run/key' }, turnSummaryModel: 'openai:summary',
    });

    expect(deployed).toEqual({ secretIds: [] });
  });
});

it('deploys nothing for models on Bedrock, the default', () => {
  expect(modelGatewayResources({ kind: 'bedrock' })).toBeUndefined();
});

describe('the Credential Service, which relays the models Endpoint', () => {
  it('knows every credential kind the BotCube Config accepts', () => {
    const relay = readFileSync(new URL('../credential-service/src/botcube_credential_service/credential_source.py', import.meta.url), 'utf8');
    const known = [...relay.matchAll(/kind: Literal\['([^']+)'\]/g)].map(([, kind]) => kind);

    expect(known.sort()).toEqual(credentialSource.options.map((option) => option.shape.kind.value).sort());
  });
});
