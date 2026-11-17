import type { WebUiPlugin } from 'botcube-ui-web/cartridge';
import { BOT_SETTINGS } from 'botcube-ui-web/bot-settings';

export const config: WebUiPlugin['config'] = {
  agentId: 'template',
  title: BOT_SETTINGS.agentIdentity.name,
  agentName: BOT_SETTINGS.agentIdentity.name,
  subtitle: 'A local agent built with BotCube.',
  disclaimer: 'This local template uses stand-ins for external services.',
  loginLabel: 'Connect',
  relinkLabel: 'Reconnect',
  logoutLabel: 'Reset',
  accountLabel: 'Account',
};
