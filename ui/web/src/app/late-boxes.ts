import { withStorage } from "./main-chat-copy";

// CSS has no cross-visit image-size memory; Streamdown supplies none.
export type Size = { width: number; height: number };

const KEY = "late-box-sizes";
/** Enough for every image in a long transcript; the oldest kept goes first. */
const LIMIT = 500;

let sizes: Map<string, Size> | null = null;
const kept = () =>
  (sizes ??= new Map(withStorage(() => JSON.parse(localStorage.getItem(KEY) ?? "[]") as [string, Size][]) ?? []));

export const sizeOf = (key: string): Size | null => kept().get(key) ?? null;

export function keepSize(key: string, size: Size) {
  const all = kept();
  const was = all.get(key);
  if (was?.width === size.width && was.height === size.height) return;
  all.delete(key);
  all.set(key, size);
  for (const oldest of all.keys()) {
    if (all.size <= LIMIT) break;
    all.delete(oldest);
  }
  withStorage(() => localStorage.setItem(KEY, JSON.stringify([...all])));
}
