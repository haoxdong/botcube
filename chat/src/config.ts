export function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** The DynamoDB table every Chat Service record lives in: BOTCUBE_CHAT_TABLE, or `chat`, the local stack's. */
export const chatTable = (env: NodeJS.ProcessEnv): string => env.BOTCUBE_CHAT_TABLE || 'chat';
