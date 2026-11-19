import { HttpError } from './http-error.js';
import type { Requester } from './requester.js';

/** Rejects a candidate prompt unless the requester tunes prompts and the prompt is text. */
export function requireCandidatePrompts(forwardedProps: Record<string, unknown> | undefined, requester: Requester, bot: { tunesPrompts?(requester: Requester): boolean }): void {
  for (const prop of ['agentSystemPrompt', 'botSystemPrompt', 'cartridgeSystemPrompt']) {
    const candidate = forwardedProps?.[prop];
    if (candidate === undefined) continue;
    if (bot.tunesPrompts?.(requester) !== true) throw new HttpError(403, `${prop} is only for the prompt tuner`);
    if (typeof candidate !== 'string') throw new HttpError(422, `${prop} must be text`);
  }
}

/**
 * A deployed client sends the candidate bot prompt as `cartridgeSystemPrompt`, and a deployed Harness reads only that
 * name: forward either under both until both read `botSystemPrompt`.
 */
export function aliasBotSystemPrompt(forwardedProps: Record<string, unknown>): void {
  const botSystemPrompt = forwardedProps.botSystemPrompt ?? forwardedProps.cartridgeSystemPrompt;
  if (botSystemPrompt !== undefined) Object.assign(forwardedProps, { botSystemPrompt, cartridgeSystemPrompt: botSystemPrompt });
}
