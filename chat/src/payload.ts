import { HttpError } from './http-error.js';
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

export const isRecord =(value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dropNulls = (value: unknown) =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)) : value;

/** A run input without the nulls its optional fields may carry, as the AG-UI schema refuses them. */
export function omitOptionalNulls(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const input = dropNulls(body) as Record<string, unknown>;
  for (const key of ['messages', 'tools', 'context']) {
    if (Array.isArray(input[key])) input[key] = input[key].map(dropNulls);
  }
  if (Array.isArray(input.messages)) {
    input.messages = input.messages.map((message: unknown) =>
      isRecord(message) && Array.isArray(message.toolCalls)
        ? { ...message, toolCalls: message.toolCalls.map(dropNulls) }
        : message,
    );
  }
  return input;
}
