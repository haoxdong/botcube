import { describe, expect, it } from 'vitest';
import { telemetryEnvironment } from './telemetry.js';

describe('TLS on the OTLP Endpoint', () => {
  const url = 'https://collector.example.com/v1/traces';
  const tls = { clientCertificate: { command: ['/usr/local/bin/svid-broker'], timeoutSeconds: 30 }, serverIdentity: 'spiffe://example.org/ns/telemetry/sa/collector' } as const;

  it("without a credential loads the Harness's provider, which presents the certificate, and sets nothing else", () => {
    const without = telemetryEnvironment({ kind: 'otlp', url });
    const deployed = telemetryEnvironment({ kind: 'otlp', url, tls });

    expect(deployed).toEqual({ ...without, harness: { ...without.harness, OTEL_PYTHON_EXPORTER_OTLP_HTTP_TRACES_CREDENTIAL_PROVIDER: 'botcube' } });
  });
});
