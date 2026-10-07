"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Globe, Lock } from 'lucide-react';
import type { AuthProviderProps } from 'botcube-ui-web/cartridge';
import { Button, ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle, StatusPill } from 'botcube-ui-web/ui';

interface SignInState {
  status: 'loading' | 'linked' | 'not_linked' | 'error';
  error: string | null;
  busy: boolean;
  signIn: () => void;
  unlink: () => void;
}
function accountSession(payload: Record<string, unknown>) {
  if (typeof payload.accountId !== 'string' || !payload.accountId || typeof payload.signInNeeded !== 'boolean') {
    throw new Error('Template Account session is malformed');
  }
  return { accountId: payload.accountId, signInNeeded: payload.signInNeeded };
}

const SignInContext = createContext<SignInState | null>(null);

export function TemplateAuthProvider({ chatServiceUrl, children }: AuthProviderProps) {
  const [status, setStatus] = useState<SignInState['status']>('loading');
  const [accountId, setAccountId] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signInNeeded, setSignInNeeded] = useState(false);
  const signInRevision = useRef(0);
  async function call(path: string, body?: unknown) {
    const response = await fetch(`${chatServiceUrl}${path}`, {
      credentials: 'include',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Template sign-in HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null) throw new Error('Template sign-in returned malformed state');
    return payload as Record<string, unknown>;
  }
  useEffect(() => {
    let active = true;
    let sessionReady = false;
    void call('/account/session').then(accountSession).then(async (session) => {
      sessionReady = true;
      if (active) setAccountId(session.accountId);
      if (active) setSignInNeeded(session.signInNeeded);
      const body = await call('/account/sign-ins');
      const signIn: unknown = Array.isArray(body.signIns) ? body.signIns[0] : undefined;
      if (typeof signIn !== 'object' || signIn === null || !('status' in signIn) || (signIn.status !== 'linked' && signIn.status !== 'not_linked')) {
        throw new Error('Template Sign-ins returned malformed state');
      }
      if (active) setStatus(signIn.status);
    }).catch((cause: Error) => {
      if (active) { setStatus('error'); setError(cause.message); }
    });
    const refresh = setInterval(() => {
      if (!sessionReady) return;
      const revision = signInRevision.current;
      void call('/account/session').then(accountSession).then((session) => {
        if (active && revision === signInRevision.current) setSignInNeeded(session.signInNeeded);
      }).catch((cause: Error) => {
        if (active) setError(cause.message);
      });
    }, 5000);
    return () => { active = false; clearInterval(refresh); };
  }, [chatServiceUrl]);
  function action(operation: () => Promise<'linked' | 'not_linked'>) {
    setBusy(true);
    setError(null);
    void operation().then(setStatus, (cause: Error) => setError(cause.message)).finally(() => setBusy(false));
  }
  const signIn = () => action(async () => {
    signInRevision.current += 1;
    const start = await call('/account/fake-site-link/start', {});
    if (typeof start.linkId !== 'string' || !start.linkId) throw new Error('Template Account Linking is malformed');
    await call('/account/fake-site-link/sign-in', start);
    await call('/account/fake-site-link/complete', start);
    signInRevision.current += 1;
    setSignInNeeded(false);
    return 'linked';
  });
  const unlink = () => action(async () => { await call('/account/fake-site-link/unlink', {}); return 'not_linked'; });
  return <SignInContext.Provider value={{ status, error, busy, signIn, unlink }}>
    {children({ sessionStatus: accountId ? 'ready' : status === 'error' ? 'error' : 'loading', accountId, status: accountId ? 'authed' : status === 'error' ? 'error' : 'loading', error, login: signIn, relink: signIn, logout: unlink,
      composerAccessory: signInNeeded ? (
        <button type="button" className="template-sign-in-chip" disabled={busy} onClick={signIn}><Lock aria-hidden="true" />Sign in needed</button>
      ) : undefined,
    })}
  </SignInContext.Provider>;
}

export function SignInsTab() {
  const state = useContext(SignInContext);
  if (!state) throw new Error('Template Sign-ins needs its auth provider');
  const label = state.status === 'linked' ? 'Linked' : state.status === 'not_linked' ? 'Not linked' : state.status === 'loading' ? 'Loading Sign-ins…' : 'Sign-ins unavailable';
  return <section className="template-sign-ins" aria-label="Sign-ins">
    <ul className="template-sign-ins-list">
      <ListRow className="template-sign-in">
        <ListRowIcon failed={state.status === 'error'}><Globe /></ListRowIcon>
        <ListRowText>
          <ListRowTitle>Template site</ListRowTitle>
          <ListRowDetail>A local stand-in for the site your agent signs in to</ListRowDetail>
          <Button type="button" className="template-sign-in-action" disabled={state.busy || state.status === 'loading'} onClick={state.status === 'linked' ? state.unlink : state.signIn}>
            {state.status === 'linked' ? 'Sign out' : 'Sign in'}
          </Button>
        </ListRowText>
        <StatusPill className="template-sign-in-status" role="status" tone={state.status === 'linked' ? 'blue' : state.status === 'error' ? 'danger' : 'neutral'}>{label}</StatusPill>
      </ListRow>
    </ul>
    {state.error && <p className="template-error" role="alert">{state.error}</p>}
  </section>;
}
