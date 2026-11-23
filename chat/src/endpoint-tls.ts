import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSecureContext, type ConnectionOptions, type PeerCertificate } from 'node:tls';
import { ALLOW_COMMAND_CREDENTIALS_ENV, type EndpointTls as EndpointTlsConfig } from 'botcube-config/blocks';
import { z } from 'zod';
import { refreshingAhead, stdoutOf } from './credential-source.js';

/** The TLS options of one new connection; a key lives only here, never in an error or a log. */
export type TlsConnectOptions = Pick<ConnectionOptions, 'cert' | 'key' | 'checkServerIdentity'>;

export interface EndpointTls {
  /** The client certificate as its source gives it now, and the check of the server's identity. */
  connectOptions(): Promise<TlsConnectOptions>;
}

export class EndpointTlsError extends Error {
  override name = 'EndpointTlsError';
}

export function endpointTls(seam: string, config: EndpointTlsConfig, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): EndpointTls {
  const certificate = config.clientCertificate && clientCertificate(seam, config.clientCertificate, env);
  const checkServerIdentity = config.serverIdentity === undefined ? undefined : identityCheck(seam, config.serverIdentity);
  return {
    connectOptions: async () => ({ ...(certificate ? await certificate() : {}), ...(checkServerIdentity ? { checkServerIdentity } : {}) }),
  };
}

type ClientCertificate = NonNullable<EndpointTlsConfig['clientCertificate']>;

function clientCertificate(seam: string, source: ClientCertificate, env: NodeJS.ProcessEnv): () => Promise<{ cert: string; key: string }> {
  if ('command' in source) {
    const named = `${seam} client certificate (command ${source.command[0]})`;
    if (env[ALLOW_COMMAND_CREDENTIALS_ENV] !== '1') throw new EndpointTlsError(`${named}: a command runs only when ${ALLOW_COMMAND_CREDENTIALS_ENV}=1`);
    const credentials = refreshingAhead(named, async () => execCertificate(await stdoutOf(source.command, source.timeoutSeconds)), Date.now, { boundMandatoryWindow: true });
    return async () => (await credentials.get().catch((error: unknown) => {
      throw new EndpointTlsError(error instanceof Error ? error.message : String(error));
    })).value;
  }
  const read = (path: string) => readFile(path, 'utf8').catch((error: unknown) => {
    throw new EndpointTlsError(`${seam} client certificate (file ${path}): ${error instanceof Error ? error.message : String(error)}`);
  });
  return async () => {
    const [cert, key] = await Promise.all([read(source.certificate), read(source.key)]);
    return { cert, key };
  };
}

/** A Kubernetes `ExecCredential` carrying a client certificate, as a credential plugin prints it. */
const ExecCredential = z.object({
  kind: z.literal('ExecCredential'),
  status: z.object({
    clientCertificateData: z.string().min(1),
    clientKeyData: z.string().min(1),
    expirationTimestamp: z.iso.datetime({ offset: true }).optional(),
  }),
});

function execCertificate(stdout: string) {
  const malformed = new Error('the command did not print a Kubernetes ExecCredential with status.clientCertificateData and status.clientKeyData');
  let printed: unknown;
  try { printed = JSON.parse(stdout); } catch { throw malformed; }
  const parsed = ExecCredential.safeParse(printed);
  if (!parsed.success) throw malformed;
  const { clientCertificateData: cert, clientKeyData: key, expirationTimestamp } = parsed.data.status;
  try {
    createSecureContext({ cert, key });
    return { value: { cert, key }, expiresAt: expirationTimestamp === undefined ? new X509Certificate(cert).validToDate : new Date(expirationTimestamp) };
  } catch {
    throw new Error('the command printed an invalid client certificate or key');
  }
}

const ALT_NAME = /([^:,]+):("(?:[^"\\]|\\.)*"|[^,]*)(?:, |$)/y;

/**
 * The certificate's URI SANs, such as a SPIFFE ID, or `undefined` when its `subjectaltname` does not parse. Node
 * JSON-quotes a name holding a comma (CVE-2021-44532), so splitting on `, ` would read one name as several.
 */
function uriNames({ subjectaltname = '' }: PeerCertificate): string[] | undefined {
  const names: string[] = [];
  ALT_NAME.lastIndex = 0;
  while (ALT_NAME.lastIndex < subjectaltname.length) {
    const match = ALT_NAME.exec(subjectaltname);
    if (!match) return undefined;
    const [, kind, value = ''] = match;
    if (kind !== 'URI') continue;
    try {
      names.push(value.startsWith('"') ? z.string().parse(JSON.parse(value)) : value);
    } catch {
      return undefined;
    }
  }
  return names;
}

/**
 * Node's `checkServerIdentity` matching the server certificate's URI SAN in place of its hostname. It runs after the
 * chain is verified and before the connection is established, so a refused server is sent nothing.
 */
function identityCheck(seam: string, expected: string): NonNullable<ConnectionOptions['checkServerIdentity']> {
  return (_host, certificate) => {
    const received = uriNames(certificate);
    if (received?.includes(expected)) return undefined;
    const presented = received === undefined ? 'an unreadable subjectAltName' : received.join(', ') || 'no URI identity';
    return new EndpointTlsError(`${seam} TLS: expected server identity ${expected}, but the server presented ${presented}`);
  };
}
