import type { AuthProviderProps, WebUiPlugin } from './types.js';

export function DefaultAuthProvider({ children }: AuthProviderProps) {
  return children({
    sessionStatus: 'ready',
    status: 'authed',
    error: null,
    login: () => {},
    relink: () => {},
    logout: () => {},
  });
}

export const webUiPlugin: WebUiPlugin = {
  config: {
    agentId: 'agent',
    title: 'BotCube',
    agentName: 'BotCube',
    subtitle: 'How can I help you?',
    disclaimer: 'AI can make mistakes. Please check important information.',
    loginLabel: 'Connect',
    relinkLabel: 'Reconnect',
    accountLabel: 'Account',
  },
  AuthProvider: DefaultAuthProvider,
};

