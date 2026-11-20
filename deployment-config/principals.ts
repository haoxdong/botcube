/** The roles BotCube's processes run as. A role the deploy machinery alone uses (custom resources, image builds, ops) is not one. */
export const PRINCIPALS = {
  chatService: 'Chat Service task',
  credentialService: 'Credential Service task',
  scheduledRuns: 'EventBridge Scheduler, sending scheduled runs to their queue',
  agentComputerBrowser: 'Agent Computer browser',
  filesMount: "a Turn's Files mount",
  harness: 'Harness (AgentCore Runtime)',
  sessionApi: 'session API function',
  auditCopy: "Credential Service's audit-copy function",
  userMemory: "a Turn's own Memory credentials",
} as const;

export type Principal = keyof typeof PRINCIPALS;
