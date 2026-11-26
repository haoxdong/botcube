import { constants } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http-error.js';

export const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;

/**
 * An account's Files, read and written only along paths with no symbolic link, and never past their root.
 * The lstat walk in `refuseLink` is the fast path. Every operation then goes through its folder, opened one folder
 * at a time from the root with O_NOFOLLOW and checked by the realpath of its fd: the agent can swap a folder for a link
 * after the walk looked, and only what was actually opened is trusted.
 */
export class AccountTree {
  private constructor(private readonly root: string) {}

  /** `directory` itself may be reached through links, as the mount is; nothing under it may be. */
  static async at(directory: string): Promise<AccountTree> {
    return new AccountTree(await realpath(directory));
  }

  static async account(directory: string, create = false): Promise<AccountTree | null> {
    if (create) await mkdir(directory).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    const status = await lstat(directory).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (status === null) return null;
    if (!status.isDirectory()) throw new HttpError(400, 'Files directory is not a folder');
    return AccountTree.at(directory);
  }

  async names(folder: string): Promise<string[]> {
    await this.refuseLink(folder);
    try {
      return await readdir(this.full(folder));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  async files(folder: string): Promise<string[]> {
    await this.refuseLink(folder);
    const entries = await readdir(this.full(folder), { withFileTypes: true });
    const linked = entries.find((entry) => entry.isSymbolicLink());
    if (linked !== undefined) throw this.linked(`${folder}/${linked.name}`);
    const found = await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) return (await this.files(`${folder}/${entry.name}`)).map((name) => `${entry.name}/${name}`);
      return entry.isFile() ? [entry.name] : [];
    }));
    return found.flat();
  }

  async copy(from: string, to: string, folder: boolean): Promise<void> {
    if (!folder) {
      await this.copyFile(from, to);
      return;
    }

    await this.refuseLink(from);
    const source = await this.pin(from.split('/'), false);
    try {
      const entries = await readdir(`/proc/self/fd/${source.fd}`, { withFileTypes: true });
      await this.folders(to);
      const copied = await Promise.allSettled(entries.map((entry) =>
        this.copy(`${from}/${entry.name}`, `${to}/${entry.name}`, entry.isDirectory())));
      const failed = copied.find((entry) => entry.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
    } finally {
      await source.close();
    }
  }

  /**
   * Copies the folder `from`, with everything in it, to a new folder `to`; false when anything is at `to`, which is
   * never replaced. Each folder is read through its own pinned fd and each file opened with O_NOFOLLOW, so a link
   * anywhere inside, even one swapped in mid-copy, refuses the copy, and the part already made is removed.
   */
  async copyFolderNoClobber(from: string, to: string): Promise<boolean> {
    await this.refuseLink(from);
    if (!await this.makeFolder(to)) return false;
    try {
      await this.copyEntries(from, to);
    } catch (error) {
      await this.removeTree(to);
      throw error;
    }
    return true;
  }

  /** Copies what the folder `from` holds into the new, empty folder `to`, one entry at a time, never following a link. */
  private async copyEntries(from: string, to: string): Promise<void> {
    const source = await this.pin(from.split('/'), false);
    let entries;
    try {
      entries = await readdir(`/proc/self/fd/${source.fd}`, { withFileTypes: true });
    } finally {
      await source.close();
    }
    for (const entry of entries) {
      const [inside, made] = [`${from}/${entry.name}`, `${to}/${entry.name}`];
      if (entry.isSymbolicLink()) throw this.linked(inside);
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop -- one entry at a time keeps the open fds bounded by the depth
        if (!await this.makeFolder(made)) throw Object.assign(new Error(`${made} appeared mid-copy`), { code: 'EEXIST' });
        // eslint-disable-next-line no-await-in-loop -- one entry at a time
        await this.copyEntries(inside, made);
      } else {
        // A file opens with O_NOFOLLOW and must be a regular file: a link swapped in since the read is refused.
        // eslint-disable-next-line no-await-in-loop -- one entry at a time
        await this.copyFile(inside, made);
      }
    }
  }

  /** Streams the file `from` into a new file `to`, fd to fd: EEXIST when anything is at `to`, which is never replaced. */
  private async copyFile(from: string, to: string): Promise<void> {
    const source = await this.open(from, constants.O_RDONLY);
    try {
      await this.folders(path.posix.dirname(to));
      const target = await this.open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o640);
      try {
        await target.writeFile(source.createReadStream({ autoClose: false }));
      } catch (error) {
        await this.unlink(to);
        throw error;
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  }

  async read(name: string): Promise<Buffer> {
    const file = await this.open(name, constants.O_RDONLY);
    try {
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async write(name: string, data: string | Buffer, mode: 'new' | 'replace'): Promise<void> {
    await this.folders(path.posix.dirname(name));
    const file = await this.open(name, constants.O_WRONLY | constants.O_CREAT | (mode === 'new' ? constants.O_EXCL : constants.O_TRUNC), 0o640);
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
  }

  /**
   * A regular file at `name`, opened through its pinned folder with O_NOFOLLOW, so a link that replaced it, or a folder
   * on its way, since the walk is refused. Throws ENOENT when there is none, and refuses anything that is not a regular file.
   */
  async open(name: string, flags: number, mode?: number): Promise<FileHandle> {
    // O_NONBLOCK, which a regular file ignores, opens a FIFO at once so the check below refuses it, never waiting for its
    // other end; ENXIO is a FIFO opened to write with no reader.
    const file = await this.inFolder(name, (flags & constants.O_CREAT) !== 0, (at) => open(at, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode))
      .catch((error: unknown) => {
        if (errorCode(error) === 'ENXIO') throw new HttpError(400, `/${name} in Files is not a file`);
        throw errorCode(error) === 'ELOOP' ? this.linked(name) : error;
      });
    try {
      await this.refuseOutside(file, name);
      if (!(await file.stat()).isFile()) throw new HttpError(400, `/${name} in Files is not a file`);
    } catch (error) {
      await file.close();
      throw error;
    }
    return file;
  }

  /** Gives `from` the name `to` without ever replacing a file there: link refuses a taken name. */
  async moveNoClobber(from: string, to: string): Promise<boolean> {
    return this.moveTo(this, from, to);
  }

  /** Makes the folder `name`, its parents too; false when anything is already there, which is never replaced. */
  async makeFolder(name: string): Promise<boolean> {
    return this.inFolder(name, true, async (at) => {
      try {
        await mkdir(at, 0o750);
        return true;
      } catch (error) {
        if (errorCode(error) === 'EEXIST') return false;
        throw error;
      }
    });
  }

  async isFolder(name: string): Promise<boolean> {
    return this.inFolder(name, false, async (at) => (await lstat(at)).isDirectory());
  }

  /**
   * Gives the folder `from` the name `to`, false when anything is there: rename(2) would replace an empty folder, so
   * `to` is looked for first through its pinned folder. One made there between the look and the rename is replaced.
   */
  async moveFolderNoClobber(from: string, to: string): Promise<boolean> {
    return this.inFolder(from, false, (source) => this.inFolder(to, true, async (target) => {
      const taken = await lstat(target).then(() => true, (error: unknown) => {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
      });
      if (!taken) await rename(source, target);
      return !taken;
    }));
  }

  /** Moves the file at `from` here to `to` in `destination`, never replacing one there: both go through their pinned folders. */
  async moveTo(destination: AccountTree, from: string, to: string): Promise<boolean> {
    return this.inFolder(from, false, (source) => destination.inFolder(to, true, async (target) => {
      try {
        // link never follows `source` itself, and both folders are the ones opened and checked.
        await link(source, target);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') return false;
        throw error;
      }
      await unlink(source);
      return true;
    }));
  }

  /** Removes the file at `name`: a link there is removed itself, never what it points at. */
  async unlink(name: string): Promise<void> {
    await this.inFolder(name, false, (at) => unlink(at), 'itself');
  }

  async rename(from: string, to: string): Promise<void> {
    await this.inFolder(from, false, (source) => this.inFolder(to, false, (target) => rename(source, target)));
  }

  async remove(name: string): Promise<void> {
    await this.removeTree(name);
  }

  /**
   * Removes `name` and everything under it, or with no name everything in the tree, as `rm -rf` would, but never
   * by path: each folder is opened through its parent's fd with O_NOFOLLOW and read through its own fd, and anything
   * that is not a folder, a link included, is unlinked itself. A folder swapped for a link mid-walk is never entered.
   * Something already gone is fine.
   */
  async removeTree(name?: string): Promise<void> {
    try {
      if (name === undefined) {
        const root = await this.pin([], false);
        try {
          await this.removeEntries(root);
        } finally {
          await root.close();
        }
        return;
      }
      await this.inFolder(name, false, (at) => this.removeAt(at), 'itself');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  async refuseLink(name: string): Promise<void> {
    const segments = name.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new HttpError(400, `${name} is not a path in Files`);
    await this.walk(segments, 1);
  }

  /** Makes each folder of `folder` from the root in turn, refusing a link or a file in the way. */
  async folders(folder: string): Promise<void> {
    // A file at the root of Files has no folder to make: its dirname is `.`.
    if (folder === '.') return;
    await this.refuseLink(folder);
    await (await this.pin(folder.split('/'), true)).close();
  }

  /**
   * Runs `body` on `name` as a path through its folder's open fd: the kernel resolves it through that folder, so
   * swapping a folder on the way for a link after the walk no longer redirects it. A `link` that acts on a link
   * `itself` (unlink, rm) may find one at `name`; only its folders are refused.
   */
  private async inFolder<T>(name: string, create: boolean, body: (at: string) => Promise<T>, link: 'refused' | 'itself' = 'refused'): Promise<T> {
    const folder = path.posix.dirname(name);
    const leaf = path.posix.basename(name);
    if (leaf === '' || leaf === '.' || leaf === '..' || leaf.includes('/')) throw new HttpError(400, `${name} is not a path in Files`);
    if (link === 'refused') await this.refuseLink(name);
    else if (folder !== '.') await this.refuseLink(folder);
    const handle = await this.pin(folder === '.' ? [] : folder.split('/'), create);
    try {
      return await body(`/proc/self/fd/${handle.fd}/${leaf}`);
    } finally {
      await handle.close();
    }
  }

  /**
   * Opens the root, then each folder in `segments` through the one before it with O_NOFOLLOW, making it first when
   * `create`: a link on the way fails the open itself. The last folder's fd must then resolve inside the root.
   */
  private async pin(segments: readonly string[], create: boolean): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let folder = await open(this.root, flags);
    try {
      for (const [index, segment] of segments.entries()) {
        const next = `/proc/self/fd/${folder.fd}/${segment}`;
        const walked = segments.slice(0, index + 1).join('/');
        // eslint-disable-next-line no-await-in-loop -- each folder through the one opened before it
        if (create) await mkdir(next).catch((error: unknown) => {
          if (errorCode(error) !== 'EEXIST') throw error;
        });
        // eslint-disable-next-line no-await-in-loop -- each folder through the one opened before it
        const opened = await open(next, flags).catch(async (error: unknown) => {
          // O_DIRECTORY | O_NOFOLLOW fails a link with ENOTDIR on Linux, as it does a file.
          if (errorCode(error) === 'ELOOP' || (errorCode(error) === 'ENOTDIR' && (await lstat(next)).isSymbolicLink())) throw this.linked(walked);
          if (errorCode(error) === 'ENOTDIR') throw new HttpError(400, `/${walked} in Files is not a folder`);
          throw error;
        });
        // eslint-disable-next-line no-await-in-loop -- closes the folder before it
        await folder.close();
        folder = opened;
      }
      await this.refuseOutside(folder, segments.join('/'));
      return folder;
    } catch (error) {
      await folder.close().catch(() => undefined);
      throw error;
    }
  }

  private async removeAt(at: string): Promise<void> {
    const folder = await open(at, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error: unknown) => {
      // A file, or a link (O_DIRECTORY | O_NOFOLLOW fails one with ENOTDIR or ELOOP): removed itself.
      if (errorCode(error) === 'ENOTDIR' || errorCode(error) === 'ELOOP') return null;
      throw error;
    });
    if (folder === null) {
      await unlink(at);
      return;
    }
    try {
      await this.removeEntries(folder);
    } finally {
      await folder.close();
    }
    await rmdir(at);
  }

  private async removeEntries(folder: FileHandle): Promise<void> {
    const listed = `/proc/self/fd/${folder.fd}`;
    for (const entry of await readdir(listed)) {
      // eslint-disable-next-line no-await-in-loop -- one entry at a time keeps the open fds bounded by the depth
      await this.removeAt(`${listed}/${entry}`).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
  }

  /** Refuses an open fd that resolves outside the root, as the kernel sees it now. */
  private async refuseOutside(handle: FileHandle, name: string): Promise<void> {
    const opened = await realpath(`/proc/self/fd/${handle.fd}`);
    if (opened !== this.root && !opened.startsWith(`${this.root}${path.sep}`)) throw this.linked(name);
  }

  /** Each folder from the root in turn, down to the first that does not exist yet: none may be a link or lead out. */
  private async walk(segments: readonly string[], depth: number): Promise<void> {
    if (depth > segments.length) return;
    const walked = segments.slice(0, depth).join('/');
    const status = await lstat(this.full(walked)).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (status === null) return;
    if (status.isSymbolicLink()) throw this.linked(walked);
    const resolved = await realpath(this.full(walked));
    if (!resolved.startsWith(`${this.root}${path.sep}`)) throw this.linked(walked);
    await this.walk(segments, depth + 1);
  }

  private full(name: string): string {
    return path.join(this.root, name);
  }

  private linked(name: string): HttpError {
    return new HttpError(400, `/${name} in Files is a symbolic link, which Files never follows`);
  }
}
