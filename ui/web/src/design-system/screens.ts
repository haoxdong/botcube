// The two screens every whole-app story runs at (ADR 0094). A headless browser reports no safe-area insets, so a
// story sets the inset tokens, the one place the insets are read (tokens.css), to the phone's own.

type Insets = { top: number; right: number; bottom: number; left: number };
export type Screen = { name: string; width: number; height: number; insets: Insets };

export const IPHONE_15: Screen = { name: 'iPhone 15', width: 390, height: 844, insets: { top: 59, right: 0, bottom: 34, left: 0 } };
export const IPHONE_15_LANDSCAPE: Screen = { name: 'iPhone 15 landscape', width: 844, height: 390, insets: { top: 0, right: 59, bottom: 21, left: 59 } };
export const DESKTOP_1440: Screen = { name: '1440', width: 1440, height: 900, insets: { top: 0, right: 0, bottom: 0, left: 0 } };

export const insetTokens = ({ insets }: Screen): Record<string, string> =>
  Object.fromEntries(Object.entries(insets).map(([side, px]) => [`--app-safe-${side}`, `${px}px`]));
