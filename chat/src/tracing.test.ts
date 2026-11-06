import { defined } from '../test/defined.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';

it('exports real OTLP HTTP protobuf with the fixed Chat service name on shutdown', async () => {
  const bodies: Buffer[] = [];
  const contentTypes: (string | undefined)[] = [];
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks));
      contentTypes.push(request.headers['content-type']);
      response.end();
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startChatTracing } from './src/tracing.ts';
    import { registerTracingTurn } from './src/tracing.ts';
    const sdk = startChatTracing();
    const { trace } = await import('@opentelemetry/api');
    const finish = registerTracingTurn();
    trace.getTracer('test').startSpan('startup export probe').end();
    let ended = false;
    const stopping = sdk.shutdown().then(() => { ended = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    if (ended) throw new Error('shutdown skipped a draining Turn');
    finish();
    await stopping;
  `], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, OTEL_TRACES_EXPORTER: 'otlp', OTEL_SERVICE_NAME: 'must-not-override-chat',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${(collector.address() as AddressInfo).port}/v1/traces`,
      OTEL_BSP_SCHEDULE_DELAY: '60000', OTEL_RESOURCE_ATTRIBUTES: '', OTEL_NODE_RESOURCE_DETECTORS: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [code, signal] = await once(child, 'close');
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: '' });
    expect(bodies).toHaveLength(1);
    expect(contentTypes).toEqual(['application/x-protobuf']);
    expect(defined(bodies[0], 'exported protobuf body').includes(Buffer.from('botcube-chat'))).toBe(true);
    expect(defined(bodies[0], 'exported protobuf body').includes(Buffer.from('startup export probe'))).toBe(true);
    expect(defined(bodies[0], 'exported protobuf body').includes(Buffer.from('must-not-override-chat'))).toBe(false);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
});
