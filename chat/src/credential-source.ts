import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ALLOW_COMMAND_CREDENTIALS_ENV, type CredentialSource as CredentialSourceConfig } from 'botcube-deployment-config/blocks';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { signedAwsHeaders } from './aws.js';

export interface Credential {
  readonly value: string;
  /** Undefined for a token its source gave no expiry: it is kept for the life of the process, as kubectl keeps one. */
  readonly expiresAt: Date | undefined;
}

export interface CredentialSource {
  get(): Promise<Credential>;
}

const REREAD_AFTER_MS = 5 * 60_000;
const REFRESH_BEFORE_EXPIRY_MS = 60_000;
/** How long STS accepts a SigV4 signature. */
const SIGV4_VALID_MS = 15 * 60_000;
/** The header an `aws` source signs its audience into, as Google's signs x-goog-cloud-target-resource. */
const AWS_AUDIENCE_HEADER = 'x-botcube-audience';

export interface BotCubeSigner {
  signServiceToken(audience: string): Promise<string>;
}

export class CredentialSourceError extends Error {
  override name = 'CredentialSourceError';
}

export function credentialSource(
  seam: string,
  source: CredentialSourceConfig,
  options: { now?: () => number; env?: NodeJS.ProcessEnv; botcube?: BotCubeSigner } = {},
): CredentialSource {
  const now = options.now ?? Date.now;
  const adapted = adapter(source, now, options.env ?? process.env, options.botcube);
  const named = `${seam} credential (${adapted.about})`;
  if ('refused' in adapted) throw new CredentialSourceError(`${named}: ${adapted.refused}`);
  const { read } = adapted;
  let cached: Credential | undefined;
  let reading: Promise<Credential> | undefined;
  const fresh = (credential: Credential | undefined): credential is Credential =>
    credential !== undefined && (credential.expiresAt === undefined || now() < credential.expiresAt.getTime() - REFRESH_BEFORE_EXPIRY_MS);
  const refresh = async () => {
    try {
      cached = await read();
      return cached;
    } catch (error) {
      throw new CredentialSourceError(`${named}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      reading = undefined;
    }
  };
  return { get: async () => (fresh(cached) ? cached : (reading ??= refresh())) };
}

type Adapter = { readonly about: string; readonly read: () => Promise<Credential> } | { readonly about: string; readonly refused: string };

function adapter(source: CredentialSourceConfig, now: () => number, env: NodeJS.ProcessEnv, botcube: BotCubeSigner | undefined): Adapter {
  switch (source.kind) {
    case 'secret': return {
      about: `secret ${source.secretArn}`,
      read: async () => ({ value: await secretString(source.secretArn, env), expiresAt: new Date(now() + REREAD_AFTER_MS) }),
    };
    case 'file': return {
      about: `file ${source.path}`,
      read: async () => {
        const value = (await readFile(source.path, 'utf8')).replace(/\r?\n$/, '');
        if (!value) throw new Error('the file is empty');
        return { value, expiresAt: new Date(now() + REREAD_AFTER_MS) };
      },
    };
    case 'command': {
      const about = `command ${source.command[0]}`;
      if (env[ALLOW_COMMAND_CREDENTIALS_ENV] !== '1') return { about, refused: `a command credential runs only when ${ALLOW_COMMAND_CREDENTIALS_ENV}=1` };
      return { about, read: async () => execCredential(await stdoutOf(source.command, source.timeoutSeconds)) };
    }
    case 'aws': return {
      about: `aws ${source.audience}`,
      read: async () => ({ value: await callerIdentityRequest(source.audience, env), expiresAt: new Date(now() + SIGV4_VALID_MS) }),
    };
    case 'botcube': {
      const about = `botcube ${source.audience}`;
      if (!botcube) return { about, refused: 'only the Chat Service signs a botcube token, with its Turn identity keys' };
      return {
        about,
        read: async () => {
          const value = await botcube.signServiceToken(source.audience);
          return { value, expiresAt: new Date((decodeJwt(value).exp ?? 0) * 1000) };
        },
      };
    }
  }
}

/**
 * The process's AWS identity as Google's external-account `aws` subject token serializes it: a SigV4-signed
 * sts:GetCallerIdentity request in the process's region, its audience signed in, as URL-encoded JSON.
 */
async function callerIdentityRequest(audience: string, env: NodeJS.ProcessEnv): Promise<string> {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1';
  const endpoint = new URL(env.AWS_ENDPOINT_URL_STS || `https://sts.${region}.amazonaws.com`);
  const url = `${endpoint.origin}/?Action=GetCallerIdentity&Version=2011-06-15`;
  const signed = await signedAwsHeaders('sts', region, { method: 'POST', url, headers: { [AWS_AUDIENCE_HEADER]: audience } });
  const headers = Object.entries({ host: endpoint.host, ...signed }).map(([key, value]) => ({ key, value }));
  return encodeURIComponent(JSON.stringify({ url, method: 'POST', headers }));
}

async function secretString(secretArn: string, env: NodeJS.ProcessEnv): Promise<string> {
  const endpoint = env.AWS_ENDPOINT_URL_SECRETS_MANAGER;
  const region = secretArn.split(':')[3];
  const client = new SecretsManagerClient({ ...(region ? { region } : {}), ...(endpoint ? { endpoint } : {}) });
  try {
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!SecretString) throw new Error('the secret holds no string');
    return SecretString;
  } finally {
    client.destroy();
  }
}

/**
 * What the command prints on stdout. Its stderr is discarded unread, since a helper may write a secret there (AWS's
 * `credential_process` warning), and neither its output nor its stderr reaches an error.
 */
function stdoutOf([program, ...args]: readonly [string, ...string[]], timeoutSeconds: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the command did not finish within ${timeoutSeconds} s`));
    }, timeoutSeconds * 1000);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(code === null ? `the command was stopped by ${signal}` : `the command exited with code ${code}`));
    });
  });
}

/** A Kubernetes `ExecCredential`, as a credential plugin prints it. */
const ExecCredential = z.object({
  kind: z.literal('ExecCredential'),
  status: z.object({ token: z.string().min(1), expirationTimestamp: z.iso.datetime({ offset: true }).optional() }),
});

function execCredential(stdout: string): Credential {
  const malformed = new Error('the command did not print a Kubernetes ExecCredential with status.token');
  let printed: unknown;
  try {
    printed = JSON.parse(stdout);
  } catch {
    throw malformed;
  }
  const parsed = ExecCredential.safeParse(printed);
  if (!parsed.success) throw malformed;
  const { token, expirationTimestamp } = parsed.data.status;
  return { value: token, expiresAt: expirationTimestamp === undefined ? undefined : new Date(expirationTimestamp) };
}
