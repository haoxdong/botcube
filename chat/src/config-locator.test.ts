import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, expect, test, vi } from 'vitest';
import { resolveConfig, resolvedJson } from 'botcube-config/resolved';
import { loadConfig } from 'botcube-config/load';
import { readChatConfig } from './config-locator.js';
import { serveChatService } from './server.js';

const locator = 's3://config-bucket/resolved/previous.json';
const source = new URL('../../examples/public/botcube.yaml', import.meta.url).pathname;

afterEach(() => vi.restoreAllMocks());

test('loads the exact resolved config a revision names', async () => {
  const config = resolveConfig(loadConfig(source));
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({
    Body: { transformToString: async () => resolvedJson(config) },
  }));
  expect(await readChatConfig({ BOTCUBE_CONFIG: locator, AWS_REGION: 'us-east-1' })).toEqual(config);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: 'config-bucket', Key: 'resolved/previous.json' } }));
});

test('names the object when the task role cannot read it', async () => {
  vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('AccessDenied'));
  await expect(serveChatService({ BOTCUBE_CONFIG: locator })).rejects.toThrow(`BOTCUBE_CONFIG ${locator}: AccessDenied`);
});
