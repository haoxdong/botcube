import { commands } from 'vitest/browser';

/** An element as the browser shows it: its text, its computed color, and whether its document has loaded. */
export type ShownElement = { text: string | null; color: string; loaded: boolean };

declare module 'vitest/browser' {
  interface BrowserCommands {
    readFrame: (name: string, selector: string) => Promise<ShownElement | null>;
  }
}

/**
 * The last element matching `selector` in the innermost frame under the frame named `name`, or null when none does.
 * Reads frames a story's page cannot, such as one with an opaque origin, through the browser driver.
 */
export const readFrame = (name: string, selector: string) => commands.readFrame(name, selector);
