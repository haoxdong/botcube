import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SessionGate } from './session-gate';

const render = (status: 'loading' | 'parked' | 'error') =>
  renderToStaticMarkup(
    React.createElement(SessionGate, {
      title: 'Example Bot',
      agentName: 'Marq',
      status,
      chatServiceUrl: 'https://api.example.com',
      loadFailure: status === 'error' ? { error: 'Your account could not be loaded.', retry: () => {} } : undefined,
    }),
  );

describe('SessionGate', () => {
  it('shows the paused screen while production is parked', () => {
    const html = render('parked');
    expect(html).toContain('Example Bot is paused, back soon.');
    expect(html).not.toContain('could not be loaded');
  });

  it('says why the session failed, with a Retry', () => {
    const html = render('error');
    expect(html).toContain('Your account could not be loaded.');
    expect(html).toContain('>Retry</button>');
    expect(html).not.toContain('paused');
  });

  // A load goes blank, then the app's own loading view, then the chat; never a title screen between them.
  it("shows the app's loading view while the session loads, with nothing in it to use", () => {
    const html = render('loading');
    expect(html).toContain('aria-label="Loading Main Chat"');
    expect(html).toContain('<span class="chat-header-name"><span class="chat-header-label">Marq</span></span>');
    expect(html).toContain('<aside class="sidebar sidebar-collapsed" inert="">');
    expect(html).toContain('<header class="chat-header" inert="">');
    expect(html).not.toContain('welcome-title');
  });
});
