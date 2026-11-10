import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { link, mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/** @type {import('./files.mjs').Disk} */
export const disk = {
  async stat(file) {
    try {
      const found = await stat(file);
      return found.isFile() ? { size: found.size } : null;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
      throw error;
    }
  },
  async write(file, offset, body) {
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, offset === 0 ? 'w' : constants.O_WRONLY | constants.O_CREAT);
    try {
      await handle.write(body, 0, body.length, offset);
    } finally {
      await handle.close();
    }
  },
  async finish(part, file, size, sha256) {
    const found = await disk.stat(part);
    if (found?.size !== size) return 'incomplete';
    const hash = createHash('sha256');
    await pipeline(createReadStream(part, { highWaterMark: 1 << 20 }), hash);
    if (hash.digest('hex') !== sha256) return 'incomplete';
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await link(part, file);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') return 'exists';
      throw error;
    }
    await unlink(part);
    return 'created';
  },
};

