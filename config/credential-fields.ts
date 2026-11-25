import type { CredentialSource, EndpointTls } from 'botcube-config/blocks';
import type { Principal } from './principals.js';
import type { BotCubeConfig } from './schema.js';
import type { HarnessAuth } from './seams.js';

type Field<Value> = { path: (string | number)[]; value: Value; readers: readonly Principal[] };
type Integrations = Pick<BotCubeConfig, 'integrations'>;

const CHAT = ['chatService'] as const;
const GATEWAY = ['credentialService'] as const;
const TELEMETRY = ['chatService', 'harness'] as const;
const PROXY = ['chatService', 'credentialService', 'harness'] as const;

export const outsideIssuer = <Token>(auth: HarnessAuth<Token>): auth is Extract<HarnessAuth<Token>, { token: Token }> =>
  auth.kind === 'jwt-bearer' && auth.issuer !== 'botcube';

function field<Value>(readers: readonly Principal[], value: Value | undefined, ...path: (string | number)[]): Field<Value>[] {
  return value === undefined ? [] : [{ path: ['integrations', ...path], value, readers }];
}

export function credentialFields({ integrations: { harnessAuth, proxy, telemetry, signIn, modelGateway } }: Integrations): Field<CredentialSource>[] {
  const fields = [
    ...field(CHAT, outsideIssuer(harnessAuth) ? harnessAuth.token : undefined, 'harnessAuth', 'token'),
    ...field(PROXY, proxy.kind === 'forward' ? proxy.credential : undefined, 'proxy', 'credential'),
    ...field(TELEMETRY, telemetry.kind === 'otlp' ? telemetry.credential : undefined, 'telemetry', 'credential'),
    ...(signIn.kind === 'oidc' ? signIn.clients.flatMap(({ clientSecret }, index) => field(CHAT, clientSecret, 'signIn', 'clients', index, 'clientSecret')) : []),
  ];
  if (modelGateway.kind === 'openai-compatible') {
    fields.push(
      ...field(GATEWAY, modelGateway.credential, 'modelGateway', 'credential'),
      ...Object.entries<{ credential?: CredentialSource | undefined } | undefined>(modelGateway.providers ?? {}).flatMap(([provider, route]) =>
        field(GATEWAY, route?.credential, 'modelGateway', 'providers', provider, 'credential')),
    );
  }
  return fields.flatMap(({ path, value, readers }) =>
    credentialSources(value).map(([suffix, source]) => ({ path: [...path, ...suffix], value: source, readers })));
}

export function tlsFields({ integrations: { modelGateway, proxy, telemetry } }: Integrations): Field<EndpointTls>[] {
  return [
    ...field(GATEWAY, modelGateway.kind === 'openai-compatible' ? modelGateway.tls : undefined, 'modelGateway', 'tls'),
    ...field(PROXY, proxy.kind === 'forward' ? proxy.tls : undefined, 'proxy', 'tls'),
    ...field(TELEMETRY, telemetry.kind === 'otlp' ? telemetry.tls : undefined, 'telemetry', 'tls'),
  ];
}

export function commandFields(config: Integrations): (string | number)[][] {
  return [
    ...credentialFields(config).filter(({ value }) => value.kind === 'command').map(({ path }) => path),
    ...tlsFields(config).filter(({ value }) => value.clientCertificate && 'command' in value.clientCertificate)
      .map(({ path }) => [...path, 'clientCertificate']),
  ];
}

function credentialSources(source: CredentialSource): [path: string[], source: CredentialSource][] {
  return source.kind === 'oauth-client-credentials' ? [[[], source], [['clientSecret'], source.clientSecret]] : [[[], source]];
}

/** The Secrets Manager secrets these Credential Sources are read from, by name or ARN, which their readers are granted. */
export const secretIds = (...sources: CredentialSource[]): string[] =>
  sources.flatMap(credentialSources).flatMap(([, source]) => (source.kind === 'secret' ? [source.secretId] : []));
