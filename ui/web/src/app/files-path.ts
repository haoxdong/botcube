declare const FILES_PATH: unique symbol;

/**
 * A file's path in Files, decoded and rooted: `/artifacts/q3 100%.md`, as the harness writes it and an upload resolves
 * to. One the agent writes may start at its workspace (`/mnt/corporate/files/…`); the Chat Service reads a reply's file
 * either way. The only place a Files path is sliced, encoded or decoded.
 */
export type FilesPath = string & { readonly [FILES_PATH]: true };

/** The path a Files path or a Files name (`artifacts/q3.md`, as Files lists it) spells. */
export const filesPath = (path: string) => (path.startsWith("/") ? path : `/${path}`) as FilesPath;

/** How the Files routes name the file: its path without the leading `/`. */
export const nameOf = (path: FilesPath) => path.slice(1);

/** The file's own name, after its folder: `q3 100%.md`. */
export const baseOf = (path: FilesPath) => path.slice(path.lastIndexOf("/") + 1);

/** The file named `base` in the same folder as `path`. */
export const besideOf = (path: FilesPath, base: string) => `${path.slice(0, path.lastIndexOf("/") + 1)}${base}` as FilesPath;

/** Where `path` is inside the folder `folder`, without a leading `/`; null when it is not inside it. */
export function underOf(folder: FilesPath, path: FilesPath): string | null {
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** The path as a link's target spells it, each segment percent-encoded: what `linkedPath` reads back. */
export const hrefOf = (path: FilesPath) => path.split("/").map(encodeURIComponent).join("/");

/**
 * The file a reply's link or image names, its target percent-encoded as markdown spells it: a rooted path, or one bare
 * file name (`report.csv`), which is at the top of Files. Null for anything else: a URL, a fragment or query, a control
 * character, or an empty, `.` or `..` segment.
 */
export function linkedPath(href: string): FilesPath | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  if (
    href.includes("#") ||
    /[\\?]/.test(decoded) ||
    [...decoded].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    decoded.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded)
  )
    return null;
  const rooted = href.startsWith("/");
  const segments = (rooted ? decoded.slice(1) : decoded).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (!rooted && (segments.length !== 1 || !/^[^@/]+\.[^./]+$/.test(decoded))) return null;
  return filesPath(decoded);
}
