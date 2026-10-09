"use client";

import type { ComputerViewProps } from 'botcube-ui-web/cartridge';
import { useCopilotKit } from '@copilotkit/react-core/v2/headless';
import { useCallback, useEffect, useRef } from 'react';

/** The CUSTOM event the template Chat Service sends when a Turn opens or closes the agent's browser. */
const BROWSER_EVENT = 'botcube:browser-live-view';

export type LiveViewEvent = { open: true; sessionId: string } | { open: false };

function liveView(value: unknown): LiveViewEvent {
  if (typeof value === 'object' && value !== null && 'open' in value) {
    if (value.open === false) return { open: false };
    if (value.open === true && 'sessionId' in value && typeof value.sessionId === 'string') return { open: true, sessionId: value.sessionId };
  }
  throw new Error('The browser live-view event is malformed');
}

type Subscribe = ComputerViewProps['activity']['subscribeToCustomEvents'];

export function useComputerLiveViewEvents(subscribe: Subscribe, onEvent: (event: LiveViewEvent) => void) {
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => subscribe((event) => {
    if (event.name === BROWSER_EVENT) latest.current(liveView(event.value));
  }), [subscribe]);
}

/** Calls `onEvent` with each browser live-view event the open chat's Turns send. */
export function useLiveViewEvents(agentId: string, onEvent: (event: LiveViewEvent) => void) {
  const { copilotkit } = useCopilotKit();
  const subscribe = useCallback<Subscribe>((listener) => {
    const agent = copilotkit.getAgent(agentId);
    if (!agent) throw new Error(`The page has no agent ${agentId} to watch for its browser`);
    const subscription = agent.subscribe({ onCustomEvent: ({ event }) => listener(event) });
    return () => subscription.unsubscribe();
  }, [agentId, copilotkit]);
  useComputerLiveViewEvents(subscribe, onEvent);
}
