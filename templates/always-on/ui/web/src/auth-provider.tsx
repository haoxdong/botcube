"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { takeOpeningResponse } from 'botcube-ui-web/opening-requests';
import type { AuthProviderProps, SignInsControl } from 'botcube-ui-web/cartridge';

type SignInStatus = 'loading' | 'linked' | 'not_linked' | 'error';
function accountSession(payload: Record<string, unknown>) {
  if (typeof payload.accountId !== 'string' || !payload.accountId || typeof payload.signInNeeded !== 'boolean') {
    throw new Error('Template Account session is malformed');
  }
  return { accountId: payload.accountId, signInNeeded: payload.signInNeeded, oidc: payload.signIn === 'oidc' ? { authenticated: payload.authenticated === true } : null };
}

/** Sign in with the deployment's OIDC provider: the Chat Service sends the browser there and back to this page. */
function oidcLogin(chatServiceUrl: string) {
  window.location.assign(`${chatServiceUrl}/auth/oidc/login?return_to=${encodeURIComponent(window.location.href)}`);
}

export function TemplateAuthProvider({ chatServiceUrl, children }: AuthProviderProps) {
  const [status, setStatus] = useState<SignInStatus>('loading');
  const [accountId, setAccountId] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [oidc, setOidc] = useState<{ authenticated: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const signInRevision = useRef(0);
  async function call(path: string, body?: unknown) {
    const response = await ((path === '/account/session' ? takeOpeningResponse(`${chatServiceUrl}${path}`) : null) ?? fetch(`${chatServiceUrl}${path}`, {
      credentials: 'include',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }));
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
      if (active) setOidc(session.oidc);
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
    void operation().then((next) => {
      setStatus(next);
      setRevision((current) => current + 1);
    }, (cause: Error) => setError(cause.message)).finally(() => setBusy(false));
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
  const logout = () => {
    void call('/auth/logout', {}).then(() => window.location.reload(), (cause: Error) => setError(cause.message));
  };
  const account = oidc === null
    ? { status: accountId ? 'authed' as const : status === 'error' ? 'error' as const : 'loading' as const, login: signIn, logout: unlink }
    : { status: oidc.authenticated ? 'authed' as const : 'unauthed' as const, login: () => oidcLogin(chatServiceUrl), logout };
  // BotCube's Sign-ins tab lists the site from the Chat Service; the template signs in and out with no warning to confirm.
  const signIns: SignInsControl = { signIn, signOut: unlink, confirmSignOut: unlink, cancelSignOut: () => {}, warning: null, busy, error, revision };
  return <>
    {children({ sessionStatus: accountId ? 'ready' : status === 'error' ? 'error' : 'loading', accountId, ...account, error, relink: signIn,
      composerAccessory: signInNeeded ? (
        <button type="button" className="template-sign-in-chip" disabled={busy} onClick={signIn}><Lock aria-hidden="true" />Sign in needed</button>
      ) : undefined,
      signIns,
    })}
  </>;
}
