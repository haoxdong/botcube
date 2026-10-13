import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { installBrowserLocks } from '../../tests/browser-locks';

vi.stubEnv('NEXT_PUBLIC_CHAT_SERVICE_URL', 'http://chat.test');
afterAll(() => {
  vi.unstubAllEnvs();
});

const { agentFiles } = await import('./agent-files');

afterEach(() => {
  vi.unstubAllGlobals();
});

// The agent writes `/chart.svg` to its files as `chart.svg`, and a reply embeds it by that path, which
// markdown hands over percent-encoded.
it("gives a reply's file path the download URL of the file it names in Files", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ url: 'https://s3.test/chart.svg?signed' }));
  vi.stubGlobal('fetch', fetchImpl);

  expect(await agentFiles.url('/spx%20closes.svg')).toBe('https://s3.test/chart.svg?signed');
  expect(fetchImpl).toHaveBeenCalledWith('http://chat.test/files/download-url?name=spx+closes.svg', { method: 'GET', credentials: 'include' });
});

// A file the user attaches in the chat goes to the top of Files, which the agent reads as `/name`.
it('uploads a file the user attached to Files, failing with what the Chat Service answered', async () => {
  installBrowserLocks();
  const fetchImpl = vi.fn(async () => Response.json({ detail: 'Files are not configured' }, { status: 503 }));
  vi.stubGlobal('fetch', fetchImpl);

  await expect(agentFiles.upload(new File(['date,close'], 'report.csv'), { onProgress: vi.fn(), signal: new AbortController().signal })).rejects.toThrow('Files are not configured');
  expect(fetchImpl).toHaveBeenCalledWith('http://chat.test/files/upload-url', expect.objectContaining({ method: 'POST', body: '{"name":"report.csv"}' }));
});
