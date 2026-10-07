import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SessionGate } from './session-gate';

const render = (status: 'loading' | 'parked' | 'error') =>
  renderToStaticMarkup(
    React.createElement(SessionGate, {
      title: 'Example Bot',
      status,
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

  it('shows only the title while the session loads', () => {
    expect(render('loading')).toBe('<div class="account-session-gate"><h1 class="welcome-title">Example Bot</h1></div>');
  });
});
