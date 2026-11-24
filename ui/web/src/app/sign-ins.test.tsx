// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { SignIn } from '../plugin/types';
import { loadSignIns, SignInsList, SignInsTab } from './sign-ins';

const site = (status: SignIn['status'], username: string | null): SignIn => ({
  site: 'example',
  name: 'Example site',
  status,
  username,
});

/** The classes of the status Badge that reads `label`. */
const badgeClasses = (html: string, label: string) =>
  html.match(new RegExp(`<span[^>]*data-slot="badge"[^>]*>${label}</span>`))?.[0].match(/class="([^"]*)"/)?.[1]?.split(' ');

describe('loadSignIns', () => {
  it("reads the account's Sign-ins from the Chat Service", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ signIns: [site('linked', 'ann@example.com')] }));

    const signIns = await loadSignIns({ chatServiceUrl: 'http://chat.test', fetchImpl });

    expect(signIns).toEqual([{ site: 'example', name: 'Example site', status: 'linked', username: 'ann@example.com' }]);
    expect(fetchImpl).toHaveBeenCalledWith('http://chat.test/account/sign-ins', {
      credentials: 'include',
      cache: 'no-store',
    });
  });

  it("fails loud with the Chat Service's reason", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ detail: 'Credential Service status failed with HTTP 500' }, { status: 502 }),
    );

    await expect(loadSignIns({ chatServiceUrl: 'http://chat.test', fetchImpl })).rejects.toThrow(
      'Credential Service status failed with HTTP 500',
    );
  });
});

const render = (props: Partial<Parameters<typeof SignInsList>[0]>) =>
  renderToStaticMarkup(
    React.createElement(SignInsList, {
      signIns: [],
      error: null,
      busy: false,
      onSignIn: () => {},
      onSignOut: () => {},
      ...props,
    }),
  );
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]+)</g)].map((match) => match[1]);

describe('SignInsList', () => {
  it('offers Sign out for a linked site, under its username', () => {
    const html = render({ signIns: [site('linked', 'ann@example.com')] });

    expect(html).toContain('<span class="sign-in-name">Example site</span>');
    expect(html).toContain('<div class="sign-in-username">ann@example.com</div>');
    expect(badgeClasses(html, 'Linked')).toEqual(expect.arrayContaining(['bg-secondary', 'sign-in-status']));
    expect(buttons(html)).toEqual(['Sign out']);
    expect(html).not.toContain('role="alert"');
  });

  it('offers Re-link and Sign out when the site needs re-linking', () => {
    const html = render({ signIns: [site('relink_required', 'ann@example.com')] });

    expect(badgeClasses(html, 'Re-link required')).toEqual(expect.arrayContaining(['text-destructive', 'sign-in-status']));
    expect(buttons(html)).toEqual(['Re-link', 'Sign out']);
  });

  it('offers Sign in for a site the agent is not signed in to', () => {
    const html = render({ signIns: [site('not_linked', null)] });

    expect(badgeClasses(html, 'Not linked')).toEqual(expect.arrayContaining(['bg-secondary', 'sign-in-status']));
    expect(html).not.toContain('sign-in-username');
    expect(buttons(html)).toEqual(['Sign in']);
  });

  it('disables the actions while one runs, and says why one failed', () => {
    const html = render({ signIns: [site('linked', 'ann@example.com')], busy: true, error: 'Sign-out failed: 500' });

    expect(html).toMatch(/<button type="button"[^>]* disabled=""[^>]*>Sign out<\/button>/);
    expect(html).toMatch(/role="alert"[^>]*>Sign-out failed: 500</);
  });

  // The profile's one loading state, in the shape of what loads, not a line of text.
  it('shows the loading skeleton until the Sign-ins arrive', () => {
    const html = render({ signIns: null });
    expect(html).toMatch(/<div [^>]*role="status" aria-label="Loading Sign-ins">(<div data-slot="skeleton"[^>]*><\/div>){3}<\/div>/);
    expect(html).not.toContain('Loading Sign-ins…');
  });
});

describe('Sign-ins tab refresh', () => {
  it.each([false, true])('keeps the completed sign-in status when the older listing finishes late=%s', async (olderFinishesLate) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const older = Promise.withResolvers<Response>();
    const refreshed = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal('fetch', fetchImpl);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renderRevision = async (revision: number) => act(async () => root.render(
      React.createElement(SignInsTab, {
        chatServiceUrl: 'http://chat.test',
        control: {
          revision,
          signIn: () => {}, signOut: () => {}, error: null, busy: false,
        },
      }),
    ));
    const finishOlder = () => older.resolve(Response.json({ signIns: [site('relink_required', 'ann@example.com')] }));
    const finishRefreshed = () => refreshed.resolve(Response.json({ signIns: [site('linked', 'ann@example.com')] }));
    try {
      await renderRevision(0);
      await renderRevision(1);
      await act(async () => { if (olderFinishesLate) finishRefreshed(); else finishOlder(); });
      await act(async () => { if (olderFinishesLate) finishOlder(); else finishRefreshed(); });
      expect(container.querySelector('.sign-in-status')?.textContent).toBe('Linked');
      expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Sign out']);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe('Sign-ins a product lists itself', () => {
  it('reads them where the control says, not from the Chat Service', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const load = vi.fn(async () => [site('linked', 'ann@example.com')]);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(React.createElement(SignInsTab, {
        chatServiceUrl: 'http://chat.test',
        control: {
          revision: 0, load,
          signIn: () => {}, signOut: () => {}, error: null, busy: false,
        },
      })));
      expect(container.querySelector('.sign-in-status')?.textContent).toBe('Linked');
      expect(load).toHaveBeenCalledOnce();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
