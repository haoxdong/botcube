"use client";

import { useEffect, useRef, useState } from "react";
import type { AbstractAgent } from "@ag-ui/client";
import { messageWithFiles, sentFilesOf } from "./composer-files";

const KEY = "botcube.steering:";
type PendingMessage = { id: string; content: string };

function read(key: string): PendingMessage[] {
  return JSON.parse(localStorage.getItem(key) ?? "[]") as PendingMessage[];
}

export function forgetSteering() {
  for (const key of Object.keys(localStorage)) if (key.startsWith(KEY)) localStorage.removeItem(key);
}

export function useSteering({ agent, accountId, threadId, running, ready, serviceUrl, submit, failed, heldElsewhere }: {
  agent: AbstractAgent;
  accountId: string | undefined;
  threadId: string;
  running: boolean;
  ready: boolean;
  serviceUrl: string;
  submit: (text: string) => boolean;
  failed: (message: string) => void;
  heldElsewhere: () => void;
}) {
  const key = `${KEY}${accountId ?? "pending"}:${threadId}`;
  const [revision, refresh] = useState(0);
  const current = useRef({ submit, failed, running, key, heldElsewhere });
  current.current = { submit, failed, running, key, heldElsewhere };
  const sending = useRef(new Set<string>());
  const unsaved = useRef(new Map<string, PendingMessage[]>());
  const delivery = useRef(Promise.resolve());
  const dropped = useRef(0);

  useEffect(() => {
    const subscription = agent.subscribe({ onMessagesChanged: () => refresh((value) => value + 1) });
    const changed = (event: StorageEvent) => {
      if (event.key !== key) return;
      if (read(key).length > 0) current.current.heldElsewhere();
      refresh((value) => value + 1);
    };
    window.addEventListener("storage", changed);
    return () => { subscription.unsubscribe(); window.removeEventListener("storage", changed); };
  }, [agent, key]);

  useEffect(() => {
    if (accountId === undefined) return;
    void navigator.locks.request(key, () => {
      if (current.current.key !== key) return [];
      const pending = [...read(key), ...(unsaved.current.get(key) ?? [])]
        .filter(({ id }) => !agent.messages.some((message) => message.id === id));
      if (pending.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(pending));
      unsaved.current.delete(key);
      if (!current.current.running) {
        const parts = pending.map(({ content }) => sentFilesOf(content));
        const text = messageWithFiles(parts.map((part) => part.text).join("\n\n"), parts.flatMap((part) => part.paths));
        if (ready && pending.length > 0 && current.current.submit(text)) {
          localStorage.removeItem(key);
        }
        return [];
      }
      return pending;
    }).then((pending) => {
      if (current.current.key !== key) return;
      const generation = dropped.current;
      delivery.current = pending.reduce((previous, message) => previous.then(async () => {
        if (current.current.key !== key || !current.current.running || dropped.current !== generation) return;
        if (sending.current.has(message.id)) return;
        sending.current.add(message.id);
        try {
          const response = await fetch(`${serviceUrl}/threads/${encodeURIComponent(threadId)}/steer`, {
            method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(message),
          });
          if (!response.ok) throw new Error(`Steering failed: HTTP ${response.status}`);
        } catch (error) {
          current.current.failed(`${error instanceof Error ? error.message : String(error)}. Your message is kept for the next Turn.`);
        }
      }), delivery.current);
    }).catch((error: unknown) => current.current.failed(`Your steering message is held only in this tab because browser storage failed: ${String(error)}`));
  }, [key, running, revision, accountId, serviceUrl, threadId, ready]);

  const steer = (content: string) => {
    if (accountId === undefined) {
      failed('Your account is still loading. Send your message again once it loads.');
      return false;
    }
    unsaved.current.set(key, [...(unsaved.current.get(key) ?? []), { id: crypto.randomUUID(), content }]);
    refresh((value) => value + 1);
    return true;
  };
  const drop = () => {
    dropped.current += 1;
    unsaved.current.delete(key);
    void navigator.locks.request(key, () => localStorage.removeItem(key))
      .catch((error: unknown) => current.current.failed(`Your follow-ups could not be dropped because browser storage failed: ${String(error)}`));
  };
  return { steer, drop };
}
