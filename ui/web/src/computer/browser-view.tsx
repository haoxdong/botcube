"use client";


import { useEffect, useState } from 'react';
import { Arrives } from '../app/motion';

import { BrowserLiveFrame } from './browser-live-frame';

export default function BrowserViewPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSessionId(params.get('session_id')?.trim() || null);
  }, []);

  return (
    <main className="browser-view-page">
      <Arrives className="browser-view-content" state={sessionId ?? "missing"}>{sessionId ? (
        <BrowserLiveFrame
          key={`${sessionId}:${streamGeneration}`}
          sessionId={sessionId}
          onEnded={() => setStreamGeneration((generation) => generation + 1)}
        />
      ) : (
        <div className="browser-view-status browser-view-error">Missing browser session.</div>
      )}</Arrives>
    </main>
  );
}
