import type { TurnActivity } from './session-metadata.js';

const firstLine = (text: string) => text.trim().replace(/\n[\s\S]*/, '');

export function turnActivity(request: string, failed?: string): TurnActivity {
  return {
    request: firstLine(request),
    completedAt: new Date().toISOString(),
    ...(failed === undefined ? {} : { failed: firstLine(failed) }),
  };
}
