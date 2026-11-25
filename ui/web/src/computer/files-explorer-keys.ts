import type { KeyboardEvent } from 'react';
import type { FilesItem } from './files-items';

/** What Explorer's keys do, outside a text field. */
export interface KeyActions {
  selectAll: () => void;
  rename: () => void;
  remove: () => void;
  back: () => void;
  forward: () => void;
  up: () => void;
  refresh: () => void;
  focusSearch: () => void;
  focusAddress: () => void;
  properties: () => void;
  /** Shows or hides a pane: Alt+P the Preview pane, Alt+Shift+P the Details pane. */
  togglePane: (pane: 'details' | 'preview') => void;
  /** One of the eight views, in Windows' order: Extra large icons first, Content last. */
  view: (index: number) => void;
  /** Opens the context menu of the selection, or of the folder when nothing is selected. */
  contextMenu: () => void;
  cut: () => void;
  paste: () => void;
  forgetCut: () => void;
  /** Type-to-find in the list: the letters typed so far. */
  find: (text: string) => void;
}

/** How long a pause starts type-to-find afresh, in milliseconds. */
const PAUSE = 1000;

/** The letters typed so far, and when the last one came. */
export type Typed = { text: string; at: number };

/**
 * Explorer's keys, as Windows 11 File Explorer has them: Ctrl+A; F2, Delete, Alt+Enter; Alt+Left, Alt+Right, Alt+Up and
 * Backspace, F5; Alt+D, Ctrl+L and F4 the address, Ctrl+F and Ctrl+E the search; Alt+P and Alt+Shift+P the panes;
 * Ctrl+Shift+1 to 8 the views; Shift+F10 and the menu key the context menu; Ctrl+X, Ctrl+V and Escape. In the list, a
 * letter finds the item it starts. Keys in a text field, or in a menu or dialog drawn outside the window, are left
 * alone. Returns the letters typed so far.
 */
export function onExplorerKey(event: KeyboardEvent<HTMLElement>, actions: KeyActions, { inList, typed }: { inList: boolean; typed: Typed }): Typed {
  if (leftAlone(event)) return typed;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const chords = chordsOf(event, key, actions);
  const act = Object.hasOwn(chords, key) ? chords[key] : undefined;
  if (act !== undefined) {
    event.preventDefault();
    act();
    return typed;
  }
  return inList ? typeToFind(event, key, actions, typed) : typed;
}

type Chords = Record<string, (() => void) | undefined>;

/** A key the window leaves alone: one from outside it, such as a menu drawn over it, or typed in a text field. */
function leftAlone(event: KeyboardEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof Node) || !event.currentTarget.contains(target)) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** The keys held with Ctrl (or Cmd): Ctrl+Shift+1 to 8 the views, else the selection, cut and paste, and the boxes. */
function commandChords(event: KeyboardEvent<HTMLElement>, key: string, actions: KeyActions): Chords {
  if (!event.shiftKey) return { a: actions.selectAll, f: actions.focusSearch, e: actions.focusSearch, l: actions.focusAddress, x: actions.cut, v: actions.paste };
  const digit = /^Digit([1-8])$/.exec(event.code)?.[1];
  return digit === undefined ? {} : { [key]: () => actions.view(Number(digit) - 1) };
}

/** The keys held with Alt: history, the address, Properties and the panes. */
function altChords(event: KeyboardEvent<HTMLElement>, actions: KeyActions): Chords {
  return {
    ArrowLeft: actions.back, ArrowRight: actions.forward, ArrowUp: actions.up, d: actions.focusAddress, Enter: actions.properties,
    p: () => actions.togglePane(event.shiftKey ? 'details' : 'preview'),
  };
}

/** The keys alone: renaming, deleting, going up, reloading, the address and the context menu; Shift+F10 the menu. */
function plainChords(event: KeyboardEvent<HTMLElement>, key: string, actions: KeyActions): Chords {
  if (event.shiftKey && key === 'F10') return { F10: actions.contextMenu };
  return {
    F2: actions.rename, Delete: actions.remove, Backspace: actions.up, F5: actions.refresh, Escape: actions.forgetCut, F4: actions.focusAddress,
    ContextMenu: actions.contextMenu,
  };
}

function chordsOf(event: KeyboardEvent<HTMLElement>, key: string, actions: KeyActions): Chords {
  if (event.ctrlKey || event.metaKey) return commandChords(event, key, actions);
  return event.altKey ? altChords(event, actions) : plainChords(event, key, actions);
}

/** A letter in the list finds the item it starts, the letters before it counting until a pause. */
function typeToFind(event: KeyboardEvent<HTMLElement>, key: string, actions: KeyActions, typed: Typed): Typed {
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || event.key === ' ') return typed;
  const text = event.timeStamp - typed.at > PAUSE ? key : typed.text + key;
  event.preventDefault();
  actions.find(text);
  return { text, at: event.timeStamp };
}

/**
 * The item type-to-find lands on, in the order shown: the first whose name starts with the letters typed, from the
 * current item on; one letter typed again and again steps through the items starting with it.
 */
export function foundBy(text: string, order: readonly FilesItem[], current: string | null): FilesItem | undefined {
  const repeated = [...text].every((letter) => letter === text[0]);
  const prefix = repeated ? (text[0] ?? '') : text;
  const at = Math.max(0, order.findIndex(({ path }) => path === current));
  const from = repeated && text.length > 0 && current !== null ? at + 1 : at;
  const rotated = [...order.slice(from), ...order.slice(0, from)];
  return rotated.find(({ name }) => name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()));
}
