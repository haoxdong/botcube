import { createHash, createPrivateKey, createPublicKey, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { z } from 'zod';

/**
 * The per-Turn user identity (ADR 0067 §8): an ES256 JWT the Harness exchanges with STS
 * `AssumeRoleWithWebIdentity` for credentials of the Memory role, tagged with the Turn's actor,
 * filing actor and Session. AgentCore Identity and Gateway take the same token for Connectors.
 */

/** The audience the IAM OIDC provider trusts: STS's own, as EKS service accounts and GitHub Actions use. */
const TURN_IDENTITY_AUDIENCE = 'sts.amazonaws.com';
const LIFETIME_SECONDS = 3600;
const TAGS_CLAIM = 'https://aws.amazon.com/tags';
const JWKS_PATH = '/.well-known/jwks.json';
/** IAM's tag value rules: at most 256 letters, digits, spaces and `_.:/=+-@`. */
const TAG_VALUE = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]{1,256}$/u;

export interface TurnIdentityConfig {
  /** The Chat Service's public origin, registered as the IAM OIDC provider's URL. */
  issuer: string;
  /** Private P-256 JWKs: the first signs, and all are published, so a new `kid` can sit beside the old one. */
  keys: JsonWebKey[];
}

export interface TurnIdentityClaims {
  /** The current account's actor. */
  actorId: string;
  /** The Session's immutable filing user ID. */
  filingActorId: string;
  sessionId: string;
  /** The Turn's start (ISO 8601): the token expires an hour later. */
  startedAt: string;
}

const KEYS_ERROR = 'BOTCUBE_TURN_IDENTITY_KEYS must be a JSON list of private P-256 JWKs, each with a kid';
const privateKeys = z.array(z.object({
  kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string(), d: z.string(), kid: z.string().min(1),
}).passthrough()).min(1);

/** The Turn identity configuration, or undefined when the Chat Service has no keys. */
export function turnIdentityConfigFromEnv(env: NodeJS.ProcessEnv): TurnIdentityConfig | undefined {
  if (env.BOTCUBE_TURN_IDENTITY_KEYS === undefined) return undefined;
  const origin = env.BOTCUBE_PUBLIC_ORIGIN?.replace(/\/+$/, '') ?? '';
  if (!URL.canParse(origin) || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) {
    throw new Error('BOTCUBE_PUBLIC_ORIGIN must be an https origin');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.BOTCUBE_TURN_IDENTITY_KEYS);
  } catch {
    // JSON.parse quotes the malformed input, which is private key material.
    throw new Error(KEYS_ERROR);
  }
  const keys = privateKeys.safeParse(parsed);
  if (!keys.success) throw new Error(KEYS_ERROR);
  if (new Set(keys.data.map((key) => key.kid)).size !== keys.data.length) throw new Error('BOTCUBE_TURN_IDENTITY_KEYS repeats a kid');
  return { issuer: origin, keys: keys.data };
}

/** The snapshot checkpointer's writes-session prefix for a Session, without its trailing dash. */
function writesPrefix(sessionId: string): string {
  return `lgw-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}

function tagValue(name: string, value: string): string[] {
  if (!TAG_VALUE.test(value)) throw new Error(`The ${name} ${JSON.stringify(value.slice(0, 64))} is not a valid AWS session tag value`);
  return [value];
}

export class TurnIdentity {
  private readonly issuer: string;
  private readonly signing: { kid: string; key: KeyObject };
  private readonly published: JsonWebKey[];

  constructor(config: TurnIdentityConfig) {
    this.issuer = config.issuer;
    const keys = config.keys.map((jwk) => ({ kid: jwk.kid as string, key: createPrivateKey({ key: jwk, format: 'jwk' }) }));
    this.signing = keys[0] as { kid: string; key: KeyObject };
    this.published = keys.map(({ kid, key }) => ({ ...createPublicKey(key).export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }));
  }

  async sign(turn: TurnIdentityClaims): Promise<string> {
    const startedAt = Math.floor(Date.parse(turn.startedAt) / 1000);
    if (!Number.isFinite(startedAt)) throw new Error('The Turn start is not a timestamp');
    const principalTags = {
      actorId: tagValue('actor ID', turn.actorId),
      filingActorId: tagValue('filing actor ID', turn.filingActorId),
      sessionId: tagValue('Session ID', turn.sessionId),
      writesPrefix: [writesPrefix(turn.sessionId)],
    };
    return await new SignJWT({ [TAGS_CLAIM]: { principal_tags: principalTags } })
      .setProtectedHeader({ alg: 'ES256', kid: this.signing.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(TURN_IDENTITY_AUDIENCE)
      .setSubject(turn.actorId)
      .setIssuedAt(startedAt)
      .setExpirationTime(startedAt + LIFETIME_SECONDS)
      .setJti(randomUUID())
      .sign(this.signing.key);
  }

  /** The OIDC discovery document IAM reads from `<issuer>/.well-known/openid-configuration`. */
  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      jwks_uri: `${this.issuer}${JWKS_PATH}`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      claims_supported: ['iss', 'sub', 'aud', 'iat', 'exp', 'jti', TAGS_CLAIM],
    };
  }

  jwks(): { keys: JsonWebKey[] } {
    return { keys: this.published };
  }
}

/**
 * Hand the Harness this Turn's identity, never one the client sent, and answer it for redaction.
 * A Chat Service without keys forwards none.
 */
export async function forwardTurnIdentity(identity: TurnIdentity | null, forwardedProps: Record<string, unknown>, turn: TurnIdentityClaims): Promise<string | undefined> {
  delete forwardedProps.turnIdentity;
  if (identity === null) return undefined;
  const token = await identity.sign(turn);
  forwardedProps.turnIdentity = token;
  return token;
}

/**
 * STS fetches these to validate Turn tokens, which can take seconds. A key rotation waits out this lifetime between
 * publishing a new `kid` and signing with it.
 */
const ISSUER_CACHE = { 'Cache-Control': 'public, max-age=300' };

export function turnIdentityRoutes(identity: TurnIdentity): Hono {
  const app = new Hono();
  app.get('/.well-known/openid-configuration', (c) => c.json(identity.discovery(), 200, ISSUER_CACHE));
  app.get(JWKS_PATH, (c) => c.json(identity.jwks(), 200, ISSUER_CACHE));
  return app;
}
