import { z } from 'zod';
import { commandFields, type DeploymentConfig } from './schema.js';
import { ALLOW_COMMAND_CREDENTIALS_ENV, credentialSource, jsonFromEnv, type CredentialSource } from './blocks.js';

/** Reached directly whatever the proxy: loopback (a task's sidecars) and the EC2 and ECS metadata endpoints (its credentials). */
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1', '169.254.169.254', '169.254.170.2'];

/**
 * Where a process relays to an authenticating proxy: the Chat Service and the Harness each listen here on loopback, and
 * a task's sidecars, sharing the task's loopback, use the Chat Service's.
 */
export const PROXY_RELAY_PORT = 3128;
const RELAY_HOST = '127.0.0.1';

/** The variables the relay reads: the operator's proxy, and its Credential Source and headers as JSON. */
const PROXY_URL_ENV = 'BOTCUBE_PROXY_URL';
const PROXY_CREDENTIAL_ENV = 'BOTCUBE_PROXY_CREDENTIAL';
const PROXY_HEADERS_ENV = 'BOTCUBE_PROXY_HEADERS';

type ForwardProxy = Extract<DeploymentConfig['proxy'], { kind: 'forward' }>;

/**
 * The standard proxy variables every BotCube process gets from the Deployment Config's `proxy`, or none without one.
 * Python's HTTP clients read them as they are; Node's `fetch` and default agents read them under `NODE_USE_ENV_PROXY`.
 *
 * A proxy with a credential, headers or TLS is reached through a relay on `relayPort` in the process itself
 * (`proxy-relay` in botcube/chat, botcube/harness and botcube/credential-service), which sets them on each request and
 * presents the client certificate on each connection: every client reads HTTP(S)_PROXY once, so only the relay can
 * send a refreshed credential or a rotated certificate.
 */
export function proxyEnvironment({ proxy }: Pick<DeploymentConfig, 'proxy'>, { relayPort = PROXY_RELAY_PORT }: { relayPort?: number } = {}): Record<string, string> {
  if (proxy.kind === 'none') return {};
  const noProxy = [...new Set([...ALWAYS_DIRECT, ...(proxy.noProxy ?? [])])].join(',');
  const relayed = proxy.credential !== undefined || proxy.headers !== undefined || proxy.tls !== undefined;
  const url = relayed ? `http://${RELAY_HOST}:${relayPort}` : proxy.url;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    NO_PROXY: noProxy,
    NODE_USE_ENV_PROXY: '1',
    ...(relayed ? relayEnvironment(proxy) : {}),
  };
}

function relayEnvironment({ url, credential, headers }: ForwardProxy): Record<string, string> {
  return {
    [PROXY_URL_ENV]: url,
    ...(credential ? { [PROXY_CREDENTIAL_ENV]: JSON.stringify(credential) } : {}),
    ...(headers ? { [PROXY_HEADERS_ENV]: JSON.stringify(headers) } : {}),
  };
}

/**
 * The opt-in every BotCube process gets, from the deploy environment and never from the Deployment Config: whoever can
 * edit the file chooses a command credential's command, so the operator sets ALLOW_COMMAND_CREDENTIALS_ENV where the
 * deploy runs. Throws, naming each command credential, when the config has one and the operator set nothing.
 */
export function commandCredentialOptIn(config: DeploymentConfig, deployEnvironment: NodeJS.ProcessEnv): Record<string, string> {
  if (deployEnvironment[ALLOW_COMMAND_CREDENTIALS_ENV] === '1') return { [ALLOW_COMMAND_CREDENTIALS_ENV]: '1' };
  const commands = commandFields(config).map((path) => path.join('.'));
  if (commands.length) {
    throw new Error(commands.map((field) => `${field} is a command credential, which runs only when the deploy environment sets ${ALLOW_COMMAND_CREDENTIALS_ENV}=1`).join('\n'));
  }
  return {};
}

export interface ProxyRelaySettings {
  readonly upstream: URL;
  readonly listen: { readonly host: string; readonly port: number };
  readonly credential?: CredentialSource;
  readonly headers: Readonly<Record<string, string>>;
}

/** The relay the deploy set for this process, or undefined; throws naming the variable on a malformed one. */
export function proxyRelayFromEnv(env: NodeJS.ProcessEnv): ProxyRelaySettings | undefined {
  const upstream = env[PROXY_URL_ENV];
  if (!upstream) return undefined;
  const listen = new URL(required(env, 'HTTPS_PROXY'));
  const credential = jsonFromEnv(env, PROXY_CREDENTIAL_ENV, credentialSource);
  return {
    upstream: new URL(upstream),
    listen: { host: listen.hostname, port: Number(listen.port) },
    ...(credential ? { credential } : {}),
    headers: jsonFromEnv(env, PROXY_HEADERS_ENV, z.record(z.string(), z.string())) ?? {},
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is unset beside ${PROXY_URL_ENV}; the deploy points it at the proxy relay`);
  return value;
}
