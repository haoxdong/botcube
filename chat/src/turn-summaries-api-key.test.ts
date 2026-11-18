import { randomUUID } from 'node:crypto';
import { CreateSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { MODELS_ENV } from 'botcube-deployment-config/models';
import { describe, expect, it } from 'vitest';
import { motoAws, motoEndpoint } from '../test/fakes/moto.js';
import { turnSummaryModelFromEnv, type OpenAICompatibleSummaryModel, type TurnSummaryModel } from './turn-summaries.js';

const modelsEnv = (secretArn: string) => ({
  [MODELS_ENV.baseUrl]: 'https://models.example.com/v1/',
  [MODELS_ENV.apiKeySecretArn]: secretArn,
  [MODELS_ENV.turnSummaryModel]: 'example-summary',
  AWS_ENDPOINT_URL_SECRETS_MANAGER: motoEndpoint(),
});

function openAICompatible(model: TurnSummaryModel): OpenAICompatibleSummaryModel {
  if (model.kind !== 'openai-compatible') throw new Error(`Expected the OpenAI-compatible summary model, not ${model.kind}`);
  return model;
}

describe('the summary model on an OpenAI-compatible endpoint', () => {
  it('reads its API key from the Secrets Manager secret the deploy names', async () => {
    const client = new SecretsManagerClient(motoAws());
    const { ARN } = await client.send(new CreateSecretCommand({ Name: `models-api-key-${randomUUID()}`, SecretString: 'sk-example' }));
    client.destroy();
    const model = openAICompatible(turnSummaryModelFromEnv(modelsEnv(ARN ?? ''), 'us-east-1'));

    expect(model).toMatchObject({ url: 'https://models.example.com/v1/chat/completions', model: 'example-summary' });
    expect(await model.apiKey()).toBe('sk-example');
  });

  it('fails each use while the secret cannot be read', async () => {
    const model = openAICompatible(turnSummaryModelFromEnv(modelsEnv(`arn:aws:secretsmanager:us-east-1:123456789012:secret:absent-${randomUUID()}`), 'us-east-1'));

    await expect(model.apiKey()).rejects.toThrow(/Secrets Manager can.t find the specified secret/);
    await expect(model.apiKey()).rejects.toThrow(/Secrets Manager can.t find the specified secret/);
  });

  it('stops on a secret named by something other than an ARN, naming it', () => {
    expect(() => turnSummaryModelFromEnv(modelsEnv('models-api-key'), 'us-east-1'))
      .toThrow(`${MODELS_ENV.apiKeySecretArn} is not a secret ARN: models-api-key`);
  });
});
