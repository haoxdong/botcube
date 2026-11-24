const sessionPurgeFailed = 'Session purge failed';

exports.chatAlarmEvents = Object.freeze({
  sessionPurgeFailed,
  accountPurgeFailed: `${sessionPurgeFailed}; account history deletion remains pending`,
  accountDeletionFailed: 'Account deletion failed; it remains pending',
  accountDeletionPending: 'Account deletion pending',
  accountEraseProgress: 'Account history erase purged',
  accountDeletionCompleted: 'Account deletion completed',
  agentComputerStopSleepFailed: 'Agent Computer sleep at task stop failed',
  runErrorCodeField: 'code=',
});
