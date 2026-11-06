import { inject } from 'vitest';
import type {} from './moto-servers.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from './credentials.js';

/** This worker's own moto, where each test file creates its own tables, queues and schedule groups. */
export function motoEndpoint(): string {
  const endpoints = inject('motoEndpoints');
  const pool = process.env.VITEST_POOL_ID;
  const endpoint = endpoints[Number(pool) - 1];
  if (endpoint === undefined) {
    throw new Error(`Vitest worker ${pool} has no moto: the global setup started ${endpoints.length}, for workers 1 to ${endpoints.length}`);
  }
  return endpoint;
}

/** An AWS SDK client's configuration for this worker's moto. */
export const motoAws = () => ({
  region: 'us-east-1',
  endpoint: motoEndpoint(),
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});
