"use client";

import { useEffect, useRef, useState } from "react";
import type { AbstractAgent } from "@ag-ui/client";
import { z } from "zod";
import { messageWithFiles, sentFilesOf } from "./composer-files";

const KEY = "botcube.steering:";
export type PendingMessage = { id: string; content: string; missed?: true; now?: true };
export type Withdrawal = "withdrawn" | "taken" | "failed";
const Withdrawn = z.object({ withdrawn: z.boolean() });
const Accepted = z.object({ accepted: z.boolean() });

function read(key: string): PendingMessage[] {
  return JSON.parse(localStorage.getItem(key) ?? "[]") as PendingMessage[];
}

function store(key: string, messages: PendingMessage[]) {
  if (messages.length === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(messages));
}

function carryOver(pending: PendingMessage[], withdrawing: Set<string>) {
  const now = pending.filter((message) => message.now);
  const carried = now.length > 0 ? now : pending.filter(({ id }) => !withdrawing.has(id));
  const kept = pending.filter((message) => !carried.includes(message)).map(({ id, content }) => ({ id, content }));
  const parts = carried.map(({ content }) => sentFilesOf(content));
  const text = messageWithFiles(parts.map((part) => part.text).join("\n\n"), parts.flatMap((part) => part.paths));
  return { carried, kept, text, sentNow: now.length > 0 };
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
  const withdrawing = useRef(new Set<string>());

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
      const pending = save();
      if (current.current.running) return pending;
      submitCarried(pending);
      return [];
    }).then((pending) => {
      if (current.current.key !== key) return;
      const generation = dropped.current;
      delivery.current = pending.reduce((previous, message) => previous.then(async () => {
        if (current.current.key !== key || !current.current.running || dropped.current !== generation) return;
        if (sending.current.has(message.id) || withdrawing.current.has(message.id)) return;
        sending.current.add(message.id);
        await post(message);
      }), delivery.current);
    }).catch((error: unknown) => current.current.failed(`Your steering message is held only in this tab because browser storage failed: ${String(error)}`));
  }, [key, running, revision, accountId, serviceUrl, threadId, ready]);

  function save() {
    const pending = [...read(key), ...(unsaved.current.get(key) ?? [])]
      .filter(({ id }) => !agent.messages.some((message) => message.id === id));
    store(key, pending);
    unsaved.current.delete(key);
    return pending;
  }
  function submitCarried(pending: PendingMessage[]) {
    const { carried, kept, text, sentNow } = carryOver(pending, withdrawing.current);
    if (!ready || carried.length === 0 || !current.current.submit(text)) return;
    store(key, kept);
    if (sentNow) for (const { id } of kept) sending.current.delete(id);
  }
  async function post(message: PendingMessage) {
    try {
      const response = await fetch(`${serviceUrl}/threads/${encodeURIComponent(threadId)}/steer`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error(`Steering failed: HTTP ${response.status}`);
      if (!Accepted.parse(await response.json()).accepted) await mark(message.id, { missed: true });
    } catch (error) {
      current.current.failed(`${error instanceof Error ? error.message : String(error)}. Your message is kept for the next Turn.`);
    }
  }
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
  const mark = (id: string, flags: { missed?: true; now?: true }) => {
    const flagged = (messages: PendingMessage[]) => messages.map((message) => message.id === id ? { ...message, ...flags } : message);
    unsaved.current.set(key, flagged(unsaved.current.get(key) ?? []));
    return navigator.locks.request(key, () => {
      const messages = read(key);
      if (messages.length > 0) localStorage.setItem(key, JSON.stringify(flagged(messages)));
    }).finally(() => refresh((value) => value + 1));
  };
  const forget = (id: string) => {
    unsaved.current.set(key, (unsaved.current.get(key) ?? []).filter((message) => message.id !== id));
    return navigator.locks.request(key, () => {
      store(key, read(key).filter((message) => message.id !== id));
    });
  };
  const withdrawThen = async (id: string, settle: (id: string) => Promise<unknown>): Promise<Withdrawal> => {
    withdrawing.current.add(id);
    try {
      const response = await fetch(`${serviceUrl}/threads/${encodeURIComponent(threadId)}/steer/${encodeURIComponent(id)}`, {
        method: "DELETE", credentials: "include",
      });
      if (!response.ok) throw new Error(`Withdrawing failed: HTTP ${response.status}`);
      const { withdrawn } = Withdrawn.parse(await response.json());
      if (!withdrawn) return "taken";
      await settle(id);
      return "withdrawn";
    } catch (error) {
      withdrawing.current.delete(id);
      failed(`${error instanceof Error ? error.message : String(error)}. Your message is still waiting.`);
      return "failed";
    } finally {
      refresh((value) => value + 1);
    }
  };
  const waiting = running && accountId !== undefined
    ? [...read(key), ...(unsaved.current.get(key) ?? [])].filter((message, index, all) =>
      all.findIndex(({ id }) => id === message.id) === index && !message.now && !agent.messages.some(({ id }) => id === message.id))
    : [];
  const withdraw = (id: string) => withdrawThen(id, forget);
  const sendNow = (id: string) => withdrawThen(id, (sent) => mark(sent, { now: true }));
  return { steer, drop, waiting, withdraw, sendNow };
}
