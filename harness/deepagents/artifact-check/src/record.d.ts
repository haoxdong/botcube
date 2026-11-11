/**
 * One File a version keeps (kept_files.py): `edit` is the index of what names it in the Source (a Sheet's edit, an
 * Email's attachment), `from` the File it named and `path` the store's copy, both as Files paths.
 */
export type Imported = { edit: number; from: string; path: string };
/** An Artifact Version's record, `<n>.json` beside it: who made it, its title and description, and the Files it keeps. */
export type VersionRecord = { author: 'agent' | 'user'; title: string; description: string; imports?: Imported[] };
/** The record in `text`; throws naming what is wrong when it is not one. */
export function readRecord(text: string): VersionRecord;
