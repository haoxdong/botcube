import { TEMPLATE_IDENTITY } from '../../../identity';
import type { WebUiPlugin } from 'botcube-ui-web/cartridge';

export const config: WebUiPlugin['config'] = {
  agentId: 'template',
  chatServiceUrl: 'http://localhost:8123',
  title: TEMPLATE_IDENTITY.name,
  agentName: TEMPLATE_IDENTITY.name,
  subtitle: 'A local agent built with BotCube.',
  disclaimer: 'This local template uses stand-ins for external services.',
  loginLabel: 'Connect',
  relinkLabel: 'Reconnect',
  logoutLabel: 'Reset',
  accountLabel: 'Account',
  agentOptions: {
    effortLevels: [{ key: 'medium', label: 'Medium' }],
    defaultEffort: 'medium',
  },
};

/** The Chat Service the page talks to, as the page itself resolves it. */
export const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_SERVICE_URL ?? config.chatServiceUrl;
