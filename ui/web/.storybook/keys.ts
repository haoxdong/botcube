import { userEvent } from 'vitest/browser';

/** Types through the browser's own keyboard, for a grid that ignores synthetic key events (Univer's Sheet). */
export const typeKeys = (text: string): Promise<void> => userEvent.keyboard(text);
