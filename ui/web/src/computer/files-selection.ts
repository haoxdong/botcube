/** The selected items of the open place, by path, and the anchor a Shift+click selects a range from. */
type Selection = { paths: readonly string[]; anchor: string | null };

export const NOTHING: Selection = { paths: [], anchor: null };

/**
 * A click on an item, as Explorer takes it: alone it selects only that item; Ctrl adds or takes it away; Shift selects
 * the range from the anchor to it, in the order shown, and Ctrl+Shift adds that range.
 */
export function clicked(selection: Selection, path: string, { toggle, range }: { toggle: boolean; range: boolean }, order: readonly string[]): Selection {
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const to = order.indexOf(path);
  if (range && from !== -1 && to !== -1) {
    const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    return { paths: toggle ? [...new Set([...selection.paths, ...span])] : span, anchor: selection.anchor };
  }
  if (!toggle) return { paths: [path], anchor: path };
  const paths = selection.paths.includes(path) ? selection.paths.filter((each) => each !== path) : [...selection.paths, path];
  return { paths, anchor: path };
}

/** Every item, in the order shown. */
export const everything = (order: readonly string[]): Selection => ({ paths: [...order], anchor: order[0] ?? null });

/** The items not selected, and none of those that were. */
export const inverted = (selection: Selection, order: readonly string[]): Selection => ({
  paths: order.filter((path) => !selection.paths.includes(path)),
  anchor: selection.anchor,
});

/** A right-click: on a selected item it keeps the selection, which its menu acts on; on another it selects that alone. */
export const pointedAt = (selection: Selection, path: string): Selection => (selection.paths.includes(path) ? selection : { paths: [path], anchor: path });
