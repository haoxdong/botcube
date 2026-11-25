import { expect, it } from 'vitest';
import { agentTheme, BOT_SETTINGS } from './bot-settings';

it('is built with the bot settings its build names, checked by the seam file (the example bot here)', () => {
  expect(BOT_SETTINGS).toMatchObject({ agentIdentity: { name: 'BotCube', avatar: '🧊' }, writtenMemory: { enabled: true }, extractedMemory: { enabled: true }, agentComputer: { enabled: true, liveBrowser: true } });
});

it("paints the agent's four colours from the bot settings' theme", () => {
  expect(agentTheme({ agentBody: '#f5d0a9', agentOutline: '#d9915a', agentDeep: '#9a5a2b', agentDeepest: '#4a2810' })).toEqual({
    '--agent-body': '#f5d0a9',
    '--agent-outline': '#d9915a',
    '--agent-deep': '#9a5a2b',
    '--agent-deepest': '#4a2810',
  });
});

it("leaves BotCube's own colours without a theme", () => {
  expect(agentTheme(undefined)).toEqual({});
});
