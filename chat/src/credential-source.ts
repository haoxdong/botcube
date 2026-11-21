import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ALLOW_COMMAND_CREDENTIALS_ENV, type CredentialSource as CredentialSourceConfig } from 'botcube-config/blocks';
import { decodeJwt } from 'jose';
import * as oidc from 'openid-client';
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
const MANDATORY_REFRESH_WINDOW_MS = 60_000;
const ADVISORY_REFRESH_WINDOW_MAX_MS = 15 * 60_000;
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
  return refreshingAhead(named, adapted.read, now);
}

function refreshingAhead(named: string, read: () => Promise<Credential>, now: () => number): CredentialSource {
  let cached: { credential: Credential; advisoryAt: number; mandatoryAt: number } | undefined;
  let refreshing: Promise<Credential> | undefined;
  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = read()
      .then((credential) => {
        cached = { credential, ...refreshWindows(credential, now()) };
        return credential;
      }, (error: unknown) => {
        throw new CredentialSourceError(`${named}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      })
      .finally(() => { refreshing = undefined; });
    void refreshing.catch((error: unknown) => { console.warn(`Credential refresh failed: ${error instanceof Error ? error.message : String(error)}`); });
    return refreshing;
  };
  return {
    get: async () => {
      const at = now();
      if (cached === undefined || at >= cached.mandatoryAt) return refresh();
      if (at >= cached.advisoryAt) void refresh();
      return cached.credential;
    },
  };
}

function refreshWindows({ expiresAt }: Credential, mintedAt: number) {
  if (expiresAt === undefined) return { advisoryAt: Infinity, mandatoryAt: Infinity };
  const expiry = expiresAt.getTime();
  return { advisoryAt: expiry - Math.min((expiry - mintedAt) / 2, ADVISORY_REFRESH_WINDOW_MAX_MS), mandatoryAt: expiry - MANDATORY_REFRESH_WINDOW_MS };
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
    case 'oauth-client-credentials': {
      const about = `oauth-client-credentials ${source.tokenEndpoint}`;
      const secret = adapter(source.clientSecret, now, env, botcube);
      const secretNamed = `client secret (${secret.about})`;
      if ('refused' in secret) return { about, refused: `${secretNamed}: ${secret.refused}` };
      return {
        about,
        read: async () => {
          const clientSecret = await secret.read().catch((error: unknown) => {
            throw new Error(`${secretNamed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          });
          return clientCredentialsGrant(source, clientSecret.value, now);
        },
      };
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

/** RFC 6749 section 4.4's client-credentials grant, the client authenticating with HTTP Basic. */
async function clientCredentialsGrant(
  { tokenEndpoint, clientId, scopes }: Extract<CredentialSourceConfig, { kind: 'oauth-client-credentials' }>,
  clientSecret: string,
  now: () => number,
): Promise<Credential> {
  const endpoint = new URL(tokenEndpoint);
  const configuration = new oidc.Configuration({ issuer: endpoint.origin, token_endpoint: tokenEndpoint }, clientId, undefined, oidc.ClientSecretBasic(clientSecret));
  if (endpoint.protocol === 'http:') oidc.allowInsecureRequests(configuration);
  const token = await oidc.clientCredentialsGrant(configuration, scopes ? { scope: scopes.join(' ') } : {}).catch((error: unknown) => {
    throw tokenEndpointError(error);
  });
  const expiresAt = token.expires_in === undefined ? (jwtExpiry(token.access_token) ?? now() + REREAD_AFTER_MS) : now() + token.expires_in * 1000;
  return { value: token.access_token, expiresAt: new Date(expiresAt) };
}

/** RFC 6749 section 5.1 only recommends `expires_in`; an access token that is a JWT still carries its own `exp`. */
function jwtExpiry(token: string): number | undefined {
  try {
    const { exp } = decodeJwt(token);
    return exp === undefined ? undefined : exp * 1000;
  } catch {
    return undefined;
  }
}

/** RFC 6749 section 5.2's error code, a registered token such as invalid_client; its description may echo the request. */
const OAUTH_ERROR_CODE = /^[\x20-\x21\x23-\x5B\x5D-\x7E]+$/;

/** The status and OAuth error code only: openid-client's error carries the reply, which may echo the secret. */
function tokenEndpointError(error: unknown): Error {
  if (error instanceof oidc.ResponseBodyError) {
    return new Error(`the token endpoint answered ${error.status}${OAUTH_ERROR_CODE.test(error.error) ? ` ${error.error}` : ''}`);
  }
  if (error instanceof oidc.WWWAuthenticateChallengeError) return new Error(`the token endpoint answered ${error.status}`);
  if (error instanceof oidc.ClientError && error.cause instanceof Response) return new Error(`the token endpoint answered ${error.cause.status}`);
  if (error instanceof TypeError) return new Error(`the token endpoint could not be reached: ${error.message}`);
  return new Error('the token endpoint did not answer with an access_token');
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
export function stdoutOf([program, ...args]: readonly [string, ...string[]], timeoutSeconds: number): Promise<string> {
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
