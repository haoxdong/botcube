/** An Artifact Type as the version store names it. */
export type StoredType = 'slides' | 'doc' | 'sheet' | 'email' | 'page';
/** What follows a version's number: none for a folder. */
export function suffixOf(type: StoredType): string;
/** The folder of every version of the Source `source`, a Files name. */
export function versionsFolder(source: string): string;
export function versionName(source: string, version: number, type: StoredType): string;
export function recordName(source: string, version: number): string;
/** The version an entry of a versions folder (`2.md`, `1`) is; null for a record or anything else. */
export function versionOf(entry: string): { version: number; type: StoredType } | null;
/** The version whose record the Files name `name` is, or null. */
export function recordedVersion(name: string): { source: string; version: number } | null;
/** The version whose `stored` file the Files name `name` is, or null. */
export function storedVersion(name: string): { source: string; version: number; type: StoredType; name: string } | null;
