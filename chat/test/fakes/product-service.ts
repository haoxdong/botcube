// A product's own service, outside BotCube: it knows only BotCube's issuer and JWKS URL, and answers
// `GET /whoami` with the account a signed user token names, or 401. Run: node product-service.ts (env below).
import { createServer } from 'node:http';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

const { BOTCUBE_PUBLIC_ORIGIN = '', BOTCUBE_JWKS_URL = '', PORT = '0' } = process.env;
const jwks = createRemoteJWKSet(new URL(BOTCUBE_JWKS_URL));

const server = createServer((request, response) => {
  const reply = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  if (request.url !== '/whoami' || token === undefined) {
    reply(token === undefined ? 401 : 404, { detail: 'Send a BotCube user token' });
    return;
  }
  jwtVerify(token, jwks, { issuer: BOTCUBE_PUBLIC_ORIGIN, audience: 'botcube-user', algorithms: ['ES256'] }).then(
    ({ payload }) => reply(200, { accountId: payload.sub, anonymous: payload.anonymous }),
    (error: unknown) => (error instanceof errors.JOSEError ? reply(401, { detail: error.code }) : reply(500, { detail: String(error) })),
  );
});
server.listen(Number(PORT), '0.0.0.0', () => console.log(`Product service listening on :${PORT}`));
