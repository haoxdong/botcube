"use client";

import { useEffect, useRef, useState } from "react";
import { withStorage } from "./main-chat-copy";

const KEY = "botcube.queued-follow-ups";

/** Each account's held follow-ups have their own entry, so a tab still on another account never touches them. */
const keyOf = (accountId: string) => `${KEY}:${accountId}`;

/** The account's held follow-ups, each by its chat, until the chat's running Turn ends. */
function stored(accountId: string): Record<string, string> {
  return JSON.parse(localStorage.getItem(keyOf(accountId)) ?? "{}") as Record<string, string>;
}

/** The follow-up held for the account's chat, if any. Blocked storage holds none past the page. */
function queuedFollowUp(accountId: string | undefined, chatId: string): string | null {
  return accountId === undefined ? null : withStorage(() => stored(accountId)[chatId] ?? null);
}

/** The follow-up storage holds for the chat now, or `failed` when this browser could not read it. */
function heldNow(accountId: string, chatId: string): { failed: false; text: string | null } | { failed: true } {
  try {
    return { failed: false, text: stored(accountId)[chatId] ?? null };
  } catch (error) {
    console.error(error);
    return { failed: true };
  }
}

/** Holds the chat's follow-up so a reload keeps it, or lets it go; false when this browser could not keep it. */
function keepQueuedFollowUp(accountId: string, chatId: string, text: string | null): boolean {
  return withStorage(() => {
    const chats = Object.fromEntries(Object.entries(stored(accountId)).filter(([id]) => id !== chatId));
    if (text !== null) chats[chatId] = text;
    if (Object.keys(chats).length === 0) localStorage.removeItem(keyOf(accountId));
    else localStorage.setItem(keyOf(accountId), JSON.stringify(chats));
    return true;
  }) ?? false;
}

/** Every account's held follow-ups in this browser. */
function forgetAll() {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) if (key?.startsWith(`${KEY}:`)) localStorage.removeItem(key);
}

/**
 * A sign-out takes every account's held follow-ups out of this browser with its Main Chat copy, at once and again
 * after any change a tab is still waiting to make, so none puts one back.
 */
export function forgetQueuedFollowUps() {
  try {
    forgetAll();
  } finally {
    void navigator.locks.request(KEY, forgetAll);
  }
}

/** One follow-up after another, as they go: one message, a blank line between. */
const join = (first: string | null, then: string | null) => first === null ? then : then === null ? first : `${first}\n\n${then}`;

/**
 * The chat's held follow-up: what this browser's storage holds for every tab, as this tab last read or wrote it, and
 * after it what this tab holds that storage does not yet, as before the account session answered or after a write
 * failed.
 */
type Held = {
  accountId: string | undefined;
  stored: string | null;
  pending: string | null;
  /** Storage refused `pending`, so leaving the chat or reloading the page loses it. */
  unkept: boolean;
};

/**
 * The follow-up held for a chat while its Turn runs (#3920): kept in this browser across a reload, in step with its
 * other tabs, and sent by exactly one of them once the Turn ends. Several held at once go as one message.
 *
 * Storage changes only under the tabs' one lock, and a send takes out of storage what it sends before sending it, so
 * no follow-up goes twice. What storage cannot take stays held in this tab, never dropped.
 */
export function useQueuedFollowUp(accountId: string | undefined, chatId: string, heldElsewhere: () => void) {
  const [held, setHeld] = useState<Held>(() => ({ accountId, stored: queuedFollowUp(accountId, chatId), pending: null, unkept: false }));
  // The account session answering keeps what this tab held before it did; another account reads its own.
  const current: Held = held.accountId === accountId ? held : {
    accountId,
    stored: queuedFollowUp(accountId, chatId),
    pending: held.accountId === undefined ? held.pending : null,
    unkept: false,
  };
  const ref = useRef(current);
  ref.current = current;
  // What runs under the lock may run after the account session answers: it reads the account then, not when asked.
  const account = useRef(accountId);
  account.current = accountId;
  const set = (change: Partial<Held>) => {
    ref.current = { ...ref.current, accountId: account.current, ...change };
    setHeld(ref.current);
  };
  const locked = (run: () => void) => void navigator.locks.request(KEY, run);

  /** Saves what this tab holds that storage does not, after what storage holds; what it cannot save stays here. */
  const save = () => locked(() => {
    const owner = account.current;
    const { pending } = ref.current;
    if (owner === undefined || pending === null) return;
    const read = heldNow(owner, chatId);
    if (read.failed) {
      set({ unkept: true });
      return;
    }
    const text = join(read.text, pending);
    set(keepQueuedFollowUp(owner, chatId, text) ? { stored: text, pending: null, unkept: false } : { stored: read.text, unkept: true });
  });
  useEffect(() => {
    if (held.accountId === accountId) return;
    set(current);
    save();
  }, [accountId]);

  // Another tab of this browser can hold, cancel or send the chat's follow-up: this one shows what it left, after
  // what this one has yet to save.
  useEffect(() => {
    if (accountId === undefined) return undefined;
    const synced = (event: StorageEvent) => {
      if (event.key !== keyOf(accountId) && event.key !== null) return;
      const stored = queuedFollowUp(accountId, chatId);
      if (stored !== null && stored !== ref.current.stored) heldElsewhere();
      set({ stored });
    };
    window.addEventListener("storage", synced);
    return () => window.removeEventListener("storage", synced);
  }, [accountId, chatId, heldElsewhere]);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const sending = useRef(false);
  // Bumped by each Cancel, at once, so a send still waiting on the lock never sends what was cancelled.
  const cancels = useRef(0);

  return {
    text: join(current.stored, current.pending),
    /** Part of it lives only in this tab: leaving the chat or reloading the page loses that part. */
    unkept: current.pending !== null && current.unkept,
    /** Adds a follow-up to the one held. */
    add: (message: string) => {
      set({ pending: join(ref.current.pending, message) });
      save();
    },
    /** Lets the held follow-up go; one this browser cannot take out of storage stays, and `failed` says so. */
    cancel: (failed: () => void) => {
      cancels.current += 1;
      const { stored, pending } = ref.current;
      set({ stored: null, pending: null, unkept: false });
      if (stored === null) return;
      locked(() => {
        const owner = account.current;
        if (owner === undefined || keepQueuedFollowUp(owner, chatId, null)) return;
        // Not cancelled, so all of it stays held, before anything added since.
        set({ stored, pending: join(pending, ref.current.pending) });
        failed();
      });
    },
    /**
     * Sends the held follow-up through `dispatch` once `ready` holds, as storage holds it then: the tab that takes it
     * out of storage sends it, and another finds it gone. One this browser cannot read or take out of storage stays
     * held, unsent, and `failed` says so: sent, a reload would send it again.
     */
    send: (ready: () => boolean, dispatch: (text: string) => void, failed: () => void) => {
      if (join(ref.current.stored, ref.current.pending) === null || sending.current) return;
      sending.current = true;
      const cancel = cancels.current;
      locked(() => {
        sending.current = false;
        if (!mounted.current || cancel !== cancels.current || !ready()) return;
        const owner = account.current;
        const read = owner === undefined ? { failed: false as const, text: null } : heldNow(owner, chatId);
        if (read.failed) {
          failed();
          return;
        }
        const text = join(read.text, ref.current.pending);
        if (text === null) {
          set({ stored: null });
          return;
        }
        if (read.text !== null && owner !== undefined && !keepQueuedFollowUp(owner, chatId, null)) {
          set({ stored: read.text });
          failed();
          return;
        }
        set({ stored: null, pending: null, unkept: false });
        dispatch(text);
      });
    },
  };
}
