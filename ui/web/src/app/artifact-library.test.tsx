import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { ArtifactLibrary } from './artifact-library';

const files = [
  { name: 'artifacts/page.html.versions/1.html', lastModified: '2026-11-14T08:00:00Z', size: 20 },
  { name: 'artifacts/budget.sheet.json.versions/2.sheet.json', lastModified: '2026-11-15T08:00:00Z', size: 20 },
];
function stored(list = files) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/files') return Response.json({ files: list });
    if (url.pathname === '/files/download-url') return Response.json({ url: `https://files.test/${url.searchParams.get('name')}` });
    return Response.json({ author: 'agent', title: url.pathname.includes('budget') ? 'Quarterly budget' : 'Revenue dashboard', description: '' });
  });
}
afterEach(() => vi.unstubAllGlobals());

it('lists newest first with Type icons and opens the selected Artifact', async () => {
  vi.stubGlobal('fetch', stored());
  const select = vi.fn();
  render(<ArtifactLibrary accountId="hao" onSelect={select} />);
  const list = await screen.findByRole('list', { name: 'Artifacts, newest first' });
  const cards = within(list).getAllByRole('button');
  expect(cards[0]).toHaveTextContent('Quarterly budget');
  expect(cards[1]).toHaveTextContent('Revenue dashboard');
  expect(cards[0]?.querySelector('.lucide-table-2')).toBeInTheDocument();
  await userEvent.click(within(list).getByRole('button', { name: /Quarterly budget/ }));
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: '/budget.sheet.json', type: 'sheet', version: 2 }));
});

it('shows an empty library without treating plain Files as Artifacts', async () => {
  vi.stubGlobal('fetch', stored([{ name: 'budget.xlsx', size: 20, lastModified: '2026-11-15T08:00:00Z' }]));
  render(<ArtifactLibrary accountId="hao" onSelect={vi.fn()} />);
  expect(await screen.findByText('No Artifacts yet. Artifacts you make in chat appear here.')).toBeVisible();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it('shows the Files failure and retries the catalog', async () => {
  const fetch = stored([]);
  fetch.mockResolvedValueOnce(Response.json({ detail: 'Files unavailable' }, { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  render(<ArtifactLibrary accountId="hao" onSelect={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Files unavailable');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('No Artifacts yet. Artifacts you make in chat appear here.')).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('discards an old account’s in-flight library after switching accounts', async () => {
  let release: (response: Response) => void = () => { throw new Error('No held request'); };
  const fetch = stored([]);
  fetch.mockImplementationOnce(() => new Promise<Response>((done) => { release = done; }));
  vi.stubGlobal('fetch', fetch);
  const view = render(<ArtifactLibrary accountId="first" onSelect={vi.fn()} />);
  expect(screen.getByRole('status', { name: 'Loading Artifacts' })).toBeInTheDocument();
  view.rerender(<ArtifactLibrary accountId="second" onSelect={vi.fn()} />);
  expect(await screen.findByText('No Artifacts yet. Artifacts you make in chat appear here.')).toBeVisible();
  await act(async () => { release(Response.json({ files })); });
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  expect(screen.getByText('No Artifacts yet. Artifacts you make in chat appear here.')).toBeVisible();
});
