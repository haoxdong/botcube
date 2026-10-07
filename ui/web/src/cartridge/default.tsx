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
    chatServiceUrl: 'http://localhost:8123',
    title: 'BotCube',
    agentName: 'BotCube',
    subtitle: 'How can I help you?',
    disclaimer: 'AI can make mistakes. Please check important information.',
    loginLabel: 'Connect',
    relinkLabel: 'Reconnect',
    logoutLabel: 'Log out',
    accountLabel: 'Account',
    agentOptions: {
      effortLevels: [{ key: 'medium', label: 'Medium' }],
      defaultEffort: 'medium',
    },
  },
  toolResultRenderers: [],
  auxiliaryPanels: [],
  AuthProvider: DefaultAuthProvider,
  theme: {},
};

