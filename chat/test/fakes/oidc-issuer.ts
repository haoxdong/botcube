import { OAuth2Server } from 'oauth2-mock-server';

/** The User a stand-in sign-in is for, unless the authorization request names another with `login_hint`. */
const STAND_IN_USER = 'ada';

/**
 * A stand-in OpenID Connect provider on this machine (oauth2-mock-server): discovery, JWKS, and an authorization
 * endpoint that signs the User in at once, as the `login_hint` its request names, and redirects back with a code.
 * Its ID tokens say the User authenticated just now, unless `authenticatedAt` names another time or none.
 */
export class StandInOidcIssuer {
  private readonly server = new OAuth2Server();
  private readonly users = new Map<string, string>();
  /** The `auth_time` each User's ID tokens carry, in seconds; undefined leaves the claim out. */
  readonly authenticatedAt = new Map<string, number | undefined>();
  /** The client secret each token request carried, by HTTP Basic or in its form, in order. */
  readonly clientSecrets: string[] = [];

  async listen(): Promise<this> {
    await this.server.issuer.keys.generate('RS256');
    this.server.service.on('beforeAuthorizeRedirect', ({ url }: { url: URL }, req: { url?: string }) => {
      const code = url.searchParams.get('code');
      const hint = new URL(req.url ?? '/', 'http://stand-in').searchParams.get('login_hint');
      if (code !== null) this.users.set(code, hint ?? STAND_IN_USER);
    });
    this.server.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }, req: { body?: Record<string, unknown> }) => {
      // Signed twice per code: the access token, then the ID token.
      const user = typeof req.body?.code === 'string' ? this.users.get(req.body.code) : undefined;
      if (user === undefined) return;
      const authTime = this.authenticatedAt.has(user) ? this.authenticatedAt.get(user) : Math.floor(Date.now() / 1000);
      Object.assign(token.payload, { sub: user, name: `Stand-in ${user}`, ...(authTime === undefined ? {} : { auth_time: authTime }) });
    });
    this.server.service.on('beforeResponse', (_: unknown, req: TokenRequest) => this.clientSecrets.push(clientSecret(req)));
    await this.server.start(0, '127.0.0.1');
    // oauth2-mock-server names a loopback issuer `localhost`, which can resolve to ::1, where it does not listen.
    this.server.issuer.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  get url(): string {
    const url = this.server.issuer.url;
    if (url === undefined) throw new Error('The stand-in OIDC issuer is not listening');
    return url;
  }

  close(): Promise<void> {
    return this.server.stop();
  }
}

interface TokenRequest {
  body?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
}

function clientSecret({ body, headers }: TokenRequest): string {
  const basic = /^Basic (.+)$/.exec(headers?.authorization ?? '')?.[1];
  if (basic) return decodeURIComponent(Buffer.from(basic, 'base64').toString('utf8').split(':')[1] ?? '');
  return typeof body?.client_secret === 'string' ? body.client_secret : '';
}
