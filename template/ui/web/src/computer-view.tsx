"use client";

import type { ComputerViewProps } from 'botcube-ui-web/cartridge';
import { ComputerView as BotCubeComputerView } from 'botcube-ui-web/computer';
import { ScreenshotBrowserFrame } from './screenshot-browser-frame';
import { CHAT_SERVICE_URL } from './config';

export function ComputerView(props: ComputerViewProps) {
  return <BotCubeComputerView {...props} chatServiceUrl={CHAT_SERVICE_URL} BrowserFrame={ScreenshotBrowserFrame} />;
}
