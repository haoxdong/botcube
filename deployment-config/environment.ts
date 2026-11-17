import type { DeploymentConfig } from './schema.js';

/** Reached directly whatever the proxy: loopback (a task's sidecars) and the EC2 and ECS metadata endpoints (its credentials). */
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1', '169.254.169.254', '169.254.170.2'];

/**
 * The standard proxy variables every BotCube process gets from the Deployment Config's `proxy`, or none without one.
 * Python's HTTP clients read them as they are; Node's `fetch` and default agents read them under `NODE_USE_ENV_PROXY`.
 */
export function proxyEnvironment({ proxy }: Pick<DeploymentConfig, 'proxy'>): Record<string, string> {
  if (!proxy) return {};
  const noProxy = [...new Set([...ALWAYS_DIRECT, ...(proxy.noProxy ?? [])])].join(',');
  return { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: noProxy, NODE_USE_ENV_PROXY: '1' };
}
