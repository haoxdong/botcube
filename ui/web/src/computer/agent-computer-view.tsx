"use client";

import { lazy, Suspense } from 'react';
import type { ComputerViewProps } from '../plugin/index.js';
import { chatServiceUrl } from '../plugin/chat-service-url';
import { LoadingSkeleton } from '../app/load-state';
import { idlePreload } from '../app/preload';

const loadComputerView = () => import('./computer-view');
const ComputerView = lazy(() => loadComputerView().then(({ ComputerView }) => ({ default: ComputerView })));
export const preloadComputerView = idlePreload(loadComputerView);
const CHAT_SERVICE_URL = chatServiceUrl();

/** The Computer tab: the open chat's Agent Computer, its code loaded once the page is idle, when the bot settings switch it on. */
export function AgentComputerView(props: ComputerViewProps) {
  return <Suspense fallback={<LoadingSkeleton label="Agent Computer" />}><ComputerView {...props} chatServiceUrl={CHAT_SERVICE_URL} /></Suspense>;
}
