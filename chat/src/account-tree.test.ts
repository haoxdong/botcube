import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountTree } from './account-tree.js';

/** Runs before every `readdir`, so a test can swap a folder after a walk found it and before it is read. */
const hooks = vi.hoisted(() => ({ beforeReaddir: null as null | (() => Promise<void>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await hooks.beforeReaddir?.();
      return Reflect.apply(actual.readdir, actual, args);
    },
  };
});

describe('an AccountTree whose folder becomes a symbolic link after the walk looked', () => {
  let base: string;
  const mine = () => path.join(base, 'mine');
  const theirs = () => path.join(base, 'theirs');
  const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(theirs())).map(async (name) => [name, await readFile(path.join(theirs(), name), 'utf8')])));

  /** The agent wins the race: right after the walk of `walked` passes, its last before the open, `reports` becomes a link to the other account. */
  const swapAfterWalk = (walked: string) => {
    const walk = AccountTree.prototype.refuseLink;
    let swapped = false;
    vi.spyOn(AccountTree.prototype, 'refuseLink').mockImplementation(async function (this: AccountTree, name: string) {
      await walk.call(this, name);
      if (swapped || name !== walked) return;
      swapped = true;
      await rename(path.join(mine(), 'reports'), path.join(mine(), 'reports.real'));
      await symlink(theirs(), path.join(mine(), 'reports'));
    });
  };

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'account-tree-'));
    await mkdir(path.join(mine(), 'reports'), { recursive: true });
    await writeFile(path.join(mine(), 'reports', 'a.txt'), 'mine');
    await writeFile(path.join(mine(), 'b.txt'), 'b');
    await mkdir(theirs());
    await writeFile(path.join(theirs(), 'a.txt'), 'theirs');
  });
  afterEach(async () => {
    hooks.beforeReaddir = null;
    vi.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  const linked = { status: 400, message: '/reports in Files is a symbolic link, which Files never follows' };

  it('refuses to read through it', async () => {
    const tree = await AccountTree.at(mine());
    swapAfterWalk('reports/a.txt');
    await expect(tree.read('reports/a.txt')).rejects.toMatchObject(linked);
  });

  it('refuses to write through it, and leaves the other account as it was', async () => {
    const tree = await AccountTree.at(mine());
    const before = await snapshot();
    swapAfterWalk('reports/a.txt');
    await expect(tree.write('reports/a.txt', 'overwritten', 'replace')).rejects.toMatchObject(linked);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to move a file into it', async () => {
    const tree = await AccountTree.at(mine());
    const before = await snapshot();
    swapAfterWalk('reports/b.txt');
    await expect(tree.moveNoClobber('b.txt', 'reports/b.txt')).rejects.toMatchObject(linked);
    expect(await snapshot()).toEqual(before);
    expect(await readFile(path.join(mine(), 'b.txt'), 'utf8')).toBe('b');
  });

  it('refuses to move a file out of it into another tree, which would take the other account\'s file', async () => {
    const source = await AccountTree.at(mine());
    const destination = await AccountTree.at(await mkdtemp(path.join(base, 'claimed-')));
    const before = await snapshot();
    swapAfterWalk('reports/a.txt');
    await expect(source.moveTo(destination, 'reports/a.txt', 'a.txt')).rejects.toMatchObject(linked);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to remove a file through it', async () => {
    const tree = await AccountTree.at(mine());
    const before = await snapshot();
    swapAfterWalk('reports');
    await expect(tree.unlink('reports/a.txt')).rejects.toMatchObject(linked);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to rename a file into it', async () => {
    const tree = await AccountTree.at(mine());
    const before = await snapshot();
    swapAfterWalk('reports/a.txt');
    await expect(tree.rename('b.txt', 'reports/a.txt')).rejects.toMatchObject(linked);
    expect(await snapshot()).toEqual(before);
  });

  describe('removing a tree', () => {
    beforeEach(async () => {
      await mkdir(path.join(mine(), 'old', 'reports'), { recursive: true });
      await writeFile(path.join(mine(), 'old', 'reports', 'c.txt'), 'c');
    });

    /** The agent wins the race mid-walk: just before the walk's `read`-th listing, `old/reports` becomes a link to the other account. */
    const swapMidWalk = (read: number) => {
      let reads = 0;
      hooks.beforeReaddir = async () => {
        reads += 1;
        if (reads !== read) return;
        hooks.beforeReaddir = null;
        await rename(path.join(mine(), 'old', 'reports'), path.join(mine(), 'old', 'reports.real'));
        await symlink(theirs(), path.join(mine(), 'old', 'reports'));
      };
    };

    it('removes a folder and everything in it, and nothing already gone is an error', async () => {
      const tree = await AccountTree.at(mine());
      await tree.removeTree('old');
      await tree.removeTree('old');
      expect((await readdir(mine())).sort()).toEqual(['b.txt', 'reports']);
    });

    it('removes a link in the tree itself, never what it points at', async () => {
      await symlink(theirs(), path.join(mine(), 'old', 'theirs'));
      const before = await snapshot();
      const tree = await AccountTree.at(mine());
      await tree.removeTree('old');
      expect(await snapshot()).toEqual(before);
    });

    it('never enters a folder swapped for a link after the walk found it', async () => {
      const tree = await AccountTree.at(mine());
      const before = await snapshot();
      // Read 1 lists `old`, read 2 lists `old/reports`, already found to be a folder.
      swapMidWalk(2);
      // The swap may leave the folder half removed; what matters is that nothing outside the tree goes.
      await tree.removeTree('old').catch(() => undefined);
      expect(await snapshot()).toEqual(before);
    });

    it('empties the whole tree the same way', async () => {
      await rm(path.join(mine(), 'reports'), { recursive: true });
      const tree = await AccountTree.at(mine());
      const before = await snapshot();
      // Read 1 lists the root, 2 lists `old`, 3 lists `old/reports`.
      swapMidWalk(3);
      await tree.removeTree().catch(() => undefined);
      expect(await snapshot()).toEqual(before);
    });
  });
});
