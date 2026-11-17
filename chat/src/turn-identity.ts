import { createHash, createPrivateKey, createPublicKey, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { Hono } from 'hono';
import { CHAT_SERVICE_SUBJECT, RESERVED_AUDIENCES, TOKEN_AUDIENCES, reservedAudienceError } from 'botcube-deployment-config';
import { SignJWT, type JWTPayload } from 'jose';
import { z } from 'zod';

/**
 * The per-Turn user identity (ADR 0067 §8): an ES256 JWT the Harness exchanges with STS
 * `AssumeRoleWithWebIdentity` for credentials of the Memory role, tagged with the Turn's actor,
 * filing actor and Session. AgentCore Identity and Gateway take the same token for Connectors.
 */

const LIFETIME_SECONDS = 3600;
/** A service token covers one call: long enough for clock skew, short enough that a leaked one soon dies. */
const SERVICE_TOKEN_SECONDS = 300;
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

function tagValue(name: string, value: string): string {
  if (!TAG_VALUE.test(value)) throw new Error(`The ${name} ${JSON.stringify(value.slice(0, 64))} is not a valid AWS session tag value`);
  return value;
}

/** What a Turn's Memory credentials may reach. Values keep to IAM's tag value rules, so none is an IAM wildcard or policy variable. */
export interface TurnScope {
  actorId: string;
  filingActorId: string;
  sessionId: string;
  writesPrefix: string;
}

export function turnScope(turn: TurnIdentityClaims): TurnScope {
  return {
    actorId: tagValue('actor ID', turn.actorId),
    filingActorId: tagValue('filing actor ID', turn.filingActorId),
    sessionId: tagValue('Session ID', turn.sessionId),
    writesPrefix: writesPrefix(turn.sessionId),
  };
}

/** What the Harness receives as `turnIdentity`, and the values a Turn's error text must not show. */
export interface TurnGrant {
  forwarded: string | Record<string, string>;
  secrets: string[];
}

/** How a Turn gets its User's Memory credentials: the Deployment Config's `turnCredentials` adapter. */
export interface TurnCredentialSource {
  grant(turn: TurnIdentityClaims): Promise<TurnGrant>;
}

export class TurnIdentity implements TurnCredentialSource {
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
    const principalTags = Object.fromEntries(Object.entries(turnScope(turn)).map(([key, value]) => [key, [value]]));
    return await new SignJWT({ [TAGS_CLAIM]: { principal_tags: principalTags } })
      .setProtectedHeader({ alg: 'ES256', kid: this.signing.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(TOKEN_AUDIENCES.turnIdentity)
      .setSubject(turn.actorId)
      .setIssuedAt(startedAt)
      .setExpirationTime(startedAt + LIFETIME_SECONDS)
      .setJti(randomUUID())
      .sign(this.signing.key);
  }

  /**
   * Any other token BotCube signs with these keys (the Harness bearer, a product's user token): ES256, `iss` this
   * issuer, and an audience naming what it is for, so one kind never passes for another. Never STS's audience, so it
   * buys no Memory credentials.
   */
  async signToken(token: { audience: string; subject: string; lifetimeSeconds: number; claims?: JWTPayload }): Promise<string> {
    if (token.audience === TOKEN_AUDIENCES.turnIdentity) throw new Error(`A service token cannot be for ${TOKEN_AUDIENCES.turnIdentity}`);
    const issuedAt = Math.floor(Date.now() / 1000);
    return await new SignJWT(token.claims ?? {})
      .setProtectedHeader({ alg: 'ES256', kid: this.signing.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(token.audience)
      .setSubject(token.subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + token.lifetimeSeconds)
      .setJti(randomUUID())
      .sign(this.signing.key);
  }

  /**
   * A short-lived token naming the Chat Service itself, for a service that trusts this issuer for `audience`: the
   * Harness's JWT authorizer.
   */
  async signServiceToken(audience: string): Promise<string> {
    if (RESERVED_AUDIENCES.includes(audience)) throw new Error(reservedAudienceError(audience));
    return await this.signToken({ audience, subject: CHAT_SERVICE_SUBJECT, lifetimeSeconds: SERVICE_TOKEN_SECONDS });
  }

  async grant(turn: TurnIdentityClaims): Promise<TurnGrant> {
    const token = await this.sign(turn);
    return { forwarded: token, secrets: [token] };
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
 * Hand the Harness this Turn's identity, never one the client sent, and answer its secrets for redaction.
 * A Chat Service without a Turn credentials source forwards none.
 */
export async function forwardTurnIdentity(source: TurnCredentialSource | null, forwardedProps: Record<string, unknown>, turn: TurnIdentityClaims): Promise<string[]> {
  delete forwardedProps.turnIdentity;
  if (source === null) return [];
  const { forwarded, secrets } = await source.grant(turn);
  forwardedProps.turnIdentity = forwarded;
  return secrets;
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
