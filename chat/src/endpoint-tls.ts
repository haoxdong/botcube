import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent, type RequestOptions } from 'node:https';
import { isIP, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, createSecureContext, type ConnectionOptions, type PeerCertificate, type TLSSocket } from 'node:tls';
import { callbackify } from 'node:util';
import { ALLOW_COMMAND_CREDENTIALS_ENV, type EndpointTls as EndpointTlsConfig } from 'botcube-config/blocks';
import { z } from 'zod';
import { refreshingAhead, stdoutOf } from './credential-source.js';

export interface EndpointTls {
  secure(stream: Socket | { host: string; port: number }, hostname: string): Promise<TLSSocket>;
  agent(proxy: string | undefined, onError: (error: EndpointTlsError) => void): Agent;
}

export class EndpointTlsError extends Error {
  override name = 'EndpointTlsError';
}

export function endpointTls(seam: string, config?: EndpointTlsConfig, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): EndpointTls {
  const certificate = config?.clientCertificate && clientCertificate(seam, config.clientCertificate, env);
  const identity = config?.serverIdentity;
  const checkServerIdentity = identity === undefined ? undefined : identityCheck(seam, identity);
  const options = async () => ({
    ...(certificate ? await certificate() : {}),
    ...(checkServerIdentity ? { checkServerIdentity } : {}),
    rejectUnauthorized: true,
  });

  class EndpointAgent extends Agent {
    constructor(private readonly proxy: string | undefined, private readonly report: (error: EndpointTlsError) => void) {
      super({ proxyEnv: { NODE_ENV: process.env.NODE_ENV, HTTPS_PROXY: proxy }, maxCachedSessions: 0 });
    }

    override createConnection(request: RequestOptions, callback?: (error: Error | null, socket: Duplex) => void): undefined {
      if (callback) this.open(request, callback);
      return undefined;
    }

    private readonly open = callbackify(async (request: RequestOptions): Promise<Duplex> => {
      try {
        const tls = await options();
        if (this.proxy === undefined) {
          const socket = super.createConnection({ ...request, ...tls });
          if (!socket) throw new EndpointTlsError(`${seam} TLS: Node did not open a socket`);
          return await verified(socket);
        }
        return await new Promise<Duplex>((resolve, reject) => {
          // Node delivers the Endpoint's verified TLS socket after establishing CONNECT.
          super.createConnection({ ...request, ...tls }, (error, tunnel) => {
            if (error) {
              tunnel.destroy();
              reject(error);
            } else {
              resolve(tunnel);
            }
          });
        });
      } catch (error) {
        if (error instanceof EndpointTlsError) this.report(error);
        throw error;
      }
    });
  }

  return {
    async secure(stream, hostname) {
      try {
        const connection = stream instanceof Socket ? { socket: stream, host: hostname } : stream;
        return await verified(tlsConnect({ ...connection, ...(isIP(hostname) ? {} : { servername: hostname }), ...await options() }));
      } catch (error) {
        if (stream instanceof Socket) stream.destroy();
        throw error;
      }
    },
    agent: (proxy, onError) => new EndpointAgent(proxy, onError),
  };
}

function verified<T extends Duplex>(socket: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const closed = () => failed(new Error('TLS connection closed before peer verification'));
    const secured = () => {
      cleanup();
      resolve(socket);
    };
    const cleanup = () => {
      socket.off('error', failed).off('close', closed).off('secureConnect', secured);
    };
    socket.once('error', failed).once('close', closed).once('secureConnect', secured);
  });
}

type ClientCertificate = NonNullable<EndpointTlsConfig['clientCertificate']>;

function clientCertificate(seam: string, source: ClientCertificate, env: NodeJS.ProcessEnv): () => Promise<{ cert: string; key: string }> {
  if ('command' in source) {
    const named = `${seam} client certificate (command ${source.command[0]})`;
    if (env[ALLOW_COMMAND_CREDENTIALS_ENV] !== '1') throw new EndpointTlsError(`${named}: a command runs only when ${ALLOW_COMMAND_CREDENTIALS_ENV}=1`);
    const credentials = refreshingAhead(named, async () => execCertificate(await stdoutOf(source.command, source.timeoutSeconds)), Date.now);
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
