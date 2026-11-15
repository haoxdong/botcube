import { afterEach, expect, it, vi } from 'vitest';
import { HttpStatusError } from '../computer/files-upload';
import { listFiles } from '../computer/files-service';
import { agentFiles } from './agent-files';
import { newestInFiles } from './artifact-newest';

vi.mock('../computer/files-service', async (original) => ({ ...await original<typeof import('../computer/files-service')>(), listFiles: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each([
  ['/artifacts/plan.md.versions/1.md', ''],
  ['/artifacts/budget.sheet.json.versions/1.sheet.json', ''],
  ['/artifacts/chart.html.versions/1.html', ''],
  ['/artifacts/deck.versions/1', '/project/deck.json'],
])('discovers the newest stored version without requesting a missing download for %s', async (path, stored) => {
  const known = { version: 1, path };
  vi.mocked(listFiles).mockResolvedValue([{ name: `${path.slice(1)}${stored}`, size: 1, lastModified: '2026-11-15T18:00:00Z' }]);
  const download = vi.spyOn(agentFiles, 'url').mockRejectedValue(new HttpStatusError(404, 'No such file'));
  const read = vi.fn();
  expect(await newestInFiles(known, stored, read)).toBe(known);
  expect(download).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it('reads the committed record of a newer listed version', async () => {
  vi.mocked(listFiles).mockResolvedValue([
    { name: 'artifacts/plan.md.versions/2.md', size: 1, lastModified: '2026-11-15T18:00:00Z' },
    { name: 'artifacts/plan.md.versions/3.json', size: 1, lastModified: '2026-11-15T18:00:00Z' },
  ]);
  const read = vi.fn().mockResolvedValue(JSON.stringify({ author: 'user', title: 'Plan', description: 'Updated plan' }));
  expect(await newestInFiles({ version: 1, path: '/artifacts/plan.md.versions/1.md' }, '', read)).toEqual({
    version: 2, path: '/artifacts/plan.md.versions/2.md', author: 'user', title: 'Plan', description: 'Updated plan',
  });
  expect(read).toHaveBeenCalledWith('/artifacts/plan.md.versions/2.json');
});

it('reports listing failures instead of assuming there is no newer version', async () => {
  vi.mocked(listFiles).mockRejectedValue(new Error('Files unavailable'));
  await expect(newestInFiles({ version: 1, path: '/artifacts/plan.md.versions/1.md' }, '', vi.fn())).rejects.toThrow('Files unavailable');
});
