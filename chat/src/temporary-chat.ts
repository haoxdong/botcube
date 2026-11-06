import { randomUUID } from 'node:crypto';
import { SignJWT, errors, jwtVerify } from 'jose';

export interface TemporaryChat {
  readonly sessionId: string;
  readonly token: string;
}

const AUDIENCE = 'botcube-temporary-chat';

export class TemporaryChats {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (!secret) throw new Error('Temporary chat signing key is not configured');
    this.key = new TextEncoder().encode(secret);
  }

  async issue(): Promise<TemporaryChat> {
    const sessionId = randomUUID();
    const token = await new SignJWT({}).setSubject(sessionId).setAudience(AUDIENCE).setIssuedAt()
      .setExpirationTime('24h').setProtectedHeader({ alg: 'HS256' }).sign(this.key);
    return { sessionId, token };
  }

  async owns(token: string | undefined, sessionId: string): Promise<boolean> {
    if (token === undefined) return false;
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'], audience: AUDIENCE });
      return payload.sub === sessionId;
    } catch (error) {
      if (error instanceof errors.JOSEError) return false;
      throw error;
    }
  }
}
