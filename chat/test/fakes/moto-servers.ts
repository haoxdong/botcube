import type { TestProject } from 'vitest/node';
import { BIND_ADDRESS, startOnFreePort } from './process.js';

declare module 'vitest' {
  export interface ProvidedContext {
    motoEndpoints: string[];
  }
}

/**
 * Start one moto per Vitest worker, from `python` running `launcher`, and provide their endpoints. moto answers
 * DynamoDB one request at a time in one Python process, so a single moto shared by every worker made each request
 * wait behind the other workers' and a run's wall-clock latency grow with the suite's parallelism.
 */
export async function startMotos(project: TestProject, python: string, launcher: string): Promise<() => Promise<void>> {
  const motos = await Promise.all(Array.from({ length: workerCount(project) }, () => startOnFreePort((port) => ({
    command: `"${python}" "${launcher}" -H ${BIND_ADDRESS} -p ${port}`,
    // moto's REST services (Scheduler) build a boto3 client, which resolves credentials: give it
    // dummy ones so it never reads the developer's AWS config.
    env: {
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: 'moto',
      AWS_SECRET_ACCESS_KEY: 'moto',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    },
    url: `http://127.0.0.1:${port}/moto-api/`,
    listening: `Running on http://127.0.0.1:${port}`,
  }))));
  project.provide('motoEndpoints', motos.map((moto) => new URL(moto.url).origin));
  return async () => {
    await Promise.all(motos.map((moto) => moto.stop()));
  };
}

/** The workers the run can hold at once: Stryker's Vitest runner runs a project in the threads pool with `maxThreads: 1`. */
function workerCount({ globalConfig: { maxWorkers, pool, poolOptions } }: TestProject): number {
  const [single, max] = pool === 'threads'
    ? [poolOptions?.threads?.singleThread, poolOptions?.threads?.maxThreads]
    : [poolOptions?.forks?.singleFork, poolOptions?.forks?.maxForks];
  if (single === true) return 1;
  if (max === undefined) return maxWorkers;
  if (typeof max !== 'number') throw new Error(`moto needs a number of ${pool} workers, not ${max}`);
  return Math.min(maxWorkers, max);
}
