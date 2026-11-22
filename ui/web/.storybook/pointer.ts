import { userEvent } from 'vitest/browser';

export async function hoverPointer(element: Element) {
  await userEvent.hover(element);
}

export async function parkPointer() {
  await userEvent.hover(document.documentElement, { position: { x: 0, y: 0 } });
}
