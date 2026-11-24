"use client";

import { AlertLine } from "./alert-line";
import { LoadFailed } from "./load-state";
import { Fades } from "./motion";

export function ChatAlerts({ errors, failure }: {
  errors: (string | null | undefined)[];
  failure: { error: string; retry: () => void } | null;
}) {
  const messages = [...new Set(errors.filter((error): error is string => Boolean(error)))];
  return <>
    <Fades>{messages.map((message) => <AlertLine key={message} className="chat-account-error">{message}</AlertLine>)}</Fades>
    {/* Nothing while there is no failure, so the chat stays the phone header's next sibling (header.css). */}
    <Fades folds>{failure && <div key="failure" className="collapsible"><div><LoadFailed error={failure.error} onRetry={failure.retry} /></div></div>}</Fades>
  </>;
}
