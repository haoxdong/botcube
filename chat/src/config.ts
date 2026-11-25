/** The DynamoDB table every Chat Service record lives in: BOTCUBE_CHAT_TABLE, or `chat`, the local stack's. */
export const chatTable = (env: NodeJS.ProcessEnv): string => env.BOTCUBE_CHAT_TABLE || 'chat';

/** The BotCube web UI's local development server (`pnpm dev:bot`). */
export const LOCAL_UI_ORIGINS = ['http://localhost:3001', 'http://127.0.0.1:3001'];

/** The web UI's origins: the BotCube Config's `domains.web` and its aliases, else the local web UI's. */
export function allowedOrigins(origins: readonly string[]): string[] {
  return origins.length ? [...origins] : LOCAL_UI_ORIGINS;
}
