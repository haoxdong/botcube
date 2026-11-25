import { expect, it, vi } from 'vitest';

import { renderHook } from '@testing-library/react';

import { usePhoneProfileFocus } from './phone-profile-focus';

function openProfile() {
  const close = vi.fn();
  renderHook(() => usePhoneProfileFocus({ open: true, expanded: true, profileRef: { current: null }, openerRef: { current: null }, close }));
  return close;
}

const escape = (claimed: boolean) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (claimed) event.preventDefault();
  document.body.dispatchEvent(event);
};

it('closes the open phone profile on Escape', () => {
  const close = openProfile();
  escape(false);
  expect(close).toHaveBeenCalledTimes(1);
});

it("keeps the phone profile open on an Escape a menu inside it already took", () => {
  const close = openProfile();
  escape(true);
  expect(close).not.toHaveBeenCalled();
});
