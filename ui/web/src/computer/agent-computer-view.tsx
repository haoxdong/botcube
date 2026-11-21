"use client";

import { lazy, Suspense } from 'react';
import type { ComputerViewProps } from '../plugin/index.js';
import { chatServiceUrl } from '../plugin/chat-service-url';
import { LoadingSkeleton } from '../app/load-state';

const ComputerView = lazy(() => import('./computer-view').then(({ ComputerView }) => ({ default: ComputerView })));
const CHAT_SERVICE_URL = chatServiceUrl();

/** The Computer tab: the open chat's Agent Computer, loaded when the tab first shows, when the bot settings switch it on. */
export function AgentComputerView(props: ComputerViewProps) {
  return <Suspense fallback={<LoadingSkeleton label="Agent Computer" />}><ComputerView {...props} chatServiceUrl={CHAT_SERVICE_URL} /></Suspense>;
}
