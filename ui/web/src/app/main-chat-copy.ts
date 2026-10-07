"use client";

import type { ReplayedSession } from "./conversations";

const KEY = "botcube.main-chat";
/** The most messages the copy keeps: a long chat's latest Turns, more than the screen it opens at shows. */
const MAX_MESSAGES = 40;
/** The most characters the copy takes in this browser's storage. */
const MAX_CHARACTERS = 1_000_000;

/**
 * Browser storage that is blocked or full costs only the Main Chat's copy as it is read or kept: the Main Chat still
 * loads. Forgetting a copy is never wrapped, as a failure would leave one account's copy for the next (ADR 0030).
 */
export function withStorage<T>(use: () => T): T | null {
  try {
    return use();
  } catch (error) {
    console.error(error);
    return null;
  }
}

/** The Main Chat as this browser last loaded it. */
export type MainChatCopy = ReplayedSession & { id: string };

/** The copy this browser kept, with the account it belongs to. */
export type StoredMainChatCopy = { accountId: string; copy: MainChatCopy };

/** The copy kept in this browser, whichever account's it is, shown as the page opens until the account session answers. */
export function storedMainChatCopy(): StoredMainChatCopy | null {
  const stored = withStorage(() => JSON.parse(localStorage.getItem(KEY) ?? "null") as (MainChatCopy & { accountId: string }) | null);
  if (stored === null) return null;
  const { accountId, ...copy } = stored;
  return { accountId, copy };
}

/**
 * The copy this browser kept of the account's Main Chat, shown while the Main Chat loads. Another account's copy is
 * forgotten once the account is known: a sign-out or an account change leaves none behind.
 */
export function mainChatCopy(accountId: string): MainChatCopy | null {
  const stored = storedMainChatCopy();
  if (stored === null) return null;
  const { accountId: owner, copy } = stored;
  if (owner === accountId) return copy;
  localStorage.removeItem(KEY);
  return null;
}

/** Keeps the Main Chat's latest Turns, from a Turn's first message, within the copy's bounds; none fit, none is kept. */
export function keepMainChatCopy(accountId: string, { id, provider, messages }: MainChatCopy) {
  for (let start = Math.max(0, messages.length - MAX_MESSAGES); start < messages.length; start += 1) {
    if (messages[start]?.role !== "user") continue;
    const copy = JSON.stringify({ accountId, id, provider, messages: messages.slice(start) });
    if (copy.length <= MAX_CHARACTERS) {
      localStorage.setItem(KEY, copy);
      return;
    }
  }
  localStorage.removeItem(KEY);
}

/** A sign-out takes the account's copy out of this browser at once, whether or not the sign-out then succeeds. */
export function forgetMainChatCopy() {
  localStorage.removeItem(KEY);
}
