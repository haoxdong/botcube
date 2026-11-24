import { expect, it, vi } from 'vitest';
import { agoOf, byDay, dayOf, historyOf } from './artifact-history';
import { artifactVersions } from './artifact-versions';
import { filesPath } from './files-path';

const NOW = new Date(2026, 10, 23, 16, 41);

it('lists each recorded version up to the newest, newest first, with its author and time', async () => {
  const files = [
    { name: 'artifacts/plans/q4.md.versions/1.md', size: 1, lastModified: '2026-11-21T09:30:00Z' },
    { name: 'artifacts/plans/q4.md.versions/1.json', size: 1, lastModified: '2026-11-21T09:30:00Z' },
    { name: 'artifacts/plans/q4.md.versions/2.json', size: 1, lastModified: '2026-11-22T16:12:00Z' },
    { name: 'artifacts/plans/q4.md.versions/3.json', size: 1, lastModified: '2026-11-23T14:41:00Z' },
    // A version still being written, past the newest the panel shows, and another Artifact's record.
    { name: 'artifacts/plans/q4.md.versions/4.json', size: 1, lastModified: '2026-11-23T15:00:00Z' },
    { name: 'artifacts/plans/q4.md.old.versions/1.json', size: 1, lastModified: '2026-11-20T09:00:00Z' },
  ];
  const authors: Record<string, string> = { 1: 'agent', 2: 'agent', 3: 'user' };
  const read = vi.fn(async (path: string) => JSON.stringify({ author: authors[/(\d+)\.json$/.exec(path)?.[1] ?? ''], title: 'Q4 plan', description: '' }));
  expect(await historyOf(artifactVersions(filesPath('/plans/q4.md'), { list: async () => files, read }), 3)).toEqual([
    { version: 3, author: 'user', at: new Date('2026-11-23T14:41:00Z') },
    { version: 2, author: 'agent', at: new Date('2026-11-22T16:12:00Z') },
    { version: 1, author: 'agent', at: new Date('2026-11-21T09:30:00Z') },
  ]);
  expect(read).toHaveBeenCalledWith('/artifacts/plans/q4.md.versions/3.json');
});

it.each([
  [new Date(2026, 10, 23, 0, 5), 'Today'],
  [new Date(2026, 10, 22, 23, 59), 'Yesterday'],
  [new Date(2026, 10, 21, 9, 30), 'Nov 21'],
  [new Date(2025, 11, 31, 9, 30), 'Dec 31, 2025'],
])('names the day of %s as %s', (at, day) => {
  expect(dayOf(at, NOW)).toBe(day);
});

it.each([
  [0, 'just now'],
  [5, '5m ago'],
  [120, '2h ago'],
  [3 * 24 * 60, '3d ago'],
])('says %i minutes ago as %s', (minutes, ago) => {
  expect(agoOf(new Date(NOW.getTime() - minutes * 60_000), NOW)).toBe(ago);
});

it('groups versions under their day in the order given', () => {
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour);
  const history = [
    { version: 3, author: 'user' as const, at: at(23, 14) },
    { version: 2, author: 'agent' as const, at: at(22, 16) },
    { version: 1, author: 'agent' as const, at: at(22, 9) },
  ];
  expect(byDay(history, NOW).map(({ day, versions }) => [day, versions.map(({ version }) => version)])).toEqual([['Today', [3]], ['Yesterday', [2, 1]]]);
});
