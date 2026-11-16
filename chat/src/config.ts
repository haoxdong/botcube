/** The DynamoDB table every Chat Service record lives in: BOTCUBE_CHAT_TABLE, or `chat`, the local stack's. */
export const chatTable = (env: NodeJS.ProcessEnv): string => env.BOTCUBE_CHAT_TABLE || 'chat';
