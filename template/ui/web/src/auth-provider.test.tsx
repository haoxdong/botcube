// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TemplateAuthProvider, SignInsTab } from './auth-provider';

function button(container: HTMLDivElement): HTMLButtonElement {
  const found = container.querySelector('button');
  if (!found) throw new Error('Sign-ins action is missing');
  return found;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows the server link state and links and unlinks from the Sign-ins tab', async () => {
  let linked = false;
  vi.stubGlobal('fetch', async (input: string) => {
    if (input.endsWith('/account/session')) return Response.json({ accountId: 'template-account', signInNeeded: false });
    if (input.endsWith('/start')) return Response.json({ linkId: 'link-1' });
    if (input.endsWith('/sign-in')) linked = true;
    if (input.endsWith('/unlink')) linked = false;
    if (input.endsWith('/account/sign-ins')) return Response.json({ signIns: [{ status: linked ? 'linked' : 'not_linked' }] });
    return Response.json({ status: linked ? 'linked' : 'not_linked' });
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TemplateAuthProvider chatServiceUrl="http://local">{() => <SignInsTab />}</TemplateAuthProvider>));
    expect(container.textContent).toContain('Not linked');
    await act(async () => button(container).click());
    expect(container.textContent).toContain('Linked');
    expect(button(container).textContent).toBe('Sign out');
    await act(async () => button(container).click());
    expect(container.textContent).toContain('Not linked');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('shows a failed Sign-ins load after the Account session succeeds', async () => {
  vi.stubGlobal('fetch', async (input: string) => input.endsWith('/account/session') ? Response.json({ accountId: 'template-account', signInNeeded: false }) : new Response('', { status: 503 }));
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TemplateAuthProvider chatServiceUrl="http://local">{() => <SignInsTab />}</TemplateAuthProvider>));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Template sign-in HTTP 503');
    expect(container.textContent).toContain('Sign-ins unavailable');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('shows the scheduled sign-in chip and clears it after linking', async () => {
  vi.stubGlobal('fetch', async (input: string) => {
    if (input.endsWith('/account/session')) return Response.json({ accountId: 'template-account', signInNeeded: true });
    if (input.endsWith('/start')) return Response.json({ linkId: 'scheduled-link' });
    if (input.endsWith('/account/sign-ins')) return Response.json({ signIns: [{ status: 'not_linked' }] });
    return Response.json({ status: 'linked' });
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TemplateAuthProvider chatServiceUrl="http://local">{(auth) => <>{auth.composerAccessory}</>}</TemplateAuthProvider>));
    expect(container.querySelector('button')?.textContent).toBe('Sign in needed');
    await act(async () => button(container).click());
    expect(container.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('shows a scheduled refusal while the Account UI remains open', async () => {
  vi.useFakeTimers();
  let needed = false;
  vi.stubGlobal('fetch', async (input: string) => input.endsWith('/account/session')
    ? Response.json({ accountId: 'template-account', signInNeeded: needed })
    : Response.json({ signIns: [{ status: 'not_linked' }] }));
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TemplateAuthProvider chatServiceUrl="http://local">{(auth) => <>{auth.composerAccessory}</>}</TemplateAuthProvider>));
    expect(container.querySelector('button')).toBeNull();
    needed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.querySelector('button')?.textContent).toBe('Sign in needed');
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});


it('reports malformed scheduled sign-in state instead of clearing the chip', async () => {
  vi.stubGlobal('fetch', async (input: string) => input.endsWith('/account/session')
    ? Response.json({ accountId: 'template-account', signInNeeded: 'true' })
    : Response.json({ signIns: [{ status: 'not_linked' }] }));
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TemplateAuthProvider chatServiceUrl="http://local">{(auth) => <p role="alert">{auth.error}</p>}</TemplateAuthProvider>));
    expect(container.textContent).toBe('Template Account session is malformed');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('keeps the chip cleared when an earlier poll returns after sign-in completes', async () => {
  vi.useFakeTimers();
  let first = true;
  let resolvePoll: ((response: Response) => void) | undefined;
  vi.stubGlobal('fetch', async (input: string) => {
    if (input.endsWith('/account/session')) {
      if (first) {
        first = false;
        return Response.json({ accountId: 'template-account', signInNeeded: true });
      }
      return new Promise<Response>((resolve) => { resolvePoll = resolve; });
    }
    if (input.endsWith('/account/sign-ins')) return Response.json({ signIns: [{ status: 'not_linked' }] });
    if (input.endsWith('/start')) return Response.json({ linkId: 'scheduled-link' });
    return Response.json({ status: 'linked' });
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TemplateAuthProvider chatServiceUrl="http://local">{(auth) => <>{auth.composerAccessory}</>}</TemplateAuthProvider>));
    expect(button(container).textContent).toBe('Sign in needed');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    if (!resolvePoll) throw new Error('Account refresh did not start');
    await act(async () => button(container).click());
    expect(container.querySelector('button')).toBeNull();
    await act(async () => { resolvePoll?.(Response.json({ accountId: 'template-account', signInNeeded: true })); });
    expect(container.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
