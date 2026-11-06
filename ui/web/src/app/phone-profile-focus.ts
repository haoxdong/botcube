import { useEffect, useRef, type RefObject } from "react";

/**
 * The phone's Agent Profile covers the chat, which goes inert under it: the profile takes the keyboard's focus at its
 * Close as it opens, closes on Escape, and once shut gives focus back to its opener, unless the user moved it elsewhere
 * or the opener is gone.
 */
export function usePhoneProfileFocus({ open, expanded, profileRef, openerRef, close }: {
  /** The profile stands open over the chat on a phone. */
  open: boolean;
  /** The profile is open, a swipe moving it or not. */
  expanded: boolean;
  profileRef: RefObject<HTMLElement | null>;
  openerRef: RefObject<HTMLButtonElement | null>;
  close: () => void;
}) {
  const opened = useRef(false);
  // iOS taps aren't pointer input for :focus-visible, so script focus after a tap would ring as the keyboard's.
  const keyboard = useRef(false);
  useEffect(() => {
    const typed = () => { keyboard.current = true; };
    const pointed = () => { keyboard.current = false; };
    document.addEventListener("keydown", typed, true);
    document.addEventListener("pointerdown", pointed, true);
    return () => {
      document.removeEventListener("keydown", typed, true);
      document.removeEventListener("pointerdown", pointed, true);
    };
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    opened.current = true;
    const focusClose = () => {
      const close = profileRef.current?.querySelector<HTMLElement>(".agent-profile-close");
      close?.focus({ focusVisible: keyboard.current });
      return close !== undefined && close !== null;
    };
    if (focusClose()) return undefined;
    // A fresh page's chat portals the profile in after it opens, so its Close takes focus as it mounts.
    const mounted = new MutationObserver(() => {
      if (focusClose()) mounted.disconnect();
    });
    mounted.observe(document.body, { childList: true, subtree: true });
    return () => mounted.disconnect();
  }, [open, profileRef]);
  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, close]);
  useEffect(() => {
    if (expanded || !opened.current) return;
    opened.current = false;
    const opener = openerRef.current;
    const focused = document.activeElement;
    const left = focused === null || focused === document.body || profileRef.current?.contains(focused) === true;
    if (left && opener?.isConnected && !opener.disabled) opener.focus({ focusVisible: keyboard.current });
  }, [expanded, openerRef, profileRef]);
}
