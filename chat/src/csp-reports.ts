import type { Hono } from 'hono';
import { HttpError } from './cartridge.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELD = 500;

/**
 * The web UI's Content Security Policy violation reports. Browsers send them unauthenticated and
 * `no-cors`, as one `report-uri` object or a Reporting API batch; each becomes one `csp-violation` log line, so they
 * are read with `aws logs filter-log-events --filter-pattern csp-violation` on the Chat Service log group.
 */
export function cspReportRoutes(app: Hono) {
  app.post('/csp-report', async (c) => {
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, 'The report is too large');
    const reports = violations(parse(text));
    if (reports === null) throw new HttpError(400, 'The body is not a CSP violation report');
    const userAgent = clip(c.req.header('user-agent'));
    for (const report of reports) console.log('csp-violation', JSON.stringify({ ...report, userAgent }));
    return c.body(null, 204);
  });
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type Violation = Record<'documentUri' | 'directive' | 'blockedUri' | 'sourceFile' | 'disposition', string | undefined>
  & Record<'line' | 'column', number | undefined>;

function violations(body: unknown): Violation[] | null {
  if (Array.isArray(body)) {
    return body.filter((report) => record(report)?.type === 'csp-violation').map((report) => {
      const b = record(record(report)?.body) ?? {};
      return violation(b.documentURL, b.effectiveDirective, b.blockedURL, b.sourceFile, b.lineNumber, b.columnNumber, b.disposition);
    });
  }
  const r = record(record(body)?.['csp-report']);
  if (r === undefined) return null;
  return [violation(r['document-uri'], r['effective-directive'] ?? r['violated-directive'], r['blocked-uri'], r['source-file'],
    r['line-number'], r['column-number'], r.disposition)];
}

// The script sample and every URL's query and fragment are left out: they can hold chat content or signed URLs.
function violation(documentUri: unknown, directive: unknown, blockedUri: unknown, sourceFile: unknown, line: unknown,
  column: unknown, disposition: unknown): Violation {
  return {
    documentUri: address(documentUri), directive: clip(directive), blockedUri: address(blockedUri), sourceFile: address(sourceFile),
    line: integer(line), column: integer(column), disposition: clip(disposition),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, MAX_FIELD) : undefined);
const address = (value: unknown) => clip(typeof value === 'string' ? value.split(/[?#]/, 1)[0] : undefined);
const integer = (value: unknown) => (Number.isInteger(value) ? value as number : undefined);
