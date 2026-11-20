import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/** @typedef {import('node:fs/promises').FileHandle} FileHandle */

const REFUSED = 'refused';
/** @param {unknown} error */
const codeOf = (error) => /** @type {NodeJS.ErrnoException} */ (error).code;
/** A path through an open folder: it resolves through the folder itself, so swapping a folder on the way for a link no longer redirects it. @param {FileHandle} folder @param {string} name */
const within = (folder, name) => `/proc/self/fd/${folder.fd}/${name}`;

/** Whether what `handle` opened is `root` or lies inside it, as the kernel sees it now. @param {FileHandle} handle @param {string} root */
async function inside(handle, root) {
  const opened = await realpath(`/proc/self/fd/${handle.fd}`);
  return opened === root || opened.startsWith(`${root}${path.sep}`);
}

/**
 * The folder holding `file`, opened one folder at a time from `directory` with O_NOFOLLOW, each through the one before:
 * a folder on the way that is, or has since become, a symbolic link is refused, never followed.
 * `create` makes missing folders; without it a missing folder answers null.
 * @param {string} directory @param {string} file @param {boolean} create
 * @returns {Promise<FileHandle | null | typeof REFUSED>}
 */
async function folderOf(directory, file, create) {
  // An account's first upload can come before its first mount made its folder. The account folder is the agent's
  // mount root, which it cannot replace; everything below it is walked by fd.
  if (create) await mkdir(directory, { recursive: true });
  const root = await realpath(directory).catch((error) => {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  });
  if (root === null) return null;
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  /** @type {FileHandle | null} */
  let folder = await open(root, flags);
  try {
    for (const segment of path.relative(directory, path.dirname(file)).split(path.sep).filter(Boolean)) {
      const next = within(folder, segment);
      // eslint-disable-next-line no-await-in-loop -- each folder through the one opened before it
      if (create) await mkdir(next).catch((error) => { if (codeOf(error) !== 'EEXIST') throw error; });
      // eslint-disable-next-line no-await-in-loop -- each folder through the one opened before it
      const opened = await open(next, flags).catch((error) => {
        if (codeOf(error) === 'ENOENT') return null;
        if (codeOf(error) === 'ELOOP' || codeOf(error) === 'ENOTDIR') return REFUSED;
        throw error;
      });
      if (opened === null || opened === REFUSED) return opened;
      // eslint-disable-next-line no-await-in-loop -- closes the folder before it
      await folder.close();
      folder = opened;
    }
    if (await inside(folder, root)) {
      const pinned = folder;
      folder = null;
      return pinned;
    }
    return REFUSED;
  } finally {
    // A warm Lambda keeps its fds: every folder not handed back is closed, on any outcome.
    await folder?.close();
  }
}

/**
 * Opens `file` in `directory` with `flags` and O_NOFOLLOW through its folder, then checks the open file is a regular file inside the account.
 * @param {string} directory @param {string} file @param {number} flags @param {boolean} create
 * @returns {Promise<FileHandle | null | typeof REFUSED>}
 */
async function openIn(directory, file, flags, create) {
  const folder = await folderOf(directory, file, create);
  if (folder === null || folder === REFUSED) return folder;
  // O_NONBLOCK: a FIFO planted in place of the file is opened without waiting for a writer, then refused as not a file.
  const handle = await open(within(folder, path.basename(file)), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o640).catch((error) => {
    if (codeOf(error) === 'ENOENT') return null;
    // ENXIO: a FIFO with no reader, opened to write.
    if (codeOf(error) === 'ELOOP' || codeOf(error) === 'ENXIO') return REFUSED;
    throw error;
  }).finally(() => folder.close());
  if (handle === null || handle === REFUSED) return handle;
  if ((await handle.stat()).isFile() && await inside(handle, await realpath(directory))) return handle;
  await handle.close();
  return REFUSED;
}

/** @type {import('./files.mjs').Disk} */
export const disk = {
  /** The fast path: whether `directory`, or any folder or file of `file` below it, is a symbolic link now; the walk stops at the first that does not exist. */
  async linked(directory, file) {
    let walked = directory;
    for (const segment of ['', ...path.relative(directory, file).split(path.sep)]) {
      walked = path.join(walked, segment);
      // eslint-disable-next-line no-await-in-loop -- each folder in turn, from the account down
      const found = await lstat(walked).catch((error) => {
        if (codeOf(error) === 'ENOENT') return null;
        throw error;
      });
      if (found === null) return false;
      if (found.isSymbolicLink()) return true;
    }
    return false;
  },
  async read(directory, file) {
    const handle = await openIn(directory, file, constants.O_RDONLY, false);
    if (handle === null || handle === REFUSED) return handle;
    return {
      size: (await handle.stat()).size,
      stream: (start, end) => handle.createReadStream({ start, end, highWaterMark: 1 << 20 }),
      close: () => handle.close(),
    };
  },
  async write(directory, file, offset, body) {
    const handle = await openIn(directory, file, constants.O_WRONLY | constants.O_CREAT | (offset === 0 ? constants.O_TRUNC : 0), true);
    if (handle === null || handle === REFUSED) return REFUSED;
    try {
      await handle.write(body, 0, body.length, offset);
    } finally {
      await handle.close();
    }
    return 'ok';
  },
  async finish(directory, part, file, size, sha256) {
    const handle = await openIn(directory, part, constants.O_RDONLY, false);
    if (handle === REFUSED) return REFUSED;
    if (handle === null) return 'incomplete';
    const hash = createHash('sha256');
    try {
      if ((await handle.stat()).size !== size) return 'incomplete';
      await pipeline(handle.createReadStream({ autoClose: false, highWaterMark: 1 << 20 }), hash);
    } finally {
      await handle.close();
    }
    if (hash.digest('hex') !== sha256) return 'incomplete';
    // link, unlink: no file of their own to check, so both go through their folders, opened and checked.
    const from = await folderOf(directory, part, false);
    if (from === null || from === REFUSED) return REFUSED;
    try {
      const to = await folderOf(directory, file, true);
      if (to === null || to === REFUSED) return REFUSED;
      try {
        await link(within(from, path.basename(part)), within(to, path.basename(file)));
      } catch (error) {
        if (codeOf(error) === 'EEXIST') return 'exists';
        throw error;
      } finally {
        await to.close();
      }
      await unlink(within(from, path.basename(part)));
      return 'created';
    } finally {
      await from.close();
    }
  },
};
