"use client";

import { ExternalLink, X } from 'lucide-react';
import React, { useState } from 'react';
import type { AuxiliaryPanelHostProps } from 'botcube-ui-web/cartridge';

import { popOut, screenUrl } from './computer';
import { CHAT_SERVICE_URL } from './config';
import { useLiveViewEvents } from './live-view-events';
import { Screen } from './screen';

/**
 * The chat's live browser, floating over it while a Turn drives the Agent Computer. It closes when the browser
 * closes or sleeps, or when the user closes it; Pop out opens the same screen in its own window.
 */
export function BrowserPanel({ agentId, conversation }: AuxiliaryPanelHostProps) {
  const [live, setLive] = useState<{ chat: string; sessionId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLiveViewEvents(agentId, (event) => {
    setError(null);
    setLive(event.open ? { chat: conversation.id, sessionId: event.sessionId } : null);
  });
  if (live === null || live.chat !== conversation.id) return null;

  return (
    <aside className="template-browser-panel" aria-label="Live browser">
      <Screen
        url={error === null ? screenUrl(CHAT_SERVICE_URL, conversation.id) : null}
        title="Live browser"
        cover={
          <div className="template-screen-cover">
            {error === null ? <span className="template-screen-spinner" role="status" aria-label="Connecting" /> : <p className="template-error" role="alert">{error}</p>}
          </div>
        }
        actions={
          <span className="template-screen-actions">
            <button
              type="button"
              className="template-screen-action"
              aria-label="Pop out"
              title="Pop out"
              onClick={() => popOut(live.sessionId)}
            >
              <ExternalLink aria-hidden="true" />
            </button>
            <button type="button" className="template-screen-action" aria-label="Close live browser" title="Close" onClick={() => setLive(null)}>
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
