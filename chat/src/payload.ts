import { HttpError } from './cartridge.js';
import type { Context } from 'hono';

/** An optional JSON-object body: no body is null. */
export async function jsonPayload(c: Context): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(422, 'Request body must be JSON');
  }
  if (parsed === null) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(422, 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Destructive account actions carry `{"confirmation": "<intent>"}`. */
export function requireExplicitConfirmation(payload: Record<string, unknown> | null, intent: string): void {
  if (payload?.confirmation !== intent) throw new HttpError(400, `Explicit ${intent} confirmation is required`);
}
