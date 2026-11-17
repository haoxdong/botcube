"use client";

import { ExternalLink, X } from 'lucide-react';
import React, { useState } from 'react';
import type { AuxiliaryPanelHostProps } from '../cartridge/index.js';
import { chatServiceUrl } from '../cartridge/chat-service-url';

import { popOut, screenUrl } from './screenshots';
import { useLiveViewEvents } from './live-view-events';
import { Swap } from '../app/collapse';
import { Screen } from './screen';

const CHAT_SERVICE_URL = chatServiceUrl();

/**
 * The chat's live browser, floating over it while a Turn drives the Agent Computer. It closes when the browser
 * closes or sleeps, or when the user closes it; Pop out opens the same screen in its own window.
 */
export function LiveBrowserPanel({ agentId, conversation }: AuxiliaryPanelHostProps) {
  const [live, setLive] = useState<{ chat: string; sessionId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLiveViewEvents(agentId, (event) => {
    setError(null);
    setLive(event.open ? { chat: conversation.id, sessionId: event.sessionId } : null);
  });
  if (live === null || live.chat !== conversation.id) return null;

  return (
    <aside className="live-browser-panel" aria-label="Live browser">
      <Screen
        url={error === null ? screenUrl(CHAT_SERVICE_URL, conversation.id) : null}
        title="Live browser"
        cover={
          <Swap state={error === null ? 'connecting' : 'failed'} className="computer-screen-cover">
            {error === null ? <span className="computer-screen-spinner" role="status" aria-label="Connecting" /> : <p className="computer-screen-error" role="alert">{error}</p>}
          </Swap>
        }
        actions={
          <span className="computer-screen-actions">
            <button
              type="button"
              className="computer-screen-action"
              aria-label="Pop out"
              title="Pop out"
              onClick={() => popOut(live.sessionId)}
            >
              <ExternalLink aria-hidden="true" />
            </button>
            <button type="button" className="computer-screen-action" aria-label="Close live browser" title="Close" onClick={() => setLive(null)}>
              <X aria-hidden="true" />
            </button>
          </span>
        }
        onAsleep={() => setLive(null)}
        onError={setError}
      />
    </aside>
  );
}
