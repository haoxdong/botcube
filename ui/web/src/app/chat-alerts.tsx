"use client";

import { m } from "motion/react";
import { Presence, presenceMotion } from "./collapse";
import { RowCollapse } from "./conversation-thread";
import { LoadFailed } from "./load-state";

export function ChatAlerts({ errors, failure }: {
  errors: (string | null | undefined)[];
  failure: { error: string; retry: () => void } | null;
}) {
  const messages = [...new Set(errors.filter((error): error is string => Boolean(error)))];
  return <>
    <Presence>{messages.map((message) => <m.p {...presenceMotion} key={message} className="chat-account-error" role="alert">{message}</m.p>)}</Presence>
    <RowCollapse open={failure !== null}>{failure && <LoadFailed error={failure.error} onRetry={failure.retry} />}</RowCollapse>
  </>;
}
