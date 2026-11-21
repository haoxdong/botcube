import type { DeploymentConfig } from 'botcube-deployment-config';
import { secretArns } from 'botcube-deployment-config/credential-fields';

/** The Harness's OTLP credential provider, an `opentelemetry_otlp_credential_provider` entry point (botcube/harness). */
const HARNESS_CREDENTIAL_PROVIDER = 'botcube';

export interface TelemetryDeployment {
  /** Set on the Chat Service beside its own variables; empty under `xray`, which its collector sidecar exports. */
  readonly chatService: Readonly<Record<string, string>>;
  /** Set on the Harness's Runtime. */
  readonly harness: Readonly<Record<string, string>>;
  /** The Secrets Manager secrets the credential is read from, which each service is granted. */
  readonly secretArns: readonly string[];
}

/**
 * How the `telemetry` section is deployed: under `otlp` both services export straight to the Endpoint with
 * OpenTelemetry's standard variables, the credential read from the Deployment Config; under `none` neither exports.
 */
export function telemetryDeployment(telemetry: DeploymentConfig['telemetry']): TelemetryDeployment {
  if (telemetry.kind === 'xray') return { chatService: {}, harness: {}, secretArns: [] };
  if (telemetry.kind === 'none') {
    return { chatService: {}, harness: { OTEL_SDK_DISABLED: 'true', OTEL_TRACES_EXPORTER: 'none', AGENT_OBSERVABILITY_ENABLED: 'false' }, secretArns: [] };
  }
  const { url, credential, headers, tls } = telemetry;
  const shared = {
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: url,
    ...(headers ? { OTEL_EXPORTER_OTLP_TRACES_HEADERS: Object.entries(headers).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join(',') } : {}),
  };
  return {
    chatService: shared,
    harness: { ...shared, ...(credential || tls ? { OTEL_PYTHON_EXPORTER_OTLP_HTTP_TRACES_CREDENTIAL_PROVIDER: HARNESS_CREDENTIAL_PROVIDER } : {}) },
    secretArns: credential ? secretArns(credential) : [],
  };
}
