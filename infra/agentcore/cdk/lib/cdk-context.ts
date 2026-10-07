import { readFileSync } from 'fs';

export function readCdkContext(configPath: string): Record<string, unknown> {
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    context?: Record<string, unknown>;
  };
  return config.context ?? {};
}
