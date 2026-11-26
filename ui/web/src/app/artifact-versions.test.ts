import { describe, expect, it } from 'vitest';

import { listArtifacts } from './artifact-versions';

const file = (name: string, lastModified = '2026-11-15T08:00:00Z') => ({ name, lastModified, size: 12 });
const record = async (path: string) => JSON.stringify({ author: 'agent', title: path, description: '' });

describe('the User’s Artifact library', () => {
  it('lists the newest completed version of each type, newest first, without plain Files, records or unfinished publishes', async () => {
    const artifacts = await listArtifacts({ list: async () => [
      file('artifacts/budget.sheet.json.versions/1.sheet.json', '2026-11-14T08:00:00Z'),
      file('artifacts/budget.sheet.json.versions/2.sheet.json'),
      file('artifacts/budget.sheet.json.versions/3.json'),
      file('artifacts/budget.sheet.json.versions/read.json'),
      file('artifacts/page.html.versions/1.html', '2026-11-13T08:00:00Z'),
      file('artifacts/plan.md.versions/1.md', '2026-11-12T08:00:00Z'),
      file('artifacts/draft.email.json.versions/1.email.json', '2026-11-11T08:00:00Z'),
      file('artifacts/decks/q3.versions/1/project/deck.json', '2026-11-10T08:00:00Z'),
      file('artifacts/decks/q3.versions/1/project/slides/cover.html'),
      file('budget.xlsx'), file('report.pdf'), file('plan.docx'),
    ], read: record });
    expect(artifacts.map(({ id, version, type, path }) => ({ id, version, type, path }))).toEqual([
      { id: '/budget.sheet.json', version: 2, type: 'sheet', path: '/artifacts/budget.sheet.json.versions/2.sheet.json' },
      { id: '/page.html', version: 1, type: null, path: '/artifacts/page.html.versions/1.html' },
      { id: '/plan.md', version: 1, type: 'doc', path: '/artifacts/plan.md.versions/1.md' },
      { id: '/draft.email.json', version: 1, type: 'email', path: '/artifacts/draft.email.json.versions/1.email.json' },
      { id: '/decks/q3', version: 1, type: 'slides', path: '/artifacts/decks/q3.versions/1' },
    ]);
    expect(artifacts[4]?.title).toBe('/artifacts/decks/q3.versions/1.json');
  });

  it('returns an empty library and propagates a failed record read', async () => {
    expect(await listArtifacts({ list: async () => [], read: record })).toEqual([]);
    await expect(listArtifacts({ list: async () => [file('artifacts/page.html.versions/1.html')], read: async () => { throw new Error('Files unavailable'); } })).rejects.toThrow('Files unavailable');
  });
});

it('orders publication timestamps by their instant across UTC offsets', async () => {
  const artifacts = await listArtifacts({ list: async () => [
    file('artifacts/local.md.versions/1.md', '2026-11-15T09:00:00+03:00'),
    file('artifacts/newer.html.versions/1.html', '2026-11-15T07:00:00Z'),
  ], read: record });
  expect(artifacts.map(({ id }) => id)).toEqual(['/newer.html', '/local.md']);
});
