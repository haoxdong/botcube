import type { z } from 'zod';
import { botSettings, type BotSettings } from 'botcube-config';

// Parsing without the file system, so a browser bundle can check the bot settings it was built with.

/** Bot settings a bot bundles, checked against the seam file's schema; `source` names them in the error. */
export function parseBotSettings(value: unknown, source: string): BotSettings {
  return parsed(botSettings, value, source);
}

export class BotCubeConfigError extends Error {
  override name = 'BotCubeConfigError';
}

export function parsed<Schema extends z.ZodType>(schema: Schema, value: unknown, source: string): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new BotCubeConfigError(result.error.issues.flatMap((issue) => fields(issue).map((field) => `${source}: ${field}: ${message(issue, value)}`)).join('\n'));
}

/** The issue's message; a key its object leaves out reads as JSON Schema's `required` does, as the Python loader's error does. */
function message(issue: z.core.$ZodIssue, value: unknown): string {
  const key = issue.path.at(-1);
  const parent = issue.path.slice(0, -1).reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), value);
  const missing = issue.code === 'invalid_type' && typeof key === 'string' && isRecord(parent) && !Array.isArray(parent) && !Object.hasOwn(parent, key);
  return missing ? `'${key}' is a required property` : issue.message;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === 'object' && value !== null;

function fields(issue: z.core.$ZodIssue): string[] {
  const at = (path: readonly PropertyKey[]) => path.map(String).join('.') || '(root)';
  return issue.code === 'unrecognized_keys' ? issue.keys.map((key) => at([...issue.path, key])) : [at(issue.path)];
}
