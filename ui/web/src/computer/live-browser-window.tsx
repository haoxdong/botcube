"use client";

import React, { useEffect, useState } from 'react';
import { Arrives } from '../app/motion';

import { chatServiceUrl } from '../plugin/chat-service-url';
import { liveViewUrl } from './screenshots';
import { Screen } from './screen';

const CHAT_SERVICE_URL = chatServiceUrl();

/** The live browser panel's pop-out window: one browser Session's live screen, filling the window, for its owner. */
export function LiveBrowserWindow({ agentName }: { agentName: string }) {
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
    <main className="live-browser-window">
      <Screen
        url={url}
        title={`${agentName}'s computer`}
        cover={
          <Arrives state={problem === null ? 'connecting' : 'failed'} className="computer-screen-cover">
            {problem === null ? (
              <p className="computer-screen-cover-detail" role="status">Connecting…</p>
            ) : (
              <p className="computer-screen-error" role="alert">{problem}</p>
            )}
          </Arrives>
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
