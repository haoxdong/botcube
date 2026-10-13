import { TEMPLATE_IDENTITY } from '../../../identity';
import { TemplateAuthProvider, SignInsTab } from './auth-provider';
import { BrowserPanel } from './browser-panel';
import { BrowserView } from './browser-view';
import { ComputerView } from './computer-view';
import { config } from './config';
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
  theme: { ...TEMPLATE_IDENTITY.theme },
};
