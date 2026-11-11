/** The DynamoDB table every Chat Service record lives in: BOTCUBE_CHAT_TABLE, or `chat`, the local stack's. */
export const chatTable = (env: NodeJS.ProcessEnv): string => env.BOTCUBE_CHAT_TABLE || 'chat';

/** The Artifacts flag, BOTCUBE_ARTIFACTS=1, off by default: the Chat Service saves a User's edit of an Artifact. */
export const artifactsEnabled = (env: NodeJS.ProcessEnv): boolean => env.BOTCUBE_ARTIFACTS === '1';
