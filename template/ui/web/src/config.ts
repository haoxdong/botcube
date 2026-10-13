import { TEMPLATE_IDENTITY } from '../../../identity';
import type { WebUiPlugin } from 'botcube-ui-web/cartridge';
import { chatServiceUrl } from 'botcube-ui-web/chat-service-url';

export const config: WebUiPlugin['config'] = {
  agentId: 'template',
  title: TEMPLATE_IDENTITY.name,
  agentName: TEMPLATE_IDENTITY.name,
  subtitle: 'A local agent built with BotCube.',
  disclaimer: 'This local template uses stand-ins for external services.',
  loginLabel: 'Connect',
  relinkLabel: 'Reconnect',
  logoutLabel: 'Reset',
  accountLabel: 'Account',
};

/** The Chat Service the page talks to, as the page itself resolves it. */
export const CHAT_SERVICE_URL = chatServiceUrl();
