import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

// The web UI's Content Security Policy sends its violation reports here.
let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess();
});
afterAll(() => stack.stop());
afterEach(() => vi.restoreAllMocks());

const logged = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return () => log.mock.calls.filter(([tag]) => tag === 'csp-violation').map(([, line]) => JSON.parse(String(line)));
};

describe('POST /csp-report', () => {
  it("logs a browser's report-uri violation as one CloudWatch line", async () => {
    const lines = logged();
    const response = await stack.app.request('/csp-report', {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report', 'user-agent': 'Chrome/140' },
      body: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://example.com/',
          referrer: '',
          'violated-directive': 'script-src-elem',
          'effective-directive': 'script-src-elem',
          'original-policy': "default-src 'self'; report-uri https://api.example.com/csp-report",
          disposition: 'report',
          'blocked-uri': 'https://tracker.test/x.js',
          'line-number': 3,
          'column-number': 9,
          'source-file': 'https://example.com/',
          'status-code': 200,
          'script-sample': '',
        },
      }),
    });

    expect(response.status).toBe(204);
    expect(lines()).toEqual([{
      documentUri: 'https://example.com/',
      directive: 'script-src-elem',
      blockedUri: 'https://tracker.test/x.js',
      sourceFile: 'https://example.com/',
      line: 3,
      column: 9,
      disposition: 'report',
      userAgent: 'Chrome/140',
    }]);
  });

  it('logs each report of a Reporting API batch', async () => {
    const lines = logged();
    const report = (blockedURL: string) => ({
      type: 'csp-violation',
      body: { documentURL: 'https://example.com/', effectiveDirective: 'connect-src', blockedURL, disposition: 'enforce', sample: 'x' },
    });
    const response = await stack.app.request('/csp-report', {
      method: 'POST',
      headers: { 'content-type': 'application/reports+json' },
      body: JSON.stringify([report('https://a.test/'), { type: 'deprecation', body: {} }, report('https://b.test/')]),
    });

    expect(response.status).toBe(204);
    expect(lines().map((line) => [line.directive, line.blockedUri, line.disposition])).toEqual([
      ['connect-src', 'https://a.test/', 'enforce'],
      ['connect-src', 'https://b.test/', 'enforce'],
    ]);
  });

  it('truncates long fields so a report cannot flood the log', async () => {
    const lines = logged();
    await stack.app.request('/csp-report', {
      method: 'POST',
      body: JSON.stringify({ 'csp-report': { 'blocked-uri': `https://a.test/${'x'.repeat(5000)}`, 'effective-directive': 'y'.repeat(5000) } }),
    });

    const [line] = lines();
    expect(line.blockedUri).toHaveLength(500);
    expect(line.directive).toHaveLength(500);
  });

  it('logs no query, fragment or script sample, which can carry signed URLs or chat content', async () => {
    const lines = logged();
    await stack.app.request('/csp-report', {
      method: 'POST',
      body: JSON.stringify({ 'csp-report': {
        'document-uri': 'https://example.com/chat?session=s1#m2',
        'blocked-uri': 'https://files.test/a.pdf?X-Amz-Signature=secret',
        'source-file': 'https://example.com/_next/app.js?v=1',
        'script-sample': 'the user wrote this',
      } }),
    });

    expect(lines()).toEqual([expect.objectContaining({
      documentUri: 'https://example.com/chat',
      blockedUri: 'https://files.test/a.pdf',
      sourceFile: 'https://example.com/_next/app.js',
    })]);
    expect(JSON.stringify(lines())).not.toMatch(/secret|the user wrote this|session=s1/);
  });

  it('refuses a body over 64 KiB and logs nothing', async () => {
    const lines = logged();
    const response = await stack.app.request('/csp-report', {
      method: 'POST',
      body: JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(70_000) } }),
    });

    expect(response.status).toBe(413);
    expect(lines()).toEqual([]);
  });

  it('refuses a body that is not a report and logs nothing', async () => {
    const lines = logged();
    const responses = await Promise.all(['not json', '{"other":1}', '42'].map((body) =>
      stack.app.request('/csp-report', { method: 'POST', body })));

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(lines()).toEqual([]);
  });
});
