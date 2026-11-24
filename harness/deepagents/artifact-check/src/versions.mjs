// The version store's layout (versions.json), which the harness's `Artifact` tool writes: version `<n>` of the Source
// `<source>` (a Files name) is `artifacts/<source>.versions/<n><suffix>`, beside its record `<n>.json`; a type writes its
// `stored` file under it last. Browser-safe.
import layout from './versions.json' with { type: 'json' };

const TYPES = Object.entries(layout.types);
const IN_STORE = new RegExp(`^${layout.store}/(.+)\\${layout.folder}/(\\d+)(.*)$`);

export const suffixOf = (type) => layout.types[type].suffix;
export const versionsFolder = (source) => `${layout.store}/${source}${layout.folder}`;
export const versionName = (source, version, type) => `${versionsFolder(source)}/${version}${suffixOf(type)}`;
export const recordName = (source, version) => `${versionsFolder(source)}/${version}${layout.record}`;

/** The version an entry of a versions folder (`2.md`, `1`) is; null for a record or anything else. */
export function versionOf(entry) {
  const [, number, suffix] = /^(\d+)(.*)$/.exec(entry) ?? [];
  const type = TYPES.find(([, kind]) => kind.suffix === suffix)?.[0];
  return number === undefined || type === undefined ? null : { version: Number(number), type };
}

/** The version whose record the Files name `name` is, or null. */
export function recordedVersion(name) {
  const [, source, number, rest] = IN_STORE.exec(name) ?? [];
  return source === undefined || rest !== layout.record ? null : { source, version: Number(number) };
}

/** The version whose `stored` file the Files name `name` is, or null. */
export function storedVersion(name) {
  const [, source, number, rest] = IN_STORE.exec(name) ?? [];
  const type = source === undefined ? undefined : TYPES.find(([, kind]) => kind.suffix + kind.stored === rest)?.[0];
  return type === undefined ? null : { source, version: Number(number), type, name: versionName(source, Number(number), type) };
}
