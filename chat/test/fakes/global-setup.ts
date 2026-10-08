import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { BIND_ADDRESS, startOnFreePort } from './process.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dynamodbEndpoint: string;
  }
}

export default async function setup(project: TestProject) {
  const python = fileURLToPath(new URL('../../../template/.venv/bin/python', import.meta.url));
  const launcher = fileURLToPath(new URL('./moto_server.py', import.meta.url));
  const moto = await startOnFreePort((port) => ({
    command: `"${python}" "${launcher}" -H ${BIND_ADDRESS} -p ${port}`,
    env: {
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: 'moto',
      AWS_SECRET_ACCESS_KEY: 'moto',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    },
    url: `http://127.0.0.1:${port}/moto-api/`,
    listening: `Running on http://127.0.0.1:${port}`,
  }));
  project.provide('dynamodbEndpoint', new URL(moto.url).origin);
  return () => moto.stop();
}
