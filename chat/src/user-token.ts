import { TOKEN_AUDIENCES } from 'botcube-deployment-config';
import { Hono, type Context } from 'hono';
import type { TurnIdentity } from './turn-identity.js';

export const USER_TOKEN_AUDIENCE = TOKEN_AUDIENCES.user;
const USER_TOKEN_SECONDS = 600;
// A Turn's own lifetime, as its Turn identity token has (turn-identity.ts).
const TURN_USER_TOKEN_SECONDS = 3600;

/** The user token's signer: the Turn identity keys. */
export type UserTokenSigner = Pick<TurnIdentity, 'signToken'>;

/**
 * `GET /account/user-token`: the requester's signed user token, for a product's own service to verify against
 * BotCube's JWKS, signed with the Turn identity keys (`TurnIdentity.signToken`). `sub` is the account ID and
 * `anonymous` whether the User has not signed in.
 */
export function userTokenRoutes(issuer: Pick<TurnIdentity, 'signToken'>, requester: (c: Context) => Promise<{ owner: string; anonymous?: boolean }>): Hono {
  const app = new Hono();
  app.get('/account/user-token', async (c) => {
    const { owner, anonymous } = await requester(c);
    const token = await issuer.signToken({ audience: USER_TOKEN_AUDIENCE, subject: owner, lifetimeSeconds: USER_TOKEN_SECONDS, claims: { anonymous: anonymous === true } });
    c.header('Cache-Control', 'no-store');
    return c.json({ token, expiresIn: USER_TOKEN_SECONDS });
  });
  return app;
}

/**
 * Hand the Harness the Turn's signed user token as `forwardedProps.userToken`, never one the client sent, and answer it
 * for redaction. The bot's own tools call the product's service with it as the User (ADR 0091); `threadId` names the
 * Turn's Session for that service's audit. A Chat Service without Turn identity keys forwards none.
 */
export async function forwardUserToken(
  signer: UserTokenSigner | null, forwardedProps: Record<string, unknown>, user: { owner: string; anonymous?: boolean | undefined; threadId: string },
): Promise<string[]> {
  delete forwardedProps.userToken;
  if (signer === null) return [];
  const token = await signer.signToken({
    audience: USER_TOKEN_AUDIENCE, subject: user.owner, lifetimeSeconds: TURN_USER_TOKEN_SECONDS,
    claims: { anonymous: user.anonymous === true, threadId: user.threadId },
  });
  forwardedProps.userToken = token;
  return [token];
}
