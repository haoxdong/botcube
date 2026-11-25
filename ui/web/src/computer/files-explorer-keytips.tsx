// File Explorer's keytips: Alt shows each command's letter, and the letter runs it, from fluentui-contrib's keytips
// (ADR 0093).
import { Keytips, useKeytipRef, useKeytipsManager } from '@fluentui-contrib/react-keytips';
import { MenuItem, type MenuItemProps } from '@fluentui/react-components';
import { useRef, type KeyboardEvent } from 'react';

/**
 * Each command's letter. Where Windows Explorer has one, it is Windows' access key: New N, Cut X, Copy C, Paste V, Rename
 * M and Delete D on the bar; Open O, Cut T, Copy C, Rename M, Delete D, Copy as path A and Properties R on an item;
 * View V, Sort by O, Group by P, Refresh E, New W and Properties R on the folder. Any other takes the first letter of its
 * name its neighbours leave free: Download O on the bar and W on an item, Sort S, See more E, and View I and Paste A
 * where V and P are taken.
 */
export const LETTERS = {
  commands: { new: 'n', cut: 'x', copy: 'c', paste: 'v', download: 'o', rename: 'm', delete: 'd', view: 'i', sort: 's', more: 'e' },
  row: { Open: 'o', Cut: 't', Copy: 'c', Download: 'w', Rename: 'm', Delete: 'd', 'Copy path': 'a', Properties: 'r' },
  folder: { View: 'v', 'Sort by': 'o', 'Group by': 'p', Refresh: 'e', Paste: 'a', New: 'w', Properties: 'r' },
} as const;

/** Runs a keytip's command: a click of the part it is on. */
const click = (_: unknown, { targetElement }: { targetElement: HTMLElement | null }) => targetElement?.click();

/**
 * A keytip on a part, by its letter. While `on` is false (its tab hidden, or a context menu open over the bar) the
 * keytip moves off the first level, so Alt shows only the letters of what is in front.
 */
export function useKeytip(letter: string, on = true) {
  return useKeytipRef<HTMLElement>({ keySequences: on ? [letter] : ['~', letter], content: letter.toUpperCase(), onExecute: click });
}

/** A menu item with its keytip. */
export function KeyedMenuItem({ letter, ...props }: MenuItemProps & { letter: string }) {
  return <MenuItem {...props} ref={useKeytip(letter)} />;
}

/**
 * The window's keytips, and its keys for them: Alt pressed and let go on its own shows the letters, as Windows does;
 * Alt held with another key is that key's shortcut instead. `showing` says whether the letters are up, while the next
 * key is a letter's, not a shortcut's.
 */
export function useWindowKeytips() {
  const { enterKeytipMode, exitKeytipMode } = useKeytipsManager();
  const showing = useRef(false);
  const altAlone = useRef(false);
  const onKeyDown = (event: KeyboardEvent) => { altAlone.current = event.key === 'Alt' && !event.repeat ? true : event.key === 'Alt' && altAlone.current; };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== 'Alt' || !altAlone.current) return;
    altAlone.current = false;
    event.preventDefault();
    if (showing.current) exitKeytipMode();
    else enterKeytipMode();
  };
  const keytips = <Keytips onEnterKeytipsMode={() => { showing.current = true; }} onExitKeytipsMode={() => { showing.current = false; }} />;
  return { keytips, showing, onKeyDown, onKeyUp };
}
