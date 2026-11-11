/** An element an Email's htmlBody may hold: its attributes, what it is, and a sample of it. */
export type EmailElement = { kind: 'block' | 'inline' | 'list' | 'item'; attributes: readonly string[]; sample: string };
export const EMAIL_ELEMENTS: Record<string, EmailElement>;
export const EMAIL_HREF: RegExp;
export const NEAREST_EMAIL: Record<string, string>;
