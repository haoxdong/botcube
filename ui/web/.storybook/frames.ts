import { commands } from 'vitest/browser';

/** An element as the browser shows it: its text, computed color, data attributes, height, and whether its document loaded. */
export type ShownElement = { text: string | null; color: string; data: Record<string, string>; height: number; loaded: boolean };

/**
 * Which frame to read under the frame named `name`: the innermost, following each first child (the default), or the
 * one reached through iframes with these titles, in order (an empty list reads the named frame itself).
 */
export type FramePath = string[] | undefined;

declare module 'vitest/browser' {
  interface BrowserCommands {
    readFrame: (name: string, selector: string, path?: FramePath) => Promise<ShownElement[]>;
    holdFrameElement: (name: string, selector: string, path?: FramePath) => Promise<number>;
    frameElementHeld: (held: number) => Promise<boolean>;
  }
}

/**
 * The last element matching `selector` in a frame under the frame named `name` (see FramePath), or null when none
 * does. Reads frames a story's page cannot, such as one with an opaque origin, through the browser driver.
 */
export const readFrame = async (name: string, selector: string, path?: FramePath) =>
  (await commands.readFrame(name, selector, path)).at(-1) ?? null;

/** Every element matching `selector` in a frame under the frame named `name`, in document order. */
export const readFrameAll = (name: string, selector: string, path?: FramePath) => commands.readFrame(name, selector, path);

/**
 * Keeps hold of the first element matching `selector` in a frame under `name`; `stillShown` then says whether that
 * same element is still in its document, which it is not once the frame reloads.
 */
export async function holdFrameElement(name: string, selector: string, path?: FramePath) {
  const held = await commands.holdFrameElement(name, selector, path);
  return { stillShown: () => commands.frameElementHeld(held) };
}
