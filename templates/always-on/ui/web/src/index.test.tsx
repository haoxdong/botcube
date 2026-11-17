import { expect, describe, it } from 'vitest';
import { TemplateAuthProvider } from './auth-provider';
import { webUiPlugin } from './index';

describe('the template web UI plugin', () => {
  it('fills only its own config and sign-in, and leaves the rest to BotCube', () => {
    expect(webUiPlugin.config).toEqual({
      agentId: 'template',
      // The bot settings' Agent Identity name (examples/bot/bot.json).
      title: 'BotCube', agentName: 'BotCube',
      subtitle: 'A local agent built with BotCube.',
      disclaimer: 'This local template uses stand-ins for external services.',
      loginLabel: 'Connect', relinkLabel: 'Reconnect', logoutLabel: 'Reset', accountLabel: 'Account',
    });
    expect(Object.keys(webUiPlugin).sort()).toEqual(['AuthProvider', 'config']);
    expect(webUiPlugin.AuthProvider).toBe(TemplateAuthProvider);
  });
});
