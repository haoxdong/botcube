import { request as httpRequest } from 'node:http';
import { HttpFake } from './http-fake.js';

/** An OTLP/HTTP traces collector: records each export and accepts it, carrying `authorization` when one is given. */
export class FakeOtlpCollector extends HttpFake {
  constructor(authorization?: string) {
    super(({ headers }, response) => {
      if (authorization !== undefined && headers.authorization !== authorization) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-protobuf' });
      response.end();
    });
  }

  /** Whether any export carried `text`, such as a span or service name: OTLP protobuf keeps strings as UTF-8. */
  received(text: string): boolean {
    return this.requests.some(({ path, bodyBytes }) => path.endsWith('/v1/traces') && bodyBytes.includes(Buffer.from(text)));
  }
}

/**
 * A corporate forward proxy: it takes absolute-form HTTP requests (`POST http://host:port/path`), records
 * each `host:port`, and sends a request on to the stand-in for that host; any other host gets 502. Given
 * `proxyAuthorization`, it answers 407 to a request without it.
 */
export class FakeForwardProxy extends HttpFake {
  constructor(upstreams: Readonly<Record<string, string>>, proxyAuthorization?: string) {
    super(async ({ method, path, headers: { 'proxy-authorization': authorization, ...headers }, bodyBytes }, response) => {
      if (proxyAuthorization !== undefined && authorization !== proxyAuthorization) {
        response.writeHead(407, { 'proxy-authenticate': 'Bearer' }).end();
        return;
      }
      const target = URL.canParse(path) ? new URL(path) : undefined;
      const upstream = target && upstreams[target.host];
      if (!target || !upstream) {
        response.writeHead(502).end(`no route to ${path}`);
        return;
      }
      const forwarded = new URL(target.pathname + target.search, upstream);
      await new Promise<void>((resolve, reject) => {
        const outgoing = httpRequest(forwarded, { method, headers: { ...headers, host: forwarded.host } }, (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response).on('finish', resolve).on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end(bodyBytes);
      });
    });
  }

  /** The `host:port` of each request the proxy carried. */
  hosts(): string[] {
    return this.requests.flatMap(({ path }) => (URL.canParse(path) ? [new URL(path).host] : []));
  }
}
