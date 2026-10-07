import React from 'react';
import { within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentProfile, loadAgentProfile } from './agent-profile';

describe('loadAgentProfile', () => {
  it("reads the agent's name and connection status from the Chat Service", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ name: 'Ada Bot', avatar: '', picture: null, status: 'online' }));

    const profile = await loadAgentProfile({ chatServiceUrl: 'http://chat.test', fetchImpl });

    expect(profile).toEqual({ name: 'Ada Bot', avatar: '', picture: null, status: 'online' });
    expect(fetchImpl).toHaveBeenCalledWith('http://chat.test/agent', { credentials: 'include', cache: 'no-store' });
  });

  it('fails loud when the Chat Service refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));

    await expect(loadAgentProfile({ chatServiceUrl: 'http://chat.test', fetchImpl })).rejects.toThrow(
      'Agent profile failed: 503',
    );
  });
});

const IDENTITY_TAB = { chatServiceUrl: 'http://chat.test', revision: 0, onSaved: () => {} };

const render = (props: Parameters<typeof AgentProfile>[0]) => renderToStaticMarkup(React.createElement(AgentProfile, props));

/** The profile's first render, as a DOM to query. */
const mount = (props: Parameters<typeof AgentProfile>[0]) => {
  const container = document.createElement('div');
  container.innerHTML = render(props);
  return container;
};

describe('AgentProfile', () => {
  it("shows the agent's large avatar, its name, and that it is connected", () => {
    const profile = mount({ profile: { name: 'Ada Bot', avatar: '', picture: null, status: 'online' }, error: null, onClose: () => {}, ...IDENTITY_TAB });

    const avatar = profile.querySelector<HTMLElement>('.agent-profile-header .avatar');
    expect(avatar).toHaveClass('avatar-agent');
    expect(avatar?.querySelector('.avatar-monocle')).not.toBeNull();
    expect([avatar?.style.width, avatar?.style.height]).toEqual(['96px', '96px']);
    expect(within(profile).getByRole('heading', { name: 'Ada Bot' })).toHaveClass('agent-profile-name');
    expect(profile.querySelector('.agent-profile-status')).toHaveTextContent(/^Connected$/);
    expect(profile.querySelector('.agent-profile-status')).toHaveClass('agent-profile-status-online');
  });

  it('shows the five tabs as labelled icons with tooltips, opening on the Computer', () => {
    const profile = mount({
      profile: { name: 'Ada Bot', avatar: '', picture: null, status: 'online' },
      error: null,
      computer: () => React.createElement('div'),
      onClose: () => {},
      ...IDENTITY_TAB,
    });

    const tabs = within(profile).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Activity', 'Sign-ins', 'Computer', 'Scheduled', 'Identity']);
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

  it('says why the profile could not load', () => {
    const html = render({ profile: null, error: 'Agent profile failed: 503', onClose: () => {}, ...IDENTITY_TAB });

    expect(html).toContain('<p class="agent-profile-error">Agent profile failed: 503</p>');
    expect(html).not.toContain('agent-profile-status');
  });
});
