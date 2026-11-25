import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadResolvedConfig, parseResolvedConfig, type ResolvedConfig } from 'botcube-config/resolved';

export async function readChatConfig(env: NodeJS.ProcessEnv): Promise<ResolvedConfig> {
  const locator = env.BOTCUBE_CONFIG;
  if (!locator) throw new Error('BOTCUBE_CONFIG is not set: the stock Chat Service serves the BotCube Config it names');
  return locator.startsWith('s3://') ? s3Config(locator, env.AWS_REGION) : loadResolvedConfig(locator);
}

async function s3Config(locator: string, region?: string): Promise<ResolvedConfig> {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(locator);
  const [, Bucket, Key] = match ?? [];
  if (!Bucket || !Key) throw new Error(`BOTCUBE_CONFIG ${locator}: expected s3://bucket/key`);
  const client = new S3Client(region === undefined ? {} : { region });
  try {
    const { Body } = await client.send(new GetObjectCommand({ Bucket, Key }));
    const text = await Body?.transformToString() ?? '';
    return parseResolvedConfig(() => text, locator);
  } catch (error) {
    throw new Error(`BOTCUBE_CONFIG ${locator}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    client.destroy();
  }
}
