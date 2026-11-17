import { webUiPlugin } from '@cartridge-ui';
import { BOT_SETTINGS } from '../../bot-settings';
import BrowserView from '../../computer/browser-view';
import { LiveBrowserWindow } from '../../computer/live-browser-window';

/** The pop-out window: the live browser panel's, when the bot settings switch the panel on, else BotCube's live browser view. */
export default function BrowserViewPage() {
  return BOT_SETTINGS.agentComputer.liveBrowser ? <LiveBrowserWindow agentName={webUiPlugin.config.agentName} /> : <BrowserView />;
}
