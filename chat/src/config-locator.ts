import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { existsSync, readFileSync } from 'node:fs';
import { botcubeConfig, type BotCubeConfig } from 'botcube-config';
import { loadConfig } from 'botcube-config/load';
import { BotCubeConfigError, parsed } from 'botcube-config/parse';
import { FORMAT_VERSION } from 'botcube-config/resolved';

export function localConfig(path: string): BotCubeConfig {
  if (/\.ya?ml$/.test(path)) return loadConfig(path);
  if (!existsSync(path)) throw new BotCubeConfigError(`BotCube Config ${path}: no file`);
  return decodeConfig(readFileSync(path, 'utf8'), path);
}

export async function s3Config(locator: string): Promise<BotCubeConfig> {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(locator);
  const [, Bucket, Key] = match ?? [];
  if (!Bucket || !Key) throw new Error(`BOTCUBE_CONFIG ${locator}: expected s3://bucket/key`);
  const client = new S3Client({});
  try {
    const { Body } = await client.send(new GetObjectCommand({ Bucket, Key }));
    return decodeConfig(await Body?.transformToString() ?? '', locator);
  } catch (error) {
    throw new Error(`BOTCUBE_CONFIG ${locator}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    client.destroy();
  }
}

function decodeConfig(text: string, locator: string): BotCubeConfig {
  const value = JSON.parse(text);
  if (value?.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Resolved BotCube Config ${locator}: expected formatVersion ${FORMAT_VERSION}, got ${value?.formatVersion}`);
  }
  return parsed(botcubeConfig, value.config, `Resolved BotCube Config ${locator}`);
}
