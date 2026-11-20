import { HttpError } from './http-error.js';
import type { Requester } from './requester.js';

/** Rejects a candidate prompt unless the requester tunes prompts and the prompt is text. */
export function requireCandidatePrompts(forwardedProps: Record<string, unknown> | undefined, requester: Requester, bot: { tunesPrompts?(requester: Requester): boolean }): void {
  for (const prop of ['agentSystemPrompt', 'botSystemPrompt']) {
    const candidate = forwardedProps?.[prop];
    if (candidate === undefined) continue;
    if (bot.tunesPrompts?.(requester) !== true) throw new HttpError(403, `${prop} is only for the prompt tuner`);
    if (typeof candidate !== 'string') throw new HttpError(422, `${prop} must be text`);
  }
}
