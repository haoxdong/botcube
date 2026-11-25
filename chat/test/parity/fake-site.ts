import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOnFreePort } from '../fakes/process.js';
import { CREDENTIAL_SERVICE_BIN, FIXTURES, HARNESS_BIN } from './local-stack.js';

const standIns = fileURLToPath(new URL('../../../infra/local/stand-ins', import.meta.url));

export function startFakeSite() {
  return startOnFreePort((port) => ({
    command: `${HARNESS_BIN}/python ${join(standIns, 'fake_site.py')}`,
    env: { PORT: String(port), FAKE_SITE_HOST: '127.0.0.1' },
    url: `http://127.0.0.1:${port}/login`,
    listening: `Fake site listening on :${port}`,
  }));
}

export function startFakeSiteCredentials(siteUrl: string) {
  return startOnFreePort((port) => ({
    command: `${CREDENTIAL_SERVICE_BIN}/python ${join(FIXTURES, 'fake-site-credential-service.py')}`,
    env: {
      PORT: String(port),
      PYTHONPATH: standIns,
      FAKE_SITE_URL: siteUrl,
      BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'local-secret',
      AWS_ACCESS_KEY_ID: 'testing',
      AWS_SECRET_ACCESS_KEY: 'testing',
      AWS_DEFAULT_REGION: 'us-east-1',
    },
    url: `http://127.0.0.1:${port}/health`,
    listening: `Uvicorn running on http://127.0.0.1:${port}`,
  }));
}
