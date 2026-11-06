"use client";

import { m } from "framer-motion";
import { Collapse, Presence, presenceMotion } from "./collapse";
import { LoadFailed } from "./load-state";

export function ChatAlerts({ errors, failure }: {
  errors: (string | null | undefined)[];
  failure: { error: string; retry: () => void } | null;
}) {
  const messages = [...new Set(errors.filter((error): error is string => Boolean(error)))];
  return <>
    <Presence>{messages.map((message) => <m.p {...presenceMotion} key={message} className="chat-account-error" role="alert">{message}</m.p>)}</Presence>
    <Collapse open={failure !== null}>{failure && <LoadFailed error={failure.error} onRetry={failure.retry} />}</Collapse>
  </>;
}
