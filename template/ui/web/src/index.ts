import { TEMPLATE_IDENTITY } from '../../../identity';
import { TemplateAuthProvider, SignInsTab } from './auth-provider';
import { BrowserPanel } from './browser-panel';
import { BrowserView } from './browser-view';
import { ComputerView } from './computer-view';
import { CHAT_SERVICE_URL, config } from './config';
import { SiteDataResult } from './site-data-result';
import type { WebUiPlugin } from 'botcube-ui-web/cartridge';
import './styles.css';

export const webUiPlugin: WebUiPlugin = {
  config,
  toolResultRenderers: [SiteDataResult],
  auxiliaryPanels: [BrowserPanel],
  AuxiliaryView: BrowserView,
  ComputerView,
  AuthProvider: TemplateAuthProvider,
  agentProfileTabs: { 'Sign-ins': SignInsTab },
  fileUrl: async (path) => {
    if (!path.startsWith('/')) throw new Error('Agent file path must start with /');
    const name = decodeURIComponent(path.slice(1));
    const response = await fetch(`${CHAT_SERVICE_URL}/files/download-url?${new URLSearchParams({ name })}`, {
      method: 'GET', credentials: 'include',
    });
    if (!response.ok) throw new Error(`File download failed: ${response.status}`);
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('url' in payload) || typeof payload.url !== 'string') {
      throw new Error('File download returned no URL');
    }
    return payload.url;
  },
  theme: { ...TEMPLATE_IDENTITY.theme },
};
