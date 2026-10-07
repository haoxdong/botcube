import { webUiPlugin } from '@cartridge-ui';

export default function BrowserViewPage() {
  const AuxiliaryView = webUiPlugin.AuxiliaryView;
  return AuxiliaryView ? <AuxiliaryView /> : null;
}
