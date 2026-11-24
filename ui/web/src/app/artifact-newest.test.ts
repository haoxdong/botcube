import { afterEach, expect, it, vi } from 'vitest';
import { HttpStatusError } from '../computer/files-upload';
import { listFiles } from '../computer/files-service';
import { agentFiles } from './agent-files';
import { newestInFiles } from './artifact-newest';
import { filesPath } from './files-path';

vi.mock('../computer/files-service', async (original) => ({ ...await original<typeof import('../computer/files-service')>(), listFiles: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each([
  ['/plan.md', '/artifacts/plan.md.versions/1.md', ''],
  ['/budget.sheet.json', '/artifacts/budget.sheet.json.versions/1.sheet.json', ''],
  ['/chart.html', '/artifacts/chart.html.versions/1.html', ''],
  ['/deck', '/artifacts/deck.versions/1', '/project/deck.json'],
])('discovers the newest stored version without requesting a missing download for %s', async (id, path, stored) => {
  const known = { id: filesPath(id), version: 1, path: filesPath(path) };
  vi.mocked(listFiles).mockResolvedValue([{ name: `${path.slice(1)}${stored}`, size: 1, lastModified: '2026-11-15T18:00:00Z' }]);
  const download = vi.spyOn(agentFiles, 'url').mockRejectedValue(new HttpStatusError(404, 'No such file'));
  const read = vi.fn();
  expect(await newestInFiles(known, { read })).toBe(known);
  expect(download).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

// A version the agent published under its workspace root is found by its Files name, which the Chat Service reads.
it.each(['', '/mnt/corporate/files'])('reads the record of a newer listed version for workspace %s', async (root) => {
  vi.mocked(listFiles).mockResolvedValue([
    { name: 'artifacts/plan.md.versions/2.md', size: 1, lastModified: '2026-11-15T18:00:00Z' },
    { name: 'artifacts/plan.md.versions/3.json', size: 1, lastModified: '2026-11-15T18:00:00Z' },
  ]);
  const read = vi.fn().mockResolvedValue(JSON.stringify({ author: 'user', title: 'Plan', description: 'Updated plan' }));
  expect(await newestInFiles({ id: filesPath('/plan.md'), version: 1, path: filesPath(`${root}/artifacts/plan.md.versions/1.md`) }, { read })).toEqual({
    id: '/plan.md', version: 2, path: '/artifacts/plan.md.versions/2.md', author: 'user', title: 'Plan', description: 'Updated plan',
  });
  expect(read).toHaveBeenCalledWith('/artifacts/plan.md.versions/2.json');
});

it('reports listing failures instead of assuming there is no newer version', async () => {
  vi.mocked(listFiles).mockRejectedValue(new Error('Files unavailable'));
  await expect(newestInFiles({ id: filesPath('/plan.md'), version: 1, path: filesPath('/artifacts/plan.md.versions/1.md') }, { read: vi.fn() })).rejects.toThrow('Files unavailable');
});
