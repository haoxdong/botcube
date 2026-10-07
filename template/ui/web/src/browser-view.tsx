"use client";

import React, { useEffect, useState } from 'react';

import { liveViewUrl } from './computer';
import { CHAT_SERVICE_URL, config } from './config';
import { Screen } from './screen';

/** The pop-out window: one browser Session's live screen, filling the window, for its owner. */
export function BrowserView() {
  const [url, setUrl] = useState<string | null>(null);
  // Why the window shows no screen: still connecting, or what stopped it.
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session_id')?.trim();
    if (!sessionId) {
      setProblem('This window names no browser Session.');
      return;
    }
    let current = true;
    liveViewUrl(CHAT_SERVICE_URL, sessionId).then(
      (signed) => {
        if (!current) return;
        setUrl(signed);
      },
      (cause: Error) => current && setProblem(cause.message),
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <main className="template-browser-view">
      <Screen
        url={url}
        title={`${config.agentName}'s computer`}
        cover={
          <div className="template-screen-cover">
            {problem === null ? (
              <p className="template-screen-cover-detail" role="status">Connecting…</p>
            ) : (
              <p className="template-error" role="alert">{problem}</p>
            )}
          </div>
        }
        onAsleep={() => {
          setUrl(null);
          setProblem('The computer went to sleep. Wake it from the Computer tab, then pop it out again.');
        }}
        onError={(error) => {
          setUrl(null);
          setProblem(error);
        }}
      />
    </main>
  );
}
