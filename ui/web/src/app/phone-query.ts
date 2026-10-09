import { useSyncExternalStore } from 'react';

// Phones (globals.css's 640px breakpoint) show the expanded sidebar as a drawer beside the chat, and scroll the chat
// with the page.
const PHONE_QUERY = '(max-width: 640px)';

const subscribeToPhoneQuery = (onChange: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** Whether the window is phone-sized (PHONE_QUERY), following resizes; a server render is not. */
export function useIsPhone() {
  return useSyncExternalStore(subscribeToPhoneQuery, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}
