import { constants } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http-error.js';

export const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;

/** An account's Files, read and written only along paths with no symbolic link, and never past their root. */
export class AccountTree {
  private constructor(private readonly root: string) {}

  /** `directory` itself may be reached through links, as the mount is; nothing under it may be. */
  static async at(directory: string): Promise<AccountTree> {
    return new AccountTree(await realpath(directory));
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
   * A regular file at `name`, opened without following a link even if one replaced it since the walk.
   * Throws ENOENT when there is none, and refuses anything that is not a regular file.
   */
  async open(name: string, flags: number, mode?: number): Promise<FileHandle> {
    await this.refuseLink(name);
    const file = await open(this.full(name), flags | constants.O_NOFOLLOW, mode).catch((error: unknown) => {
      throw errorCode(error) === 'ELOOP' ? this.linked(name) : error;
    });
    if (!(await file.stat()).isFile()) {
      await file.close();
      throw new HttpError(400, `/${name} in Files is not a file`);
    }
    return file;
  }

  /** Gives `from` the name `to` without ever replacing a file there: link refuses a taken name. */
  async moveNoClobber(from: string, to: string): Promise<boolean> {
    await this.refuseLink(from);
    return this.linkInto(this.full(from), to);
  }

  /** Moves the file at the absolute path `source`, already checked by its own tree, to `to` here, never replacing one. */
  async linkInto(source: string, to: string): Promise<boolean> {
    await this.folders(path.posix.dirname(to));
    await this.refuseLink(to);
    try {
      // link never follows `source` itself, and every folder of `to` was just checked.
      await link(source, this.full(to));
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }
    await unlink(source);
    return true;
  }

  /** Removes the file at `name`: a link there is removed itself, never what it points at. */
  async unlink(name: string): Promise<void> {
    const folder = path.posix.dirname(name);
    if (folder !== '.') await this.refuseLink(folder);
    await unlink(this.full(name));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.refuseLink(from);
    await this.refuseLink(to);
    await rename(this.full(from), this.full(to));
  }

  async remove(name: string): Promise<void> {
    await this.refuseLink(path.posix.dirname(name));
    await rm(this.full(name), { recursive: true, force: true });
  }

  async refuseLink(name: string): Promise<void> {
    const segments = name.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new HttpError(400, `${name} is not a path in Files`);
    await this.walk(segments, 1);
  }

  /** Makes each folder of `folder` from the root in turn, refusing a link or a file in the way. */
  async folders(folder: string, depth = 1): Promise<void> {
    // A file at the root of Files has no folder to make: its dirname is `.`.
    if (folder === '.') return;
    const segments = folder.split('/');
    if (depth > segments.length) return;
    const walked = segments.slice(0, depth).join('/');
    await this.refuseLink(walked);
    await mkdir(this.full(walked)).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    if (!(await lstat(this.full(walked))).isDirectory()) throw new HttpError(400, `/${walked} in Files is not a folder`);
    await this.folders(folder, depth + 1);
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
