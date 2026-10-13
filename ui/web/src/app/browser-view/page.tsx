import { webUiPlugin } from '@cartridge-ui';
import BrowserView from '../../computer/browser-view';

/** The pop-out window: the Cartridge's view, else BotCube's live browser view. */
export default function BrowserViewPage() {
  const AuxiliaryView = webUiPlugin.AuxiliaryView ?? BrowserView;
  return <AuxiliaryView />;
}
