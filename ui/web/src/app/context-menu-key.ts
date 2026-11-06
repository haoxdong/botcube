import type { KeyboardEvent } from 'react';

export function contextMenuKey(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest('input, textarea, [contenteditable]')) return false;
  event.preventDefault();
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left, clientY: box.bottom }));
  return true;
}
