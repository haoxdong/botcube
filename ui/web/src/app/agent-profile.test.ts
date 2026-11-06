import React from 'react';
import { within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentProfile } from './agent-profile';

const IDENTITY_TAB = { chatServiceUrl: 'http://chat.test', revision: 0, onSaved: () => {}, onOpenChat: () => {} };

const render = (props: Parameters<typeof AgentProfile>[0]) => renderToStaticMarkup(React.createElement(AgentProfile, props));

/** The profile's first render, as a DOM to query. */
const mount = (props: Parameters<typeof AgentProfile>[0]) => {
  const container = document.createElement('div');
  container.innerHTML = render(props);
  return container;
};

describe('AgentProfile', () => {
  it('shows the five tabs as labelled icons with tooltips, opening on the Computer', () => {
    const profile = mount({
      profile: { name: 'Ada Bot', avatar: '', picture: null, status: 'online' },
      error: null,
      computer: () => React.createElement('div'),
      onClose: () => {},
      ...IDENTITY_TAB,
    });

    const tabs = within(profile).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Activity', 'Sign-ins', 'Computer', 'Scheduled', 'Personalization']);
    for (const tab of tabs) {
      expect(tab).toHaveTextContent(/^$/);
      expect(tab.querySelector('svg')).not.toBeNull();
      expect(tab.getAttribute('title')).toBe(tab.getAttribute('aria-label'));
    }
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false', 'false']);
  });

  it('opens on the Activity for a bot with no Agent Computer', () => {
    const profile = mount({ profile: { name: 'Ada Bot', avatar: '', picture: null, status: 'online' }, error: null, onClose: () => {}, ...IDENTITY_TAB });

    expect(within(profile).getByRole('tab', { selected: true })).toHaveAccessibleName('Activity');
  });

  it('shows an offline agent as not connected', () => {
    const profile = mount({ profile: { name: 'Ada Bot', avatar: '', picture: null, status: 'offline' }, error: null, onClose: () => {}, ...IDENTITY_TAB });

    expect(profile.querySelector('.agent-profile-status')).toHaveTextContent(/^Not connected$/);
    expect(profile.querySelector('.agent-profile-status')).toHaveClass('agent-profile-status-offline');
  });
});
