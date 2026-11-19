import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpFake } from './http-fake.js';

/**
 * AgentCore Runtime's inbound JWT authorizer (`customJWTAuthorizer`) in front of a local Harness: it reads the
 * issuer's OIDC discovery, admits only a bearer token that issuer signed for an allowed audience, and answers anything
 * else 401 with `WWW-Authenticate: Bearer`, as the Runtime does. The issuer is reached at its local address: the
 * discovery document's `jwks_uri` is read on the discovery URL's origin.
 */
export class FakeJwtAuthorizer extends HttpFake {
  private issuer: Promise<{ issuer: string; keys: JWTVerifyGetKey }> | undefined;
  private discoveryUrl: string | undefined;

  constructor(harnessUrl: string, allowedAudience: string[]) {
    super(async (request, response) => {
      const token = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ''))?.[1];
      if (token === undefined || !(await this.admits(token, allowedAudience))) {
        response.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'UnauthorizedException: the JWT bearer token is invalid or not found' }));
        return;
      }
      const { authorization: _authorization, host: _host, 'content-length': _length, connection: _connection, ...headers } = request.headers;
      const upstream = await fetch(`${harnessUrl}${request.path}`, {
        method: request.method,
        headers: headers as Record<string, string>,
        ...(request.bodyBytes.length > 0 ? { body: new Uint8Array(request.bodyBytes) } : {}),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      // Relay each chunk as it comes, so the Turn's stream stays a stream.
      for await (const chunk of upstream.body ?? []) response.write(chunk);
      response.end();
    });
  }

  /** The issuer's OIDC discovery, as the Runtime's `discoveryUrl`; set once the issuer serves it. */
  trust(discoveryUrl: string): void {
    this.discoveryUrl = discoveryUrl;
    this.issuer = undefined;
  }

  private async admits(token: string, audience: string[]): Promise<boolean> {
    if (this.discoveryUrl === undefined) return false;
    const { issuer, keys } = await (this.issuer ??= discover(this.discoveryUrl));
    try {
      await jwtVerify(token, keys, { issuer, audience, algorithms: ['ES256'] });
      return true;
    } catch {
      return false;
    }
  }
}

async function discover(discoveryUrl: string): Promise<{ issuer: string; keys: JWTVerifyGetKey }> {
  const response = await fetch(discoveryUrl);
  if (!response.ok) throw new Error(`OIDC discovery ${discoveryUrl}: HTTP ${response.status}`);
  const { issuer, jwks_uri: jwksUri } = await response.json() as { issuer: string; jwks_uri: string };
  const local = new URL(new URL(jwksUri).pathname, discoveryUrl);
  return { issuer, keys: createRemoteJWKSet(local) };
}
