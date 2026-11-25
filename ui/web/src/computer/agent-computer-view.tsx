"use client";

import { lazy, Suspense, useState } from 'react';
import type { ComputerViewProps } from '../plugin/index.js';
import { chatServiceUrl } from '../plugin/chat-service-url';
import { LoadingSkeleton } from '../app/load-state';
import { idlePreload } from '../app/preload';

let loaded: typeof import('./computer-view').ComputerView | undefined;
const loadComputerView = () => import('./computer-view').then((module) => ((loaded = module.ComputerView), module));
const ComputerView = lazy(() => loadComputerView().then(({ ComputerView }) => ({ default: ComputerView })));
export const preloadComputerView = idlePreload(loadComputerView);
const CHAT_SERVICE_URL = chatServiceUrl();

/** The Computer tab: the open chat's Agent Computer, its code loaded once the page is idle, when the bot settings switch it on. */
// Once its code is in, it mounts without suspending, so no skeleton shows while the profile slides in.
export function AgentComputerView(props: ComputerViewProps) {
  const [View] = useState(() => loaded ?? ComputerView);
  return <Suspense fallback={<LoadingSkeleton label="Agent Computer" />}><View {...props} chatServiceUrl={CHAT_SERVICE_URL} /></Suspense>;
}
