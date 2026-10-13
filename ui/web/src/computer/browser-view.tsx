"use client";

import { useEffect, useState } from 'react';

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
      {sessionId ? (
        <BrowserLiveFrame
          key={`${sessionId}:${streamGeneration}`}
          sessionId={sessionId}
          onEnded={() => setStreamGeneration((generation) => generation + 1)}
        />
      ) : (
        <div className="browser-view-status browser-view-error">Missing browser session.</div>
      )}
    </main>
  );
}
