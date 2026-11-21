import settings from '@bot-settings';
import type { BotSettings } from 'botcube-config';
import { parseBotSettings } from 'botcube-config/parse';
import type { CSSProperties } from 'react';

/**
 * The bot settings this page is built with (ADR 0091), checked by the seam file's schema: a bad file fails
 * the page at its first import, naming the field, like the Chat Service fails startup on it.
 */
export const BOT_SETTINGS: BotSettings = parseBotSettings(settings, 'The bot settings this page is built with');

/** The agent's four colours over the shell's tokens (`tokens.css`); without a theme, BotCube's own show. */
export function agentTheme(theme: BotSettings['theme']): CSSProperties {
  if (theme === undefined) return {};
  return {
    '--agent-body': theme.agentBody,
    '--agent-outline': theme.agentOutline,
    '--agent-deep': theme.agentDeep,
    '--agent-deepest': theme.agentDeepest,
  } as CSSProperties;
}

/** This bot's colours, as the page's layouts paint them. */
export const AGENT_THEME = agentTheme(BOT_SETTINGS.theme);
