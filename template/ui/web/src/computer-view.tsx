"use client";

import { Button, StatusPill } from 'botcube-ui-web/ui';
import { ExternalLink, Moon } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { ComputerViewProps } from 'botcube-ui-web/cartridge';

import { ChatNotStarted, loadComputer, popOut, screenUrl, wakeComputer, type Computer } from './computer';
import { CHAT_SERVICE_URL } from './config';
import { useLiveViewEvents } from './live-view-events';
import { Screen } from './screen';

type Phase =
  | { name: 'loading' }
  | { name: 'starting' }
  | { name: 'not started'; notice: string }
  | { name: 'failed'; error: string }
  | { name: 'ready'; computer: Computer };

const STATUS: Record<Exclude<Phase['name'], 'ready'>, string> = {
  loading: 'Checking',
  starting: 'Starting',
  'not started': 'Asleep',
  failed: 'Unavailable',
};

/** What the screen shows while it has no frame: the look or wake in progress, or why it is asleep. */
function Cover({ phase, agentName }: { phase: Phase; agentName: string }) {
  if (phase.name === 'starting' || phase.name === 'loading') {
    return (
      <div className="template-screen-cover" role="status">
        <span className="template-screen-spinner" aria-hidden="true" />
        <p className="template-screen-cover-title">{phase.name === 'starting' ? 'Starting the computer…' : 'Looking at the computer…'}</p>
      </div>
    );
  }
  return (
    <div className="template-screen-cover" role="status">
      <Moon className="template-screen-cover-icon" aria-hidden="true" />
      <p className="template-screen-cover-detail">
        {phase.name === 'not started' ? phase.notice : `${agentName}'s browser sleeps after ten idle minutes. Wake it to look again.`}
      </p>
    </div>
  );
}

/**
 * The Computer tab: the open chat's browser, live while it is awake. Showing the tab wakes a sleeping computer once;
 * one that falls asleep under the open tab stays asleep until the user wakes it.
 */
export function ComputerView({ agentId, agentName, conversation, shown }: ComputerViewProps) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  // Each showing of the tab, or a chat the tab moved to, looks at the computer afresh.
  const [showing, setShowing] = useState({ chat: conversation.id, shown, count: 0 });
  if (showing.chat !== conversation.id || showing.shown !== shown) {
    setShowing({ chat: conversation.id, shown, count: showing.count + (shown ? 1 : 0) });
  }

  const run = (wake: boolean) => {
    let current = true;
    const show = (next: Phase) => current && setPhase(next);
    show(wake ? { name: 'starting' } : { name: 'loading' });
    (wake ? wakeComputer : loadComputer)(CHAT_SERVICE_URL, conversation.id)
      .then((computer) => {
        // Shown asleep, the tab wakes it: opening the Computer tab is asking to see it.
        if (wake || computer.state === 'awake') return computer;
        show({ name: 'starting' });
        return wakeComputer(CHAT_SERVICE_URL, conversation.id);
      })
      .then(
        (computer) => show({ name: 'ready', computer }),
        (cause: Error) => show(cause instanceof ChatNotStarted ? { name: 'not started', notice: cause.message } : { name: 'failed', error: cause.message }),
      );
    return () => {
      current = false;
    };
  };

  useEffect(
    () => (shown ? run(false) : undefined),
    // Stryker disable next-line ArrayDeclaration: `run` is a fresh closure each render; the showing names the look
    [showing.chat, showing.count],
  );

  // A Turn that starts the browser wakes it under the open tab.
  useLiveViewEvents(agentId, (event) => {
    if (event.open && shown) setPhase({ name: 'ready', computer: { state: 'awake', browserSessionId: event.sessionId } });
  });

  const awake = phase.name === 'ready' && phase.computer.state === 'awake' ? phase.computer : null;
  const busy = phase.name === 'starting' || phase.name === 'loading' || phase.name === 'not started';
  return (
    <section className="template-computer" aria-label="Agent Computer">
      <Screen
        url={awake && shown ? screenUrl(CHAT_SERVICE_URL, conversation.id) : null}
        title={`${agentName}'s computer`}
        cover={<Cover phase={phase} agentName={agentName} />}
        onAsleep={() => setPhase({ name: 'ready', computer: { state: 'asleep' } })}
        onError={(error) => setPhase({ name: 'failed', error })}
      />
      <div className="template-computer-bar">
        <StatusPill tone={awake ? 'blue' : 'neutral'}>{awake ? 'Awake' : phase.name === 'ready' ? 'Asleep' : STATUS[phase.name]}</StatusPill>
        <span className="template-computer-driver">{awake ? `${agentName} is driving` : 'Nobody is driving'}</span>
        {awake ? (
          <Button type="button" onClick={() => popOut(awake.browserSessionId)}>
            <ExternalLink aria-hidden="true" />
            Pop out
          </Button>
        ) : (
          <Button type="button" disabled={busy} onClick={() => void run(phase.name !== 'failed')}>
            {phase.name === 'failed' ? 'Retry' : 'Wake'}
          </Button>
        )}
      </div>
      {phase.name === 'failed' && <p className="template-error" role="alert">{phase.error}</p>}
    </section>
  );
}
