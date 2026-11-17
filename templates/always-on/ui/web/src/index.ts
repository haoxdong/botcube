import { TemplateAuthProvider } from './auth-provider';
import { config } from './config';
import type { WebUiPlugin } from 'botcube-ui-web/cartridge';
import './styles.css';

// The template's own sign-in; BotCube builds in the Sign-ins tab, the Agent Computer and its live browser.
export const webUiPlugin: WebUiPlugin = {
  config,
  AuthProvider: TemplateAuthProvider,
};
