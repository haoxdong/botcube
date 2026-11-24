"use client";

import { useEffect, useRef, useState } from 'react';
import { failureDetail } from '../computer/failure-detail';
import { Collapse, Swap } from './collapse';
import { LoadingSkeleton } from './load-state';
import { Arrives, Shows } from './motion';
import { Button } from '../components/pill-button';
import { Badge } from '../components/ui/badge';
import type { SignIn, SignInsControl } from '../plugin/types';

export async function loadSignIns({ chatServiceUrl, fetchImpl = fetch }: { chatServiceUrl: string; fetchImpl?: typeof fetch }): Promise<SignIn[]> {
  const response = await fetchImpl(`${chatServiceUrl}/account/sign-ins`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(await failureDetail(response, 'Sign-ins failed'));
  const { signIns } = (await response.json()) as { signIns: SignIn[] };
  return signIns;
}

const STATUS_LABELS: Record<SignIn['status'], string> = {
  linked: 'Linked',
  relink_required: 'Re-link required',
  not_linked: 'Not linked',
};

const STATUS_VARIANTS = { linked: 'secondary', relink_required: 'destructive', not_linked: 'secondary' } as const satisfies Record<SignIn['status'], string>;

interface SignInsListProps {
  /** Null until loaded. */
  signIns: SignIn[] | null;
  error: string | null;
  busy: boolean;
  /** Sign in and Re-link both open the Sign-in Sheet. */
  onSignIn: () => void;
  onSignOut: () => void;
}

/** The Agent Profile's Sign-ins tab: each site the agent can sign in to, its status, and what the user can do. */
export function SignInsList({ signIns, error, busy, ...actions }: SignInsListProps) {
  return (
    <div className="sign-ins">
      <Arrives state={signIns === null ? 'loading' : 'loaded'} waiting={signIns === null}>
      {signIns === null ? (
        <LoadingSkeleton label="Sign-ins" />
      ) : (
        <ul className="sign-ins-list">
          {signIns.map((signIn) => (
            <li key={signIn.site} className="sign-in">
              <span className="sign-in-name">{signIn.name}</span>
              <Shows when={signIn.username != null} className="sign-in-username">{signIn.username}</Shows>
              <Badge variant={STATUS_VARIANTS[signIn.status]} className="sign-in-status">{STATUS_LABELS[signIn.status]}</Badge>
              <Swap state={signIn.status} className="sign-in-actions">
                {signIn.status === 'not_linked' ? (
                  <Button type="button" disabled={busy} onClick={actions.onSignIn}>Sign in</Button>
                ) : (
                  <>
                    {signIn.status === 'relink_required' && (
                      <Button type="button" disabled={busy} onClick={actions.onSignIn}>Re-link</Button>
                    )}
                    <Button type="button" disabled={busy} onClick={actions.onSignOut}>Sign out</Button>
                  </>
                )}
              </Swap>
            </li>
          ))}
        </ul>
      )}
      </Arrives>
      <Collapse open={error !== null}>{error !== null && <p className="sign-in-error" role="alert">{error}</p>}</Collapse>
    </div>
  );
}

/** The built-in Sign-ins tab: the sites the Chat Service lists, reloaded at each sign-in or sign-out. */
export function SignInsTab({ chatServiceUrl, control }: { chatServiceUrl: string; control: SignInsControl }) {
  const { revision } = control;
  const [signIns, setSignIns] = useState<SignIn[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useRef(control.load);
  load.current = control.load;

  useEffect(() => {
    let active = true;
    (load.current?.() ?? loadSignIns({ chatServiceUrl })).then(
      (loaded) => {
        if (!active) return;
        setSignIns(loaded);
        setLoadError(null);
      },
      (cause: Error) => {
        if (active) setLoadError(cause.message);
      },
    );
    return () => { active = false; };
  }, [chatServiceUrl, revision]);

  return (
    <SignInsList
      signIns={signIns}
      error={control.error ?? loadError}
      busy={control.busy}
      onSignIn={control.signIn}
      onSignOut={control.signOut}
    />
  );
}
